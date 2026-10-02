/**
 * 2.86 package K — "Main-Ausfall: Nachfolge mit vollem Wissen".
 *
 * One SuccessionNode per mesh node. Each tick it decides, from its own view:
 *   - Main: renew the majority lease (witness quorum over all nodes); on
 *     failure fence itself synchronously. Hand back to a better-ranked node
 *     once that node is reachable, stable and caught up with the journal.
 *   - Follower: if a live lease exists elsewhere, follow. On a vacancy the
 *     best-ranked reachable eligible node (rankNodes('main')) acquires the
 *     majority lease, restores the full Main state from ≥ majority journal
 *     replicas (fail closed if a confirmed entry is missing), promotes its
 *     term (older terms are fenced on every replica) and unlocks the secret
 *     vault with k-of-n shares released by the holders.
 *   - No majority reachable: safety mode — keep working read-only, nothing
 *     consequential, owner informed over every reachable channel; the
 *     best-placed node offers a one-time emergency code. With that code the
 *     owner can approve an emergency Main whose writes go to a separate branch
 *     that is reconciled once a majority Main exists again.
 * Never two Mains: a Main needs floor(n/2)+1 witness approvals per TTL; the
 * local deadline expires before the witness lease; replicas reject older
 * epochs. An emergency Main exists only while no majority is reachable and
 * yields before a majority Main is elected.
 */

import { randomUUID } from 'node:crypto'
import { QuorumWitnessStore, type WitnessDecision, type WitnessLease } from './quorum-witness.js'
import { decideQuorumLease } from './witness-quorum.js'
import type { LeaseDecision } from './leader-election.js'
import {
    FencedWriterError, JournalReplica, SUCCESSION_META_DOMAIN, StateJournalWriter, collectBranches, emptyMainState, reconcileBranch,
    restoreMainState, type JournalAck, type JournalMessage, type JournalReplicationTarget, type JournalSigner, type MainState,
    type ReplicaExport, type StateChange, type TrustedKeys,
} from './state-journal.js'
import {
    openSealedShare, unlockSecretVault, type SealedVault, type ShareHolder, type ShareKeyPair, type ShareRelease, type ShareRequest,
    type UnlockedSecrets,
} from './secret-shares.js'
import { issueEmergencyCode, type EmergencyCodeRecord, type EmergencyReleaseGate } from './emergency-release.js'
import type { RankedNode } from './succession-ranking.js'

export const SUCCESSION_SERVICE = 'nova-main'

export interface WitnessClient {
    id: string
    acquire(input: { service: string; nodeId: string; holderHostname: string; ttlMs: number; requestId: string; proposedEpoch: number }): Promise<WitnessDecision | null>
    /** undefined = witness unreachable; null = reachable without lease. */
    peek(service: string): Promise<WitnessLease | null | undefined>
    release(input: { service: string; nodeId: string; epoch: number }): Promise<boolean>
}

/** Adapter for a witness store running in this process (tests, co-located witness). */
export function createInProcessWitnessClient(store: QuorumWitnessStore, options: { reachable?: () => boolean; now?: () => number } = {}): WitnessClient {
    const up = options.reachable || (() => true)
    const now = options.now || Date.now
    return {
        id: store.witnessId,
        acquire: async input => up() ? store.acquire(input, now()) : null,
        peek: async service => up() ? store.peek(service) : undefined,
        release: async input => up() ? store.release(input, now()) : false,
    }
}

export interface OwnerNotifier {
    channel: string
    /** true = delivered. Must not log the text (it can carry a one-time code). */
    send(text: string): Promise<boolean>
}

export interface SuccessionPeer {
    nodeId: string
    reachable(): boolean
    deliver(message: JournalMessage): Promise<JournalAck | null>
    exportJournal(): Promise<ReplicaExport | null>
    requestShare(request: ShareRequest): Promise<ShareRelease | null>
    registerEmergencyRecord(record: EmergencyCodeRecord): Promise<boolean>
    /** Ask an emergency Main to step down because a majority exists again. */
    yieldEmergency(): Promise<boolean>
}

