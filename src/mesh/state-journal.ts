/**
 * 2.86 package K — Main state journal.
 *
 * Every change of the Main state (missions, cards, planner, thoughts,
 * responsibilities, decisions, procedures, memory governance, tools) becomes
 * one journal entry that is
 *   - encrypted (AES-256-GCM, key derived from the shared mesh journal secret;
 *     replicas such as the NAS store ciphertext only and never decrypt),
 *   - hash-chained (prevHash) and signed with the author's Ed25519 identity,
 *   - fenced by the lease epoch: a replica that saw epoch E rejects every
 *     entry of an older epoch, so a returning stale Main cannot write,
 *   - committed only after at least two OTHER nodes acknowledged it.
 * Snapshots (with a plaintext checksum) shorten the replay; a successor
 * restores snapshot + tail and refuses to take over (fail closed) when the
 * reachable replicas do not cover the last confirmed entry.
 */

import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import type { MeshIdentity } from './mesh-identity.js'

export const MAIN_STATE_DOMAINS = [
    'missions', 'cards', 'planner', 'thoughts', 'responsibilities', 'decisions', 'procedures', 'memoryGovernance', 'tools',
] as const
export type MainStateDomain = typeof MAIN_STATE_DOMAINS[number]
/** Internal bookkeeping of the succession itself (hand-overs, reconciled branches). */
export const SUCCESSION_META_DOMAIN = '_succession'
export type JournalDomain = MainStateDomain | typeof SUCCESSION_META_DOMAIN
export type MainState = Record<string, Record<string, unknown>>

export interface StateChange {
    domain: JournalDomain
    key: string
    op: 'put' | 'delete'
    value?: unknown
}

export interface JournalSigner {
    readonly nodeId: string
    readonly publicKey: string
    sign(data: Buffer): string
}

/** nodeId → Ed25519 public key (PEM) of every node allowed to author entries. */
export type TrustedKeys = Record<string, string>

export interface SealedBox { iv: string; tag: string; data: string }

export interface JournalEntry {
    v: 1
    kind: 'entry'
    seq: number
    epoch: number
    author: string
    prevHash: string
    createdAt: number
    /** Highest seq the author knew as confirmed when writing this entry. */
    commitSeq: number
    /** Set only for an owner-approved emergency branch (kept apart from the main chain). */
    branch?: string
    sealed: SealedBox
    hash: string
    signature: string
}

export interface JournalSnapshot {
    v: 1
    kind: 'snapshot'
    upToSeq: number
    lastHash: string
    epoch: number
    author: string
    createdAt: number
    /** sha256 of the stable plaintext state; verified after decryption. */
    checksum: string
    sealed: SealedBox
    hash: string
    signature: string
}

export interface JournalPromotion {
    v: 1
    kind: 'promote'
    epoch: number
    author: string
    createdAt: number
    hash: string
    signature: string
}

export type JournalMessage =
    | { type: 'promote'; promotion: JournalPromotion }
    | { type: 'entry'; entry: JournalEntry }
    | { type: 'branch'; entry: JournalEntry }
    | { type: 'snapshot'; snapshot: JournalSnapshot }
    | { type: 'sync'; snapshot: JournalSnapshot | null; entries: JournalEntry[]; promotion?: JournalPromotion }

export type JournalRejection = 'fenced' | 'gap' | 'fork' | 'bad-signature' | 'untrusted' | 'invalid'

export interface JournalAck {
    nodeId: string
    ok: boolean
    seq: number
    hash: string
    reason?: JournalRejection
}

export interface ReplicaExport {
    nodeId: string
    highestEpoch: number
    commitSeq: number
    snapshot: JournalSnapshot | null
    entries: JournalEntry[]
    branches: Record<string, JournalEntry[]>
}

export interface JournalReplicationTarget {
    nodeId: string
    /** Resolves null when the node is unreachable. */
    deliver(message: JournalMessage): Promise<JournalAck | null>
}

export const JOURNAL_GENESIS = '0'.repeat(64)

export function emptyMainState(): MainState {
    return Object.fromEntries(MAIN_STATE_DOMAINS.map(domain => [domain, {}]))
}

