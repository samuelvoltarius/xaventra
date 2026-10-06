/**
 * Main succession (2.88): the Main state as a replicated, epoch-fenced journal.
 *
 * Every change to the Main state (memory, connections, responsibilities,
 * cards, configuration) is one journal entry. Entries are AES-256-GCM
 * encrypted, HMAC-authenticated and hash-chained. The acting Main appends an
 * entry locally and replicates it to every other main-eligible node; it is
 * committed once a majority (including the Main itself) stored it.
 *
 * Fencing: each replica persists the highest Main epoch it has seen (its
 * high-water mark). A new term starts with a `term` entry carrying the new
 * epoch; from then on every replica rejects entries of an older epoch. An old
 * Main that is still running after an epoch change can therefore no longer
 * write: the first rejection fences its writer for good.
 *
 * Restore: a new Main collects the replica logs of a majority, takes the most
 * up-to-date valid log (highest last epoch, then longest) — which contains
 * every committed entry — and replays it. Fewer than a majority: fail closed.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

export const MAIN_STATE_DOMAINS = ['memory', 'connections', 'responsibilities', 'cards', 'config'] as const
export type MainStateDomain = typeof MAIN_STATE_DOMAINS[number]
export type MainState = Record<MainStateDomain, Record<string, unknown>>

export interface StateChange {
    domain: MainStateDomain
    key: string
    /** null deletes the key. */
    value: unknown | null
}

export type JournalEntryKind = 'term' | 'change' | 'snapshot'

export interface JournalEntry {
    v: 1
    seq: number
    epoch: number
    nodeId: string
    kind: JournalEntryKind
    /** Written by an owner-confirmed emergency Main (no majority at the time). */
    emergency?: boolean
    prevHash: string
    iv: string
    tag: string
    data: string
    mac: string
}

export type JournalRejectReason = 'stale-epoch' | 'gap' | 'conflict' | 'invalid' | 'no-term'

export interface JournalAck {
    nodeId: string
    ok: boolean
    /** Set when ok is false. */
    reason?: JournalRejectReason
    lastSeq: number
    highWater: number
}

export interface JournalMessage {
    entries: JournalEntry[]
    /** Full log replacement (catch-up after a gap or a discarded old-term tail). */
    replace?: boolean
}

export interface ReplicaExport {
    nodeId: string
    highWater: number
    entries: JournalEntry[]
}

export interface JournalReplicationTarget {
    nodeId: string
    /** null = unreachable. */
    deliver(message: JournalMessage): Promise<JournalAck | null>
}

export class FencedWriterError extends Error {
    readonly code = 'JOURNAL_FENCED'
    constructor(readonly epoch: number, readonly highWater: number, readonly byNode: string) {
        super(`journal writer of epoch ${epoch} is fenced: ${byNode} already saw epoch ${highWater}`)
        this.name = 'FencedWriterError'
    }
}

export class NoQuorumError extends Error {
    readonly code = 'JOURNAL_NO_QUORUM'
    constructor(message: string) {
        super(message)
        this.name = 'NoQuorumError'
    }
}

export function emptyMainState(): MainState {
    return Object.fromEntries(MAIN_STATE_DOMAINS.map(domain => [domain, {}])) as MainState
}