export type SuccessionRole = 'follower' | 'main' | 'safety' | 'emergency-main'

export interface SuccessionOptions {
    nodeId: string
    hostname?: string
    signer: JournalSigner
    journalKey: Buffer
    trusted: TrustedKeys
    localReplica: JournalReplica
    /** Number of nodes in the mesh (witnesses = replicas = share holders). */
    clusterSize: number
    witnesses: WitnessClient[]
    peers: () => SuccessionPeer[]
    rank: () => RankedNode[]
    now?: () => number
    leaseTtlMs?: number
    /** Next candidate waits index × grace after a vacancy before it may try. */
    vacancyGraceMs?: number
    /** A better-ranked node must be reachable this long before the hand-back. */
    handbackStableMs?: number
    emergencyCodeTtlMs?: number
    emergencyMaxMs?: number
    notifiers?: OwnerNotifier[]
    emergencyGate?: EmergencyReleaseGate
    shareHolder?: ShareHolder
    shareKeyPair?: ShareKeyPair
    vault?: SealedVault
    log?: (line: string) => void
}

export interface TickReport { role: SuccessionRole; action: string; detail?: string }

export class SuccessionNode {
    private roleValue: SuccessionRole = 'follower'
    private epochValue = 0
    private leaseDeadline = 0
    private emergencyUntil = 0
    private writer: StateJournalWriter | null = null
    private secrets: UnlockedSecrets | null = null
    private vacancySince: number | null = null
    private betterSince: { nodeId: string; since: number } | null = null
    private safetyNoticeAt = 0
    private codeExpiresAt = 0
    private readonly highWater = new Map<string, number>()
    private readonly now: () => number
    private readonly ttl: number
    private readonly log: (line: string) => void

    constructor(private readonly options: SuccessionOptions) {
        if (options.clusterSize < 3) throw new Error('Main succession needs at least three nodes (one Main + two replicas)')
        this.now = options.now || Date.now
        this.ttl = options.leaseTtlMs ?? 30_000
        this.log = options.log || (() => undefined)
    }

    // ---------- read side ----------

    role(): SuccessionRole { return this.roleValue }
    epoch(): number { return this.epochValue }
    state(): MainState { return this.writer ? this.writer.state() : emptyMainState() }
    secretsUnlocked(): boolean { return Boolean(this.secrets?.names().length) }

    /** Only the node that may act as Main right now (local deadline still ahead of the witness lease). */
    isActingMain(): boolean {
        const now = this.now()
        if (this.roleValue === 'main') return Boolean(this.writer && !this.writer.isFenced() && now < this.leaseDeadline)
        if (this.roleValue === 'emergency-main') return Boolean(this.writer && now < this.emergencyUntil)
        return false
    }

    /** Existing Telegram rule kept: only the acting Main polls; additionally the token must be unlocked. */
    canStartTelegramPoller(): boolean {
        return this.isActingMain() && Boolean(this.secrets?.has('TELEGRAM_BOT_TOKEN'))
    }

    /** Safety mode / follower: nothing consequential (switching, deleting, sending on behalf, deploying). */
    consequentialActionsAllowed(): boolean {
        return this.isActingMain()
    }

    /** In-memory secret for the acting Main only (never persisted, never logged). */
    secret(name: string): string | undefined {
        return this.isActingMain() ? this.secrets?.get(name) : undefined
    }

    // ---------- write side ----------

    async record(changes: StateChange | StateChange[]): Promise<{ seq: number; committed: boolean; acks: string[] }> {
        if (!this.isActingMain() || !this.writer) throw new Error(`${this.options.nodeId} is not the acting Main (role ${this.roleValue})`)
        try {
            return await this.writer.record(changes)
        } catch (error) {
            if (error instanceof FencedWriterError) this.stepDown(`journal fenced: ${error.message}`)
            throw error
        }
    }