export function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export function stateChecksum(state: MainState): string {
    return sha256(stableJson(state))
}

export function createMemorySigner(nodeId: string): JournalSigner {
    const pair = generateKeyPairSync('ed25519')
    return {
        nodeId,
        publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        sign: data => sign(null, data, pair.privateKey).toString('base64url'),
    }
}

export function signerFromMeshIdentity(identity: MeshIdentity): JournalSigner {
    return { nodeId: identity.nodeId, publicKey: identity.publicKey, sign: data => identity.signDetached(data) }
}

function verifySignature(publicKey: string | undefined, hash: string, signature: string): boolean {
    if (!publicKey || typeof signature !== 'string') return false
    try { return verify(null, Buffer.from(hash), publicKey, Buffer.from(signature, 'base64url')) } catch { return false }
}

/** HKDF-SHA256 from the shared journal secret (≥ 32 characters, never stored by the journal). */
export function deriveJournalKey(secret: string): Buffer {
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('state journal secret must have at least 32 characters')
    return Buffer.from(hkdfSync('sha256', secret, 'xaventra-state-journal', 'v1', 32))
}

function seal(key: Buffer, value: unknown, aad: string): SealedBox {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(aad))
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function unseal<T>(key: Buffer, box: SealedBox, aad: string): T | null {
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
        decipher.setAAD(Buffer.from(aad))
        decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
        const plain = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8')
        return JSON.parse(plain) as T
    } catch { return null }
}

const entryAad = (e: Pick<JournalEntry, 'seq' | 'epoch' | 'author' | 'prevHash' | 'branch'>) => `entry|${e.seq}|${e.epoch}|${e.author}|${e.prevHash}|${e.branch || ''}`
const snapshotAad = (s: Pick<JournalSnapshot, 'upToSeq' | 'lastHash' | 'epoch' | 'author'>) => `snapshot|${s.upToSeq}|${s.lastHash}|${s.epoch}|${s.author}`

function entryHash(e: Omit<JournalEntry, 'hash' | 'signature'>): string {
    return sha256(stableJson({ v: e.v, kind: e.kind, seq: e.seq, epoch: e.epoch, author: e.author, prevHash: e.prevHash, createdAt: e.createdAt, commitSeq: e.commitSeq, branch: e.branch, sealed: e.sealed }))
}
function snapshotHash(s: Omit<JournalSnapshot, 'hash' | 'signature'>): string {
    return sha256(stableJson({ v: s.v, kind: s.kind, upToSeq: s.upToSeq, lastHash: s.lastHash, epoch: s.epoch, author: s.author, createdAt: s.createdAt, checksum: s.checksum, sealed: s.sealed }))
}
function promotionHash(p: Omit<JournalPromotion, 'hash' | 'signature'>): string {
    return sha256(stableJson({ v: p.v, kind: p.kind, epoch: p.epoch, author: p.author, createdAt: p.createdAt }))
}

const isInt = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min

function entryValid(e: JournalEntry, trusted: TrustedKeys): JournalRejection | null {
    if (!e || e.v !== 1 || e.kind !== 'entry' || !isInt(e.seq, 1) || !isInt(e.epoch) || !isInt(e.commitSeq) || typeof e.prevHash !== 'string' || !e.sealed) return 'invalid'
    if (!trusted[e.author]) return 'untrusted'
    if (entryHash(e) !== e.hash || !verifySignature(trusted[e.author], e.hash, e.signature)) return 'bad-signature'
    return null
}
function snapshotValid(s: JournalSnapshot, trusted: TrustedKeys): JournalRejection | null {
    if (!s || s.v !== 1 || s.kind !== 'snapshot' || !isInt(s.upToSeq, 1) || !isInt(s.epoch) || !s.sealed) return 'invalid'
    if (!trusted[s.author]) return 'untrusted'
    if (snapshotHash(s) !== s.hash || !verifySignature(trusted[s.author], s.hash, s.signature)) return 'bad-signature'
    return null
}
function promotionValid(p: JournalPromotion, trusted: TrustedKeys): JournalRejection | null {
    if (!p || p.v !== 1 || p.kind !== 'promote' || !isInt(p.epoch, 1)) return 'invalid'
    if (!trusted[p.author]) return 'untrusted'
    if (promotionHash(p) !== p.hash || !verifySignature(trusted[p.author], p.hash, p.signature)) return 'bad-signature'
    return null
}