function isDomain(value: unknown): value is MainStateDomain {
    return typeof value === 'string' && (MAIN_STATE_DOMAINS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Keys, sealing, chain
// ---------------------------------------------------------------------------

export interface JournalKeys { enc: Buffer; mac: Buffer }

export function deriveJournalKeys(secret: Buffer | string): JournalKeys {
    const material = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8')
    if (material.length < 32) throw new Error('journal key material must be at least 32 bytes')
    return {
        enc: Buffer.from(hkdfSync('sha256', material, Buffer.from('xaventra-journal'), 'enc', 32)),
        mac: Buffer.from(hkdfSync('sha256', material, Buffer.from('xaventra-journal'), 'mac', 32)),
    }
}

function macInput(entry: Omit<JournalEntry, 'mac'>): string {
    return JSON.stringify([entry.v, entry.seq, entry.epoch, entry.nodeId, entry.kind, entry.emergency === true, entry.prevHash, entry.iv, entry.tag, entry.data])
}

function computeMac(keys: JournalKeys, entry: Omit<JournalEntry, 'mac'>): string {
    return createHmac('sha256', keys.mac).update(macInput(entry)).digest('hex')
}

export function entryHash(entry: JournalEntry): string {
    return createHash('sha256').update(`${entry.seq}|${entry.mac}`).digest('hex')
}

export function verifyEntryMac(keys: JournalKeys, entry: JournalEntry): boolean {
    if (!entry || entry.v !== 1 || !Number.isSafeInteger(entry.seq) || entry.seq < 1 || !Number.isSafeInteger(entry.epoch) || entry.epoch < 1
        || !['term', 'change', 'snapshot'].includes(entry.kind) || typeof entry.mac !== 'string' || !/^[0-9a-f]{64}$/.test(entry.mac)) return false
    const { mac, ...rest } = entry
    const expected = Buffer.from(computeMac(keys, rest), 'hex')
    const actual = Buffer.from(mac, 'hex')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function aad(entry: { seq: number; epoch: number; kind: string; nodeId: string }): Buffer {
    return Buffer.from(`${entry.seq}|${entry.epoch}|${entry.kind}|${entry.nodeId}`)
}

export function sealEntry(keys: JournalKeys, input: {
    seq: number; epoch: number; nodeId: string; kind: JournalEntryKind; prevHash: string; payload: unknown; emergency?: boolean
}): JournalEntry {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', keys.enc, iv)
    cipher.setAAD(aad(input))
    const data = Buffer.concat([cipher.update(JSON.stringify(input.payload), 'utf8'), cipher.final()])
    const unsigned: Omit<JournalEntry, 'mac'> = {
        v: 1, seq: input.seq, epoch: input.epoch, nodeId: input.nodeId, kind: input.kind,
        ...(input.emergency ? { emergency: true } : {}),
        prevHash: input.prevHash, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
    }
    return { ...unsigned, mac: computeMac(keys, unsigned) }
}

export function openEntry<T = unknown>(keys: JournalKeys, entry: JournalEntry): T {
    const decipher = createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(entry.iv, 'base64'))
    decipher.setAAD(aad(entry))
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8')
    return JSON.parse(plain) as T
}

/**
 * Valid chain: MACs, consecutive seq, prevHash links, epochs never fall and
 * each epoch rise starts with a `term` entry. The first entry is seq 1 or a
 * snapshot (compacted log).
 */
export function verifyChain(keys: JournalKeys, entries: JournalEntry[]): { ok: boolean; reason?: string } {
    if (!entries.length) return { ok: true }
    const first = entries[0]
    if (first.seq !== 1 && first.kind !== 'snapshot') return { ok: false, reason: 'log neither starts at 1 nor with a snapshot' }
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        if (!verifyEntryMac(keys, entry)) return { ok: false, reason: `entry ${entry?.seq} fails authentication` }
        if (index === 0) {
            if (entry.seq === 1 && entry.prevHash !== '') return { ok: false, reason: 'first entry has a predecessor' }
            continue
        }
        const previous = entries[index - 1]
        if (entry.seq !== previous.seq + 1) return { ok: false, reason: `seq gap at ${entry.seq}` }
        if (entry.prevHash !== entryHash(previous)) return { ok: false, reason: `broken chain at ${entry.seq}` }
        if (entry.epoch < previous.epoch) return { ok: false, reason: `epoch falls at ${entry.seq}` }
        if (entry.epoch > previous.epoch && entry.kind !== 'term') return { ok: false, reason: `epoch rises without term entry at ${entry.seq}` }
    }
    return { ok: true }
}

export function applyChanges(state: MainState, changes: StateChange[]): MainState {
    for (const change of changes) {
        if (!isDomain(change?.domain) || typeof change.key !== 'string' || !change.key) continue
        if (change.value === null || change.value === undefined) delete state[change.domain][change.key]
        else state[change.domain][change.key] = change.value
    }
    return state
}

export function replayEntries(keys: JournalKeys, entries: JournalEntry[]): MainState {
    let state = emptyMainState()
    for (const entry of entries) {
        if (entry.kind === 'snapshot') {
            const snapshot = openEntry<MainState>(keys, entry)
            state = emptyMainState()
            for (const domain of MAIN_STATE_DOMAINS) Object.assign(state[domain], snapshot?.[domain] || {})
        } else if (entry.kind === 'change') {
            applyChanges(state, openEntry<StateChange[]>(keys, entry))
        }
    }
    return state
}

// ---------------------------------------------------------------------------
// Replica (every main-eligible node, including the Main itself)
// ---------------------------------------------------------------------------

interface ReplicaFile { highWater: number; entries: JournalEntry[] }

export class JournalReplica {
    private entries: JournalEntry[] = []
    private highWaterValue = 0

    constructor(readonly nodeId: string, private readonly keys: JournalKeys, private readonly file?: string) {
        if (!file || !existsSync(file)) return
        let parsed: ReplicaFile
        try {
            parsed = JSON.parse(readFileSync(file, 'utf8')) as ReplicaFile
        } catch (error) {
            // Fail closed: silently starting empty would forget the high-water
            // mark and accept a stale Main again.
            throw new Error(`journal replica ${file} is unreadable; refusing to start (restore it from backup): ${String(error).slice(0, 160)}`)
        }
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
        const chain = verifyChain(keys, entries)
        if (!chain.ok) throw new Error(`journal replica ${file} is corrupt (${chain.reason}); refusing to start`)
        this.entries = entries
        this.highWaterValue = Math.max(Number(parsed?.highWater) || 0, ...entries.map(entry => entry.epoch), 0)
    }

    highWater(): number { return this.highWaterValue }
    lastSeq(): number { return this.entries.length ? this.entries[this.entries.length - 1].seq : 0 }
    lastHash(): string { return this.entries.length ? entryHash(this.entries[this.entries.length - 1]) : '' }
    lastEpoch(): number { return this.entries.length ? this.entries[this.entries.length - 1].epoch : 0 }
    log(): JournalEntry[] { return this.entries.map(entry => ({ ...entry })) }

    export(): ReplicaExport {
        return { nodeId: this.nodeId, highWater: this.highWaterValue, entries: this.log() }
    }

    /**
     * New Main only: take over the restored (most up-to-date) log before
     * writing the next term. Keeps the high-water mark (it never falls).
     */
    adoptRestoredLog(entries: JournalEntry[]): void {
        const chain = verifyChain(this.keys, entries)
        if (!chain.ok) throw new Error(`restored log is invalid (${chain.reason})`)
        this.entries = entries.map(entry => ({ ...entry }))
        this.highWaterValue = Math.max(this.highWaterValue, ...entries.map(entry => entry.epoch), 0)
        this.persist()
    }

    /** Raise the fence without an entry (e.g. on observing a newer term elsewhere). */
    observeEpoch(epoch: number): void {
        if (Number.isSafeInteger(epoch) && epoch > this.highWaterValue) {
            this.highWaterValue = epoch
            this.persist()
        }
    }

    private persist(): void {
        if (this.file) atomicWriteJsonSync(this.file, { highWater: this.highWaterValue, entries: this.entries } satisfies ReplicaFile)
    }

    private nack(reason: JournalRejectReason): JournalAck {
        return { nodeId: this.nodeId, ok: false, reason, lastSeq: this.lastSeq(), highWater: this.highWaterValue }
    }

    private ack(): JournalAck {
        return { nodeId: this.nodeId, ok: true, lastSeq: this.lastSeq(), highWater: this.highWaterValue }
    }

    append(message: JournalMessage): JournalAck {
        const entries = Array.isArray(message?.entries) ? message.entries : []
        if (!entries.length) return this.nack('invalid')
        if (entries.some(entry => !verifyEntryMac(this.keys, entry))) return this.nack('invalid')
        const maxEpoch = Math.max(...entries.map(entry => entry.epoch))
        if (maxEpoch < this.highWaterValue) return this.nack('stale-epoch')

        if (message.replace) {
            const chain = verifyChain(this.keys, entries)
            if (!chain.ok) return this.nack('invalid')
            // A replacement must come from the writer of its newest term.
            const termStart = entries.find(entry => entry.kind === 'term' && entry.epoch === maxEpoch)
            if (!termStart) return this.nack('no-term')
            // Same term: the replacement must contain every entry of that term
            // this replica already holds (it may only extend, never rewrite).
            if (maxEpoch === this.highWaterValue) {
                const theirs = new Map(entries.map(entry => [entry.seq, entry.mac]))
                const lowest = entries[0].seq
                if (this.entries.some(entry => entry.epoch === maxEpoch && entry.seq >= lowest && theirs.get(entry.seq) !== entry.mac)) return this.nack('conflict')
            }
            this.entries = entries.map(entry => ({ ...entry }))
            this.highWaterValue = Math.max(this.highWaterValue, maxEpoch)
            this.persist()
            return this.ack()
        }

        let changed = false
        for (const entry of entries) {
            if (entry.epoch < this.highWaterValue) {
                if (changed) this.persist()
                return this.nack('stale-epoch')
            }
            const existing = this.entries.find(item => item.seq === entry.seq)
            if (existing) {
                if (existing.mac === entry.mac) continue // retransmission
                if (changed) this.persist()
                return this.nack('conflict')
            }
            if (entry.seq !== this.lastSeq() + 1 || entry.prevHash !== this.lastHash()) {
                if (changed) this.persist()
                return this.nack('gap')
            }
            if (entry.epoch > this.lastEpoch() && entry.kind !== 'term') {
                if (changed) this.persist()
                return this.nack('no-term')
            }
            this.entries.push({ ...entry })
            if (entry.epoch > this.highWaterValue) this.highWaterValue = entry.epoch
            changed = true
        }
        if (changed) this.persist()
        return this.ack()
    }

    /** Drop everything before the newest snapshot at or below `committedSeq`. */
    compact(committedSeq: number): number {
        let index = -1
        for (let i = this.entries.length - 1; i >= 0; i--) {
            if (this.entries[i].kind === 'snapshot' && this.entries[i].seq <= committedSeq) { index = i; break }
        }
        if (index <= 0) return 0
        this.entries = this.entries.slice(index)
        this.persist()
        return index
    }
}

// ---------------------------------------------------------------------------
// Restore (new Main)
// ---------------------------------------------------------------------------

export interface RestoreResult {
    state: MainState
    entries: JournalEntry[]
    lastSeq: number
    /** Highest epoch any replica has seen; the next term must be above it. */
    maxEpoch: number
    source: string | null
    replicas: number
}

/**
 * Most up-to-date valid log among the given replica exports. With
 * `requireQuorum`, fewer than `quorum` readable replicas fail closed: the
 * committed state cannot be proven complete.
 */
export function restoreMainState(keys: JournalKeys, exports: ReplicaExport[], options: { quorum: number; requireQuorum?: boolean }): RestoreResult {
    const valid = exports.filter(item => item && Array.isArray(item.entries) && verifyChain(keys, item.entries).ok)
    if ((options.requireQuorum ?? true) && valid.length < options.quorum) {
        throw new NoQuorumError(`restore needs ${options.quorum} readable replicas, got ${valid.length}`)
    }
    const maxEpoch = Math.max(0, ...exports.map(item => Number(item?.highWater) || 0), ...valid.flatMap(item => item.entries.map(entry => entry.epoch)))
    const best = [...valid].sort((a, b) => {
        const lastA = a.entries[a.entries.length - 1]
        const lastB = b.entries[b.entries.length - 1]
        return (lastB?.epoch || 0) - (lastA?.epoch || 0) || (lastB?.seq || 0) - (lastA?.seq || 0) || a.nodeId.localeCompare(b.nodeId)
    })[0]
    const entries = best ? best.entries.map(entry => ({ ...entry })) : []
    return {
        state: replayEntries(keys, entries),
        entries,
        lastSeq: entries.length ? entries[entries.length - 1].seq : 0,
        maxEpoch,
        source: best?.nodeId || null,
        replicas: valid.length,
    }
}

// ---------------------------------------------------------------------------
// Writer (acting Main only)
// ---------------------------------------------------------------------------

export interface CommitResult { seq: number; committed: boolean; acks: string[] }

export class StateJournalWriter {
    private fenced: FencedWriterError | null = null
    private current: MainState
    private sinceSnapshot = 0

    constructor(private readonly options: {
        nodeId: string
        epoch: number
        keys: JournalKeys
        local: JournalReplica
        targets: () => JournalReplicationTarget[]
        /** Copies needed to commit, counting the local one. */
        quorum: number
        emergency?: boolean
        /** Restored state (replayed from the chosen log). */
        state?: MainState
        /** Auto-snapshot after this many entries (keeps logs small). */
        snapshotEvery?: number
        onFenced?: (error: FencedWriterError) => void
    }) {
        this.current = options.state ? structuredClone(options.state) : emptyMainState()
    }

    epoch(): number { return this.options.epoch }
    isFenced(): boolean { return this.fenced !== null }
    state(): MainState { return structuredClone(this.current) }

    private fence(error: FencedWriterError): never {
        if (!this.fenced) {
            this.fenced = error
            try { this.options.onFenced?.(error) } catch { /* observer only */ }
        }
        throw error
    }

    private async replicate(seq: number): Promise<CommitResult> {
        const acks = [this.options.nodeId]
        const results = await Promise.all(this.options.targets().filter(target => target.nodeId !== this.options.nodeId).map(async target => {
            try {
                let ack = await target.deliver({ entries: this.options.local.log().filter(entry => entry.seq === seq) })
                if (ack && !ack.ok && (ack.reason === 'gap' || ack.reason === 'conflict' || ack.reason === 'no-term')) {
                    ack = await target.deliver({ entries: this.options.local.log(), replace: true })
                }
                return ack
            } catch { return null }
        }))
        for (const ack of results) {
            if (!ack) continue
            if (!ack.ok && ack.reason === 'stale-epoch' && ack.highWater > this.options.epoch) {
                this.fence(new FencedWriterError(this.options.epoch, ack.highWater, ack.nodeId))
            }
            if (ack.ok && ack.lastSeq >= seq) acks.push(ack.nodeId)
        }
        return { seq, committed: acks.length >= this.options.quorum, acks }
    }

    private append(kind: JournalEntryKind, payload: unknown): number {
        if (this.fenced) throw this.fenced
        if (this.options.local.highWater() > this.options.epoch) {
            this.fence(new FencedWriterError(this.options.epoch, this.options.local.highWater(), this.options.nodeId))
        }
        const entry = sealEntry(this.options.keys, {
            seq: this.options.local.lastSeq() + 1, epoch: this.options.epoch, nodeId: this.options.nodeId, kind,
            prevHash: this.options.local.lastHash(), payload, emergency: this.options.emergency,
        })
        const ack = this.options.local.append({ entries: [entry] })
        if (!ack.ok) {
            if (ack.reason === 'stale-epoch') this.fence(new FencedWriterError(this.options.epoch, ack.highWater, this.options.nodeId))
            throw new Error(`local journal refused entry ${entry.seq} (${ack.reason})`)
        }
        return entry.seq
    }

    /** First entry of the term. Without a majority (and not emergency) the term does not start. */
    async start(): Promise<CommitResult> {
        const seq = this.append('term', { epoch: this.options.epoch, nodeId: this.options.nodeId, emergency: this.options.emergency === true })
        const result = await this.replicate(seq)
        if (!result.committed && !this.options.emergency) {
            throw new NoQuorumError(`term ${this.options.epoch} reached ${result.acks.length}/${this.options.quorum} replicas`)
        }
        return result
    }

    async record(changes: StateChange | StateChange[]): Promise<CommitResult> {
        const list = (Array.isArray(changes) ? changes : [changes]).filter(change => isDomain(change?.domain) && typeof change.key === 'string' && change.key)
        if (!list.length) throw new Error('no valid state change')
        const seq = this.append('change', list)
        applyChanges(this.current, structuredClone(list))
        const result = await this.replicate(seq)
        this.sinceSnapshot++
        if (result.committed && this.sinceSnapshot >= (this.options.snapshotEvery ?? 200)) await this.snapshot().catch(() => undefined)
        return result
    }

    async snapshot(): Promise<CommitResult> {
        const seq = this.append('snapshot', this.current)
        const result = await this.replicate(seq)
        if (result.committed) {
            this.sinceSnapshot = 0
            this.options.local.compact(seq)
        }
        return result
    }
}