    async snapshot(): Promise<{ seq: number; acks: string[] }> {
        if (!this.isActingMain() || !this.writer) throw new Error(`${this.options.nodeId} is not the acting Main`)
        return this.writer.snapshot()
    }

    // ---------- helpers ----------

    private majorityWitnesses(): number { return Math.floor(this.options.witnesses.length / 2) + 1 }
    private majorityNodes(): number { return Math.floor(this.options.clusterSize / 2) + 1 }
    private minReplicas(): number { return Math.max(2, Math.floor(this.options.clusterSize / 2)) }

    private reachablePeers(): SuccessionPeer[] {
        return this.options.peers().filter(peer => peer.nodeId !== this.options.nodeId && peer.reachable())
    }

    private targets(): JournalReplicationTarget[] {
        return this.options.peers().filter(peer => peer.nodeId !== this.options.nodeId)
            .map(peer => ({ nodeId: peer.nodeId, deliver: message => peer.reachable() ? peer.deliver(message) : Promise.resolve(null) }))
    }

    /** Ranking restricted to what this node can reach right now. */
    private reachableRanking(): RankedNode[] {
        const reachable = new Set([this.options.nodeId, ...this.reachablePeers().map(peer => peer.nodeId)])
        return this.options.rank().filter(item => item.eligible && reachable.has(item.nodeId))
    }

    private async acquireLease(): Promise<LeaseDecision> {
        const witnesses = this.options.witnesses
        return decideQuorumLease({
            service: SUCCESSION_SERVICE, nodeId: this.options.nodeId, ttlMs: this.ttl, witnessCount: witnesses.length,
            now: this.now, highWater: this.highWater, label: 'succession witness majority',
            ask: proposedEpoch => {
                const requestId = randomUUID()
                return Promise.all(witnesses.map(witness => witness.acquire({
                    service: SUCCESSION_SERVICE, nodeId: this.options.nodeId, holderHostname: this.options.hostname || this.options.nodeId,
                    ttlMs: this.ttl, requestId, proposedEpoch,
                }).catch(() => null)))
            },
        })
    }

    private async releaseLease(): Promise<void> {
        await Promise.all(this.options.witnesses.map(witness => witness.release({
            service: SUCCESSION_SERVICE, nodeId: this.options.nodeId, epoch: this.epochValue,
        }).catch(() => false)))
    }

    private async witnessView(): Promise<{ reachable: number; otherHolder: WitnessLease | null }> {
        const now = this.now()
        const peeks = await Promise.all(this.options.witnesses.map(witness => witness.peek(SUCCESSION_SERVICE).catch(() => undefined)))
        const reachable = peeks.filter(item => item !== undefined).length
        const otherHolder = peeks.find(item => item && item.holderNodeId !== this.options.nodeId && Date.parse(item.expiresAt) > now) || null
        return { reachable, otherHolder }
    }

    /** Synchronous self-fencing: writer, secrets and role are gone before any await. */
    private stepDown(reason: string): void {
        if (this.roleValue === 'main' || this.roleValue === 'emergency-main') this.log(`[Succession] ${this.options.nodeId} steps down: ${reason}`)
        this.writer = null
        this.secrets?.wipe()
        this.secrets = null
        this.leaseDeadline = 0
        this.emergencyUntil = 0
        this.betterSince = null
        this.roleValue = 'follower'
    }

    private async notifyOwner(text: string): Promise<string[]> {
        const delivered: string[] = []
        for (const notifier of this.options.notifiers || []) {
            try { if (await notifier.send(text)) delivered.push(notifier.channel) } catch { /* try the next way */ }
        }
        this.log(`[Succession] owner notice from ${this.options.nodeId}: ${delivered.length ? `delivered via ${delivered.join(', ')}` : 'no channel reachable'}`)
        return delivered
    }

    private async collectExports(): Promise<ReplicaExport[]> {
        const remote = await Promise.all(this.reachablePeers().map(peer => peer.exportJournal().catch(() => null)))
        return [this.options.localReplica.export(), ...remote.filter((item): item is ReplicaExport => Boolean(item))]
    }