interface ReplicaFile extends ReplicaExport { epochAuthors: Record<string, string> }

/**
 * Durable replica of the journal on one node. Verifies signatures, chain and
 * epoch fencing; persists ciphertext only. Needs no decryption key.
 */
export class JournalReplica {
    readonly nodeId: string
    private readonly trusted: TrustedKeys
    private readonly file?: string
    private data: ReplicaFile

    constructor(options: { nodeId: string; trusted: TrustedKeys; file?: string }) {
        this.nodeId = options.nodeId
        this.trusted = options.trusted
        this.file = options.file
        this.data = { nodeId: options.nodeId, highestEpoch: 0, commitSeq: 0, snapshot: null, entries: [], branches: {}, epochAuthors: {} }
        if (this.file && existsSync(this.file)) {
            let parsed: ReplicaFile
            try { parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ReplicaFile } catch (error) {
                // Fail closed: an unreadable replica must not silently restart empty.
                throw new Error(`state journal replica ${this.file} is unreadable; restore it or move it aside: ${String(error).slice(0, 160)}`)
            }
            if (!parsed || !Array.isArray(parsed.entries) || !isInt(parsed.highestEpoch)) throw new Error(`state journal replica ${this.file} is corrupt`)
            this.data = { ...this.data, ...parsed, nodeId: options.nodeId, branches: parsed.branches || {}, epochAuthors: parsed.epochAuthors || {} }
        }
    }

    lastSeq(): number {
        const last = this.data.entries[this.data.entries.length - 1]
        return last ? last.seq : this.data.snapshot?.upToSeq ?? 0
    }

    lastHash(): string {
        const last = this.data.entries[this.data.entries.length - 1]
        return last ? last.hash : this.data.snapshot?.lastHash ?? JOURNAL_GENESIS
    }

    private hashAt(seq: number): string | null {
        if (seq === 0) return JOURNAL_GENESIS
        if (this.data.snapshot && seq === this.data.snapshot.upToSeq) return this.data.snapshot.lastHash
        return this.data.entries.find(entry => entry.seq === seq)?.hash ?? null
    }

    private ack(ok: boolean, reason?: JournalRejection, seq = this.lastSeq()): JournalAck {
        return { nodeId: this.nodeId, ok, seq, hash: ok ? this.hashAt(seq) || this.lastHash() : this.lastHash(), reason }
    }

    private fencedBy(epoch: number, author: string): boolean {
        if (epoch < this.data.highestEpoch) return true
        const owner = this.data.epochAuthors[String(epoch)]
        return Boolean(owner && owner !== author)
    }

    private noteEpoch(epoch: number, author: string): void {
        if (epoch > this.data.highestEpoch) this.data.highestEpoch = epoch
        if (epoch > 0 && !this.data.epochAuthors[String(epoch)]) {
            this.data.epochAuthors[String(epoch)] = author
            const keys = Object.keys(this.data.epochAuthors).map(Number).sort((a, b) => a - b)
            for (const old of keys.slice(0, Math.max(0, keys.length - 32))) delete this.data.epochAuthors[String(old)]
        }
    }

    private persist(): void {
        if (this.file) atomicWriteJsonSync(this.file, this.data)
    }

    receive(message: JournalMessage): JournalAck {
        try {
            switch (message?.type) {
                case 'promote': return this.receivePromotion(message.promotion)
                case 'entry': return this.receiveEntry(message.entry)
                case 'branch': return this.receiveBranch(message.entry)
                case 'snapshot': return this.receiveSnapshot(message.snapshot)
                case 'sync': return this.receiveSync(message)
                default: return this.ack(false, 'invalid')
            }
        } catch {
            return this.ack(false, 'invalid')
        }
    }

    private receivePromotion(p: JournalPromotion): JournalAck {
        const invalid = promotionValid(p, this.trusted)
        if (invalid) return this.ack(false, invalid)
        if (this.fencedBy(p.epoch, p.author)) return this.ack(false, 'fenced')
        this.noteEpoch(p.epoch, p.author)
        this.persist()
        return this.ack(true)
    }