    private async unlockSecrets(input: { epoch?: number; emergencyCode?: string; ownerRecoveryShare?: string }): Promise<void> {
        const { vault, shareHolder, shareKeyPair } = this.options
        if (!vault || !shareHolder || !shareKeyPair) return
        const shares: string[] = []
        try { shares.push(shareHolder.ownShare()) } catch { /* own share unreadable: rely on others */ }
        if (input.ownerRecoveryShare) shares.push(input.ownerRecoveryShare)
        for (const peer of this.reachablePeers()) {
            if (shares.length >= vault.k) break
            const released = await peer.requestShare({
                requester: this.options.nodeId, requesterPublicKey: shareKeyPair.publicKey, epoch: input.epoch, emergencyCode: input.emergencyCode,
            }).catch(() => null)
            if (!released?.ok || !released.share) continue
            try { shares.push(openSealedShare(released.share, shareKeyPair)) } catch { /* tampered share: ignore */ }
        }
        try {
            this.secrets = shares.length >= vault.k ? unlockSecretVault(vault, shares) : null
        } catch {
            this.secrets = null
        }
        this.log(`[Succession] ${this.options.nodeId} secret vault ${this.secrets ? 'unlocked' : `locked (${shares.length}/${vault.k} shares)`}`)
    }

    // ---------- the decision loop ----------

    async tick(): Promise<TickReport> {
        const now = this.now()

        if (this.roleValue === 'emergency-main') {
            const view = await this.witnessView()
            if (view.reachable >= this.majorityWitnesses()) {
                this.stepDown('emergency Main yields: majority reachable again')
            } else if (now >= this.emergencyUntil) {
                this.stepDown('emergency approval expired')
                return this.enterSafety('emergency approval expired; no majority reachable')
            } else {
                return { role: this.roleValue, action: 'emergency-hold' }
            }
        }

        if (this.roleValue === 'main') {
            const renewed = await this.acquireLease()
            if (!renewed.leader || renewed.epoch !== this.epochValue || !renewed.leaseExpiresAt) {
                this.stepDown(`lease renewal failed: ${renewed.reason}`)
            } else {
                this.leaseDeadline = Date.parse(renewed.leaseExpiresAt)
                await this.catchUpFollowers()
                if (await this.maybeHandBack()) return { role: this.roleValue, action: 'handed-back' }
                return { role: this.roleValue, action: 'main-renewed' }
            }
        }

        const view = await this.witnessView()
        if (view.reachable < this.majorityWitnesses()) {
            return this.enterSafety(`only ${view.reachable}/${this.options.witnesses.length} witnesses reachable, majority needs ${this.majorityWitnesses()}`)
        }
        if (this.roleValue === 'safety') {
            this.roleValue = 'follower'
            this.safetyNoticeAt = 0
            this.codeExpiresAt = 0
            this.log(`[Succession] ${this.options.nodeId} leaves safety mode: majority reachable`)
        }
        if (view.otherHolder) {
            this.vacancySince = null
            return { role: this.roleValue, action: 'follow', detail: view.otherHolder.holderNodeId }
        }

        this.vacancySince ??= now
        const ranked = this.reachableRanking()
        const index = ranked.findIndex(item => item.nodeId === this.options.nodeId)
        if (index < 0) return { role: this.roleValue, action: 'ineligible' }
        if (index > 0 && now - this.vacancySince < index * (this.options.vacancyGraceMs ?? 15_000)) {
            return { role: this.roleValue, action: 'wait-for-better-candidate', detail: ranked[0].nodeId }
        }
        return this.becomeMain()
    }