    private receiveEntry(e: JournalEntry): JournalAck {
        const invalid = entryValid(e, this.trusted)
        if (invalid) return this.ack(false, invalid)
        if (e.branch) return this.ack(false, 'invalid')
        if (this.fencedBy(e.epoch, e.author)) return this.ack(false, 'fenced')
        const base = this.data.snapshot?.upToSeq ?? 0
        // Already covered by the confirmed snapshot (snapshots are only taken of confirmed state).
        if (e.seq <= base) return this.ack(true, undefined, base)
        const existing = this.data.entries.find(entry => entry.seq === e.seq)
        if (existing?.hash === e.hash) return this.ack(true, undefined, e.seq)
        if (e.seq === this.lastSeq() + 1) {
            if (e.prevHash !== this.lastHash()) return this.ack(false, 'fork')
            this.data.entries.push(e)
        } else if (existing) {
            // A newer term may replace an unconfirmed tail of an older term, never a confirmed entry.
            if (e.seq <= this.data.commitSeq || e.epoch <= existing.epoch || this.hashAt(e.seq - 1) !== e.prevHash) return this.ack(false, 'fork')
            this.data.entries = this.data.entries.filter(entry => entry.seq < e.seq)
            this.data.entries.push(e)
        } else {
            this.noteEpoch(e.epoch, e.author)
            this.persist()
            return this.ack(false, 'gap')
        }
        this.noteEpoch(e.epoch, e.author)
        this.data.commitSeq = Math.max(this.data.commitSeq, e.commitSeq)
        this.persist()
        return this.ack(true, undefined, e.seq)
    }

    private receiveBranch(e: JournalEntry): JournalAck {
        const invalid = entryValid(e, this.trusted)
        if (invalid) return this.ack(false, invalid)
        if (!e.branch || e.branch.length > 200) return this.ack(false, 'invalid')
        const list = this.data.branches[e.branch] ||= []
        if (!list.some(item => item.hash === e.hash)) {
            list.push(e)
            list.sort((a, b) => a.seq - b.seq)
            this.persist()
        }
        return { nodeId: this.nodeId, ok: true, seq: e.seq, hash: e.hash }
    }

    private receiveSnapshot(s: JournalSnapshot): JournalAck {
        const invalid = snapshotValid(s, this.trusted)
        if (invalid) return this.ack(false, invalid)
        if (this.fencedBy(s.epoch, s.author)) return this.ack(false, 'fenced')
        if (this.data.snapshot && this.data.snapshot.upToSeq >= s.upToSeq) return this.ack(true)
        if (s.upToSeq > this.lastSeq()) return this.ack(false, 'gap')
        if (this.hashAt(s.upToSeq) !== s.lastHash) return this.ack(false, 'fork')
        this.data.snapshot = s
        this.data.entries = this.data.entries.filter(entry => entry.seq > s.upToSeq)
        this.data.commitSeq = Math.max(this.data.commitSeq, s.upToSeq)
        this.noteEpoch(s.epoch, s.author)
        this.persist()
        return this.ack(true)
    }

    /** Replace the local chain with a complete, verified chain from the current Main. */
    private receiveSync(message: Extract<JournalMessage, { type: 'sync' }>): JournalAck {
        if (message.promotion) {
            const invalid = promotionValid(message.promotion, this.trusted)
            if (invalid) return this.ack(false, invalid)
        }
        if (message.snapshot) {
            const invalid = snapshotValid(message.snapshot, this.trusted)
            if (invalid) return this.ack(false, invalid)
        }
        const entries = [...(message.entries || [])].sort((a, b) => a.seq - b.seq)
        let seq = message.snapshot?.upToSeq ?? 0
        let hash = message.snapshot?.lastHash ?? JOURNAL_GENESIS
        let maxEpoch = Math.max(message.snapshot?.epoch ?? 0, message.promotion?.epoch ?? 0)
        for (const entry of entries) {
            const invalid = entryValid(entry, this.trusted)
            if (invalid) return this.ack(false, invalid)
            if (entry.branch || entry.seq !== seq + 1 || entry.prevHash !== hash) return this.ack(false, 'fork')
            seq = entry.seq; hash = entry.hash; maxEpoch = Math.max(maxEpoch, entry.epoch)
        }
        if (maxEpoch < this.data.highestEpoch) return this.ack(false, 'fenced')
        if (message.promotion && this.fencedBy(message.promotion.epoch, message.promotion.author)) return this.ack(false, 'fenced')
        // Never regress below what this replica already knows as confirmed.
        if (seq < this.data.commitSeq) return this.ack(false, 'gap')
        if (seq === this.lastSeq() && hash === this.lastHash()) {
            if (message.promotion) this.noteEpoch(message.promotion.epoch, message.promotion.author)
            this.persist()
            return this.ack(true)
        }
        this.data.snapshot = message.snapshot
        this.data.entries = entries
        if (message.snapshot) this.noteEpoch(message.snapshot.epoch, message.snapshot.author)
        for (const entry of entries) this.noteEpoch(entry.epoch, entry.author)
        if (message.promotion) this.noteEpoch(message.promotion.epoch, message.promotion.author)
        this.data.commitSeq = Math.max(this.data.commitSeq, message.snapshot?.upToSeq ?? 0, ...entries.map(entry => entry.commitSeq))
        this.persist()
        return this.ack(true)
    }

    export(): ReplicaExport {
        const { epochAuthors: _ignored, ...rest } = this.data
        return structuredClone(rest)
    }
}

export interface RestoreResult {
    ok: boolean
    reason?: string
    state: MainState
    seq: number
    lastHash: string
    epoch: number
    committedSeq: number
    checksum: string
    /** `${domain}\0${key}` → seq of the last change (snapshot content counts as its upToSeq). */
    modifiedAt: Record<string, number>
}

function applyChanges(state: MainState, changes: StateChange[], modifiedAt: Record<string, number>, seq: number): void {
    for (const change of changes) {
        const bucket = state[change.domain] ||= {}
        if (change.op === 'delete') delete bucket[change.key]
        else bucket[change.key] = structuredClone(change.value)
        modifiedAt[`${change.domain}\0${change.key}`] = seq
    }
}

/**
 * Rebuild the Main state from the reachable replicas: best verifiable snapshot
 * plus the longest signed hash chain behind it (newer term wins at a fork).
 * Fails closed when the result does not reach the highest confirmed seq.
 */
export function restoreMainState(exports: Array<ReplicaExport | null | undefined>, options: { key: Buffer; trusted: TrustedKeys }): RestoreResult {
    const sources = exports.filter((item): item is ReplicaExport => Boolean(item))
    let state = emptyMainState()
    let seq = 0
    let lastHash = JOURNAL_GENESIS
    let epoch = 0
    let committedSeq = 0
    const modifiedAt: Record<string, number> = {}

    const snapshots = sources.map(source => source.snapshot).filter((snap): snap is JournalSnapshot => Boolean(snap) && snapshotValid(snap!, options.trusted) === null)
    for (const snap of snapshots) committedSeq = Math.max(committedSeq, snap.upToSeq)
    const usable = snapshots
        .map(snap => ({ snap, state: unseal<MainState>(options.key, snap.sealed, snapshotAad(snap)) }))
        .filter(item => item.state && stateChecksum(item.state) === item.snap.checksum)
        .sort((a, b) => b.snap.upToSeq - a.snap.upToSeq || b.snap.epoch - a.snap.epoch)
    if (usable[0]) {
        state = { ...emptyMainState(), ...usable[0].state! }
        seq = usable[0].snap.upToSeq
        lastHash = usable[0].snap.lastHash
        epoch = usable[0].snap.epoch
        for (const [domain, bucket] of Object.entries(state)) for (const key of Object.keys(bucket || {})) modifiedAt[`${domain}\0${key}`] = seq
    }

    const bySeq = new Map<number, JournalEntry[]>()
    for (const source of sources) {
        committedSeq = Math.max(committedSeq, source.commitSeq || 0)
        epoch = Math.max(epoch, source.highestEpoch || 0)
        for (const entry of source.entries || []) {
            if (entry.branch || entryValid(entry, options.trusted)) continue
            committedSeq = Math.max(committedSeq, entry.commitSeq)
            const list = bySeq.get(entry.seq) || []
            if (!list.some(item => item.hash === entry.hash)) list.push(entry)
            bySeq.set(entry.seq, list)
        }
    }
    for (;;) {
        const candidates = (bySeq.get(seq + 1) || []).filter(entry => entry.prevHash === lastHash).sort((a, b) => b.epoch - a.epoch)
        let applied = false
        for (const entry of candidates) {
            const payload = unseal<{ changes: StateChange[] }>(options.key, entry.sealed, entryAad(entry))
            if (!payload || !Array.isArray(payload.changes)) continue
            applyChanges(state, payload.changes, modifiedAt, entry.seq)
            seq = entry.seq; lastHash = entry.hash; epoch = Math.max(epoch, entry.epoch)
            applied = true
            break
        }
        if (!applied) break
    }
    const result = { state, seq, lastHash, epoch, committedSeq, checksum: stateChecksum(state), modifiedAt }
    if (seq < committedSeq) return { ...result, ok: false, reason: `incomplete: replayed up to ${seq}, but ${committedSeq} is confirmed` }
    return { ...result, ok: true }
}