    private async becomeMain(): Promise<TickReport> {
        // An owner-approved emergency Main must be gone before a majority Main exists.
        await Promise.all(this.reachablePeers().map(peer => peer.yieldEmergency().catch(() => false)))
        const lease = await this.acquireLease()
        if (!lease.leader || !lease.epoch || !lease.leaseExpiresAt) return { role: this.roleValue, action: 'lease-denied', detail: lease.reason }
        this.epochValue = lease.epoch

        const exports = await this.collectExports()
        if (exports.length < this.majorityNodes()) {
            await this.releaseLease()
            return { role: this.roleValue, action: 'blocked', detail: `only ${exports.length} journal replicas reachable` }
        }
        const restored = restoreMainState(exports, { key: this.options.journalKey, trusted: this.options.trusted })
        if (!restored.ok) {
            await this.releaseLease()
            this.log(`[Succession] ${this.options.nodeId} refuses takeover: ${restored.reason}`)
            return { role: this.roleValue, action: 'blocked', detail: restored.reason }
        }
        const writer = new StateJournalWriter({
            signer: this.options.signer, key: this.options.journalKey, epoch: lease.epoch, local: this.options.localReplica,
            targets: () => this.targets(), minReplicas: this.minReplicas(), resumeFrom: restored, now: this.now,
        })
        try {
            await writer.promote()
        } catch (error) {
            await this.releaseLease()
            return { role: this.roleValue, action: 'blocked', detail: String(error) }
        }
        this.writer = writer
        this.roleValue = 'main'
        this.leaseDeadline = Date.parse(lease.leaseExpiresAt)
        this.vacancySince = null
        this.safetyNoticeAt = 0
        this.log(`[Succession] ${this.options.nodeId} is Main (epoch ${lease.epoch}, state up to ${restored.seq}, checksum ${restored.checksum.slice(0, 12)})`)

        const reconciled = new Set(Object.keys(restored.state[SUCCESSION_META_DOMAIN] || {}))
        for (const branch of collectBranches(exports, { key: this.options.journalKey, trusted: this.options.trusted })) {
            if (reconciled.has(`branch:${branch.id}`)) continue
            try {
                const result = await reconcileBranch(writer, branch, this.now())
                if (result.conflicts.length) {
                    await this.notifyOwner(`Xaventra: Notbetrieb-Zweig ${branch.id} übernommen; ${result.conflicts.length} Konflikt(e) – der Mehrheits-Stand blieb, die Notfall-Werte sind protokolliert.`)
                }
            } catch (error) {
                this.log(`[Succession] branch ${branch.id} not reconciled: ${String(error).slice(0, 160)}`)
            }
        }
        await this.unlockSecrets({ epoch: lease.epoch })
        return { role: this.roleValue, action: 'became-main', detail: `epoch ${lease.epoch}` }
    }

    private async catchUpFollowers(): Promise<void> {
        const writer = this.writer
        if (!writer) return
        for (const peer of this.reachablePeers()) {
            if (writer.ackedSeq(peer.nodeId) < writer.lastSeq()) await writer.syncTo(peer.nodeId)
        }
    }

    private async maybeHandBack(): Promise<boolean> {
        const writer = this.writer
        if (!writer) return false
        const best = this.reachableRanking()[0]
        if (!best || best.nodeId === this.options.nodeId) { this.betterSince = null; return false }
        const now = this.now()
        if (this.betterSince?.nodeId !== best.nodeId) this.betterSince = { nodeId: best.nodeId, since: now }
        if (now - this.betterSince.since < (this.options.handbackStableMs ?? 60_000)) return false
        if (writer.ackedSeq(best.nodeId) < writer.lastSeq()) return false
        await writer.snapshot()
        const marker = await writer.record({ domain: SUCCESSION_META_DOMAIN, key: 'handover', op: 'put', value: { from: this.options.nodeId, to: best.nodeId, epoch: this.epochValue, at: new Date(now).toISOString() } })
        if (!marker.committed || writer.ackedSeq(best.nodeId) < writer.lastSeq()) return false
        this.stepDown(`hand-back to better-ranked ${best.nodeId}`)
        await this.releaseLease()
        return true
    }