export interface JournalBranch {
    id: string
    author: string
    baseSeq: number
    changes: StateChange[]
}

/** Decrypt the owner-approved emergency branches found on the replicas. */
export function collectBranches(exports: Array<ReplicaExport | null | undefined>, options: { key: Buffer; trusted: TrustedKeys }): JournalBranch[] {
    const byId = new Map<string, JournalEntry[]>()
    for (const source of exports) {
        for (const [id, list] of Object.entries(source?.branches || {})) {
            const merged = byId.get(id) || []
            for (const entry of list) {
                if (entry.branch !== id || entryValid(entry, options.trusted) || merged.some(item => item.hash === entry.hash)) continue
                merged.push(entry)
            }
            byId.set(id, merged)
        }
    }
    const branches: JournalBranch[] = []
    for (const [id, list] of byId) {
        const ordered = list.sort((a, b) => a.seq - b.seq)
        if (!ordered.length) continue
        const changes: StateChange[] = []
        let previous = ordered[0].prevHash
        let expectedSeq = ordered[0].seq
        for (const entry of ordered) {
            if (entry.seq !== expectedSeq || entry.prevHash !== previous || entry.author !== ordered[0].author) break
            const payload = unseal<{ changes: StateChange[] }>(options.key, entry.sealed, entryAad(entry))
            if (!payload) break
            changes.push(...payload.changes)
            previous = entry.hash; expectedSeq++
        }
        branches.push({ id, author: ordered[0].author, baseSeq: ordered[0].seq - 1, changes })
    }
    return branches
}

export class FencedWriterError extends Error {
    constructor(reason: string) {
        super(`state journal writer fenced: ${reason}`)
        this.name = 'FencedWriterError'
    }
}

function validateChange(change: StateChange): StateChange {
    const domains = new Set<string>([...MAIN_STATE_DOMAINS, SUCCESSION_META_DOMAIN])
    if (!change || !domains.has(change.domain)) throw new Error(`unknown state domain ${String(change?.domain)}`)
    if (typeof change.key !== 'string' || !change.key || change.key.length > 512) throw new Error('state key must be a non-empty string')
    if (change.op !== 'put' && change.op !== 'delete') throw new Error('state op must be put or delete')
    return change.op === 'delete' ? { domain: change.domain, key: change.key, op: 'delete' } : { domain: change.domain, key: change.key, op: 'put', value: change.value }
}

export interface WriterOptions {
    signer: JournalSigner
    key: Buffer
    epoch: number
    local: JournalReplica
    targets: () => JournalReplicationTarget[]
    /** Confirmations needed from OTHER nodes; at least two on the main chain. */
    minReplicas?: number
    resumeFrom?: RestoreResult
    branch?: string
    now?: () => number
}

/** The acting Main's side of the journal. */
export class StateJournalWriter {
    readonly epoch: number
    readonly branch?: string
    private current: MainState
    private seq: number
    private lastHashValue: string
    private commitSeq: number
    private fenced = false
    private promotion?: JournalPromotion
    private readonly acked = new Map<string, number>()
    private readonly modifiedAt: Record<string, number>
    private readonly minReplicas: number
    private readonly now: () => number

    constructor(private readonly options: WriterOptions) {
        this.epoch = options.epoch
        this.branch = options.branch
        this.minReplicas = options.minReplicas ?? 2
        if (!options.branch && this.minReplicas < 2) throw new Error('state journal needs confirmations from at least two other nodes')
        this.now = options.now || Date.now
        const resume = options.resumeFrom
        this.current = resume ? structuredClone(resume.state) : emptyMainState()
        this.seq = resume?.seq ?? 0
        this.lastHashValue = resume?.lastHash ?? JOURNAL_GENESIS
        this.commitSeq = resume?.committedSeq ?? 0
        this.modifiedAt = { ...(resume?.modifiedAt || {}) }
    }

    state(): MainState { return structuredClone(this.current) }
    lastSeq(): number { return this.seq }
    lastHash(): string { return this.lastHashValue }
    committedSeq(): number { return this.commitSeq }
    isFenced(): boolean { return this.fenced }
    ackedSeq(nodeId: string): number { return this.acked.get(nodeId) ?? -1 }
    localExport(): ReplicaExport { return this.options.local.export() }
    modifiedSince(domain: string, key: string, seq: number): boolean {
        return (this.modifiedAt[`${domain}\0${key}`] ?? -1) > seq
    }

    private signEntry(unsigned: Omit<JournalEntry, 'hash' | 'signature'>): JournalEntry {
        const hash = entryHash(unsigned)
        return { ...unsigned, hash, signature: this.options.signer.sign(Buffer.from(hash)) }
    }

    private noteAck(ack: JournalAck | null, target: JournalReplicationTarget): void {
        if (!ack) return
        if (ack.reason === 'fenced') this.fenced = true
        if (ack.ok) this.acked.set(target.nodeId, ack.hash === this.lastHashValue ? ack.seq : Math.min(ack.seq, this.seq - 1))
    }

    private syncBundle(): JournalMessage {
        const local = this.options.local.export()
        return { type: 'sync', snapshot: local.snapshot, entries: local.entries, promotion: this.promotion }
    }

    /** Send the full verified chain to one lagging node. */
    async syncTo(nodeId: string): Promise<boolean> {
        if (this.branch) return false
        const target = this.options.targets().find(item => item.nodeId === nodeId)
        if (!target) return false
        const ack = await target.deliver(this.syncBundle()).catch(() => null)
        this.noteAck(ack, target)
        return Boolean(ack?.ok)
    }

    private async broadcast(message: JournalMessage, seq: number): Promise<string[]> {
        const confirmed: string[] = []
        await Promise.all(this.options.targets().filter(target => target.nodeId !== this.options.signer.nodeId).map(async target => {
            let ack = await target.deliver(message).catch(() => null)
            if (ack && !ack.ok && (ack.reason === 'gap' || ack.reason === 'fork') && !this.branch) {
                ack = await target.deliver(this.syncBundle()).catch(() => null)
            }
            this.noteAck(ack, target)
            if (ack?.ok && ack.seq >= seq) confirmed.push(target.nodeId)
        }))
        return confirmed.sort()
    }

    /** Announce this term to all replicas; older terms are fenced from now on. */
    async promote(): Promise<string[]> {
        if (this.branch) return []
        const unsigned = { v: 1 as const, kind: 'promote' as const, epoch: this.epoch, author: this.options.signer.nodeId, createdAt: this.now() }
        const hash = promotionHash(unsigned)
        this.promotion = { ...unsigned, hash, signature: this.options.signer.sign(Buffer.from(hash)) }
        const local = this.options.local.receive({ type: 'promote', promotion: this.promotion })
        if (!local.ok) { this.fenced = local.reason === 'fenced' || this.fenced; throw new FencedWriterError(`local replica refused promotion (${local.reason})`) }
        const acks = await Promise.all(this.options.targets().map(async target => {
            const ack = await target.deliver({ type: 'promote', promotion: this.promotion! }).catch(() => null)
            this.noteAck(ack, target)
            return ack?.ok ? target.nodeId : null
        }))
        if (this.fenced) throw new FencedWriterError('a replica knows a newer term')
        return acks.filter((id): id is string => Boolean(id))
    }