    private async enterSafety(reason: string): Promise<TickReport> {
        if (this.roleValue === 'main') this.stepDown(`no majority: ${reason}`)
        this.roleValue = 'safety'
        const now = this.now()
        const renewCode = this.codeExpiresAt > 0 && now >= this.codeExpiresAt
        if (this.safetyNoticeAt && !renewCode) return { role: this.roleValue, action: 'safety' }
        this.safetyNoticeAt = now
        const lines = [
            `Xaventra Sicherheitsmodus auf ${this.options.hostname || this.options.nodeId}: ${reason}.`,
            'Kein Main gewählt. Weiterarbeiten nur lesend, nichts Folgenreiches wird geschaltet.',
        ]
        const ranked = this.reachableRanking()
        if (ranked[0]?.nodeId === this.options.nodeId && this.options.emergencyGate) {
            const ttlMs = this.options.emergencyCodeTtlMs ?? 10 * 60_000
            const issued = issueEmergencyCode({ nodeId: this.options.nodeId, now, ttlMs })
            this.options.emergencyGate.register(issued.record)
            await Promise.all(this.reachablePeers().map(peer => peer.registerEmergencyRecord(issued.record).catch(() => false)))
            this.codeExpiresAt = issued.record.expiresAt
            lines.push(`Notfall-Freigabe: Code ${issued.code} an ${this.options.nodeId} zurückgeben (gültig bis ${new Date(issued.record.expiresAt).toISOString()}, einmalig, nur für diesen Knoten).`)
        }
        await this.notifyOwner(lines.join('\n'))
        return { role: this.roleValue, action: 'safety', detail: reason }
    }

    /** Owner approval without majority: this node becomes emergency Main (separate branch). */
    async confirmEmergencyRelease(code: string, options: { ownerRecoveryShare?: string } = {}): Promise<{ ok: boolean; reason?: string }> {
        if (this.roleValue !== 'safety') return { ok: false, reason: 'emergency release is only possible in safety mode' }
        if (!this.options.emergencyGate) return { ok: false, reason: 'no emergency gate configured' }
        if (!this.options.rank().some(item => item.nodeId === this.options.nodeId && item.eligible)) return { ok: false, reason: 'node is not Main-eligible' }
        const view = await this.witnessView()
        if (view.reachable >= this.majorityWitnesses()) return { ok: false, reason: 'a majority is reachable; normal election applies' }
        const exports = await this.collectExports()
        const restored = restoreMainState(exports, { key: this.options.journalKey, trusted: this.options.trusted })
        if (!restored.ok) return { ok: false, reason: `state not complete on reachable replicas: ${restored.reason}` }
        const verdict = this.options.emergencyGate.verify({ code, nodeId: this.options.nodeId })
        if (!verdict.ok || !verdict.grant) return { ok: false, reason: verdict.reason }
        this.writer = new StateJournalWriter({
            signer: this.options.signer, key: this.options.journalKey, epoch: restored.epoch, local: this.options.localReplica,
            targets: () => this.targets(), resumeFrom: restored, branch: `emergency:${this.options.nodeId}:${verdict.grant.codeId}`, now: this.now,
        })
        this.roleValue = 'emergency-main'
        this.emergencyUntil = this.now() + (this.options.emergencyMaxMs ?? 24 * 60 * 60_000)
        await this.unlockSecrets({ emergencyCode: code, ownerRecoveryShare: options.ownerRecoveryShare })
        await this.notifyOwner(`Xaventra Notbetrieb: ${this.options.nodeId} arbeitet als Notfall-Main (vom Owner freigegeben). Änderungen werden getrennt geführt und nach Rückkehr der Mehrheit abgeglichen.`)
        return { ok: true }
    }

    /** Steps down only after seeing the majority itself (a request alone is not proof). */
    async yieldEmergency(reason: string): Promise<boolean> {
        if (this.roleValue !== 'emergency-main') return false
        const view = await this.witnessView()
        if (view.reachable < this.majorityWitnesses()) return false
        this.stepDown(`emergency Main yields: ${reason}`)
        return true
    }
}