    async record(input: StateChange | StateChange[]): Promise<{ seq: number; committed: boolean; acks: string[] }> {
        if (this.fenced) throw new FencedWriterError('a newer term exists')
        const changes = (Array.isArray(input) ? input : [input]).map(validateChange)
        if (!changes.length) throw new Error('no state change given')
        const seq = this.seq + 1
        const header = {
            v: 1 as const, kind: 'entry' as const, seq, epoch: this.epoch, author: this.options.signer.nodeId,
            prevHash: this.lastHashValue, createdAt: this.now(), commitSeq: this.commitSeq, branch: this.branch,
        }
        const entry = this.signEntry({ ...header, sealed: seal(this.options.key, { changes }, entryAad(header)) })
        const message: JournalMessage = this.branch ? { type: 'branch', entry } : { type: 'entry', entry }
        const local = this.options.local.receive(message)
        if (!local.ok) {
            if (local.reason === 'fenced') this.fenced = true
            throw new FencedWriterError(`local replica refused entry ${seq} (${local.reason})`)
        }
        this.seq = seq
        this.lastHashValue = entry.hash
        applyChanges(this.current, changes, this.modifiedAt, seq)
        const acks = await this.broadcast(message, seq)
        if (this.fenced) throw new FencedWriterError('a replica knows a newer term')
        const committed = acks.length >= (this.branch ? 1 : this.minReplicas)
        if (committed && !this.branch) this.commitSeq = seq
        return { seq, committed, acks }
    }

    /** Encrypted snapshot of the current state with plaintext checksum. */
    async snapshot(): Promise<{ seq: number; acks: string[] }> {
        if (this.branch) return { seq: this.seq, acks: [] }
        if (this.fenced) throw new FencedWriterError('a newer term exists')
        // Snapshots cover confirmed state only; an unconfirmed tail stays in the chain.
        if (this.seq === 0 || this.seq !== this.commitSeq) return { seq: this.commitSeq, acks: [] }
        const header = { v: 1 as const, kind: 'snapshot' as const, upToSeq: this.seq, lastHash: this.lastHashValue, epoch: this.epoch, author: this.options.signer.nodeId, createdAt: this.now(), checksum: stateChecksum(this.current) }
        const unsigned = { ...header, sealed: seal(this.options.key, this.current, snapshotAad(header)) }
        const hash = snapshotHash(unsigned)
        const snapshot: JournalSnapshot = { ...unsigned, hash, signature: this.options.signer.sign(Buffer.from(hash)) }
        const local = this.options.local.receive({ type: 'snapshot', snapshot })
        if (!local.ok) {
            if (local.reason === 'fenced') this.fenced = true
            throw new FencedWriterError(`local replica refused snapshot (${local.reason})`)
        }
        const acks = await this.broadcast({ type: 'snapshot', snapshot }, this.seq)
        return { seq: this.seq, acks }
    }
}

/**
 * Re-apply an emergency branch onto the majority chain. A key the majority
 * Main changed after the branch started is a conflict: the majority value
 * stays, the emergency value is preserved in the reconciliation record.
 */
export async function reconcileBranch(writer: StateJournalWriter, branch: JournalBranch, now = Date.now()): Promise<{ applied: StateChange[]; conflicts: StateChange[] }> {
    const applied: StateChange[] = []
    const conflicts: StateChange[] = []
    for (const change of branch.changes) {
        if (change.domain === SUCCESSION_META_DOMAIN) continue
        if (writer.modifiedSince(change.domain, change.key, branch.baseSeq)) conflicts.push(change)
        else applied.push(change)
    }
    await writer.record([
        ...applied,
        { domain: SUCCESSION_META_DOMAIN, key: `branch:${branch.id}`, op: 'put', value: { reconciledAt: new Date(now).toISOString(), author: branch.author, applied: applied.length, conflicts } },
    ])
    return { applied, conflicts }
}
