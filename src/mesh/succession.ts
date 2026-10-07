/**
 * Main succession (2.88): "Main-Nachfolge mit vollem Wissen".
 *
 * One SuccessionController per main-eligible node. It builds on the existing
 * Main lease (witness quorum or Supabase, CL-07 epochs and fencing) instead of
 * a second election:
 *
 *  - Main: replicates every state change as a journal entry to the other
 *    main-eligible nodes (state-journal.ts). The first replica that already
 *    saw a newer epoch fences the writer for good.
 *  - Follower: a live lease exists elsewhere; keep the replica up to date.
 *  - Vacancy: the best-ranked reachable eligible node (strength profile,
 *    reachability, owner permission) collects the replica logs of a majority,
 *    raises the epoch floor above everything they saw, acquires the lease,
 *    restores the state, starts its term on a majority (fencing the old Main
 *    on every replica), opens the secret vault with shares of the other
 *    nodes and announces the move once ("Ich bin jetzt auf X umgezogen").
 *  - No majority reachable: safe mode — read only, nothing is sent. The owner
 *    can deliberately make this node Main with the emergency code
 *    (emergency-code.ts); that emergency term is time-bounded and its epoch
 *    sits above every known term, and the next majority term above it.
 *
 * Never two Mains: only the lease holder may act; a takeover needs a new,
 * higher epoch from the coordinator; replicas and workers reject older epochs.
 */

import type { LeaseDecision } from './leader-election.js'
import {
    FencedWriterError, NoQuorumError, StateJournalWriter, emptyMainState, restoreMainState,
    type JournalAck, type JournalKeys, type JournalMessage, type JournalReplica, type MainState, type ReplicaExport, type RestoreResult,
    type StateChange, type CommitResult,
} from './state-journal.js'
import {
    UnlockedSecrets, openSealedShare, unlockVaultWithOwnerCode, unlockVaultWithShares,
    type SealedShare, type SealedVault, type ShareKeyPair, type ShareRelease, type ShareRequest,
} from './secret-vault.js'
import type { EmergencyCodeGate } from './emergency-code.js'

export type SuccessionMode = 'worker' | 'follower' | 'main' | 'safe' | 'emergency-main'

export interface SuccessionPeer {
    nodeId: string
    /** Replica log of that node; null = unreachable or not a replica. */
    exportJournal(): Promise<ReplicaExport | null>
    deliver(message: JournalMessage): Promise<JournalAck | null>
    requestShare(request: ShareRequest): Promise<ShareRelease | null>
}

export interface MainView {
    /** Enough coordinator votes answered to know the truth. */
    majorityReachable: boolean
    holder?: { nodeId: string; epoch: number }
}

export interface RankedCandidate { nodeId: string; eligible: boolean; reachable: boolean; score: number }

export interface SuccessionOptions {
    nodeId: string
    hostname: string
    /** Owner decision for this node (succession-config.ts). */
    eligible: boolean
    keys: JournalKeys
    local: JournalReplica
    /** Number of main-eligible nodes incl. this one (journal quorum basis). */
    replicaCount: number
    /** Other main-eligible nodes (journal replicas). */
    replicas: () => SuccessionPeer[]
    /** Other nodes holding vault shares (usually every node). */
    shareHolders?: () => SuccessionPeer[]
    /** Existing lease path (acquire or renew nova-main). */
    acquireMain: () => Promise<LeaseDecision>
    /** Read-only view of the current lease holder. */
    peekMain: () => Promise<MainView>
    /** Next term must be at least this epoch (witness proposal floor). */
    raiseEpochFloor: (epoch: number) => void
    /** Eligible nodes best-first (strength profile). */
    rank: () => RankedCandidate[]
    vault?: SealedVault | null
    ownSealedShare?: SealedShare | null
    shareKeyPair?: ShareKeyPair | null
    emergencyGate?: EmergencyCodeGate | null
    emergencyMaxMs?: number
    vacancyGraceMs?: number
    now?: () => number
    /** Called after the node became (emergency) Main; runtime adopts fences and starts channels. */
    onBecameMain?: (info: { epoch: number; emergency: boolean }) => void | Promise<void>
    /** Called after the node stopped being Main (fenced, lost lease, emergency over). */
    onSteppedDown?: (info: { reason: string; mode: SuccessionMode }) => void | Promise<void>
}

export interface SuccessionStatus {
    mode: SuccessionMode
    epoch: number
    reason: string
    secretsUnlocked: boolean
    emergencyUntil?: number
}

export const SAFE_MODE_TEXT = 'Sicherer Modus: Ich erreiche gerade keine Mehrheit im Mesh. Ich lese nur und sende nichts. '
    + 'Mit deinem Notfallcode kannst du diesen Rechner bewusst zum Main machen.'

export function moveNoticeText(hostname: string, missing: string[], emergency = false): string {
    const where = `Ich bin jetzt auf ${hostname} umgezogen`
    const how = emergency ? ' (Notfall-Main, von dir bestätigt)' : ''
    return missing.length ? `${where}${how}. Gedächtnis ist da, noch offen: ${missing.join(', ')}.` : `${where}${how}, alles da.`
}

function lastTermHolder(restored: RestoreResult): string | null {
    for (let index = restored.entries.length - 1; index >= 0; index--) {
        if (restored.entries[index].kind === 'term') return restored.entries[index].nodeId
    }
    return null
}

export class SuccessionController {
    private modeValue: SuccessionMode
    private epochValue = 0
    private reasonValue = 'start'
    private writer: StateJournalWriter | null = null
    private secrets: UnlockedSecrets | null = null
    private vacancySince: number | null = null
    private emergencyUntil = 0
    private pendingNotice: string | null = null
    private readonly now: () => number

    constructor(private readonly options: SuccessionOptions) {
        this.now = options.now || Date.now
        this.modeValue = options.eligible ? 'follower' : 'worker'
    }

    // ---------- read side ----------

    mode(): SuccessionMode { return this.modeValue }
    epoch(): number { return this.epochValue }

    status(): SuccessionStatus {
        return {
            mode: this.modeValue, epoch: this.epochValue, reason: this.reasonValue,
            secretsUnlocked: Boolean(this.secrets?.names().length),
            ...(this.modeValue === 'emergency-main' ? { emergencyUntil: this.emergencyUntil } : {}),
        }
    }

    /** Only the acting Main may write state or send anything. */
    isActingMain(): boolean {
        if (!this.writer || this.writer.isFenced()) return false
        if (this.modeValue === 'main') return true
        return this.modeValue === 'emergency-main' && this.now() < this.emergencyUntil
    }

    /** Safe mode, follower and worker never send (Telegram, mails, devices). */
    canSend(): boolean {
        return this.isActingMain()
    }

    state(): MainState {
        return this.writer ? this.writer.state() : emptyMainState()
    }

    /** In-memory secret for the acting Main only. */
    secret(name: string): string | undefined {
        return this.isActingMain() ? this.secrets?.get(name) : undefined
    }

    /** One-time move notice for the channel that starts first on the new Main. */
    takeMoveNotice(): string | null {
        const notice = this.pendingNotice
        this.pendingNotice = null
        return notice
    }

    // ---------- write side ----------

    async record(changes: StateChange | StateChange[]): Promise<CommitResult> {
        if (!this.isActingMain() || !this.writer) throw new Error(`${this.options.nodeId} is not the acting Main (${this.modeValue})`)
        try {
            return await this.writer.record(changes)
        } catch (error) {
            if (error instanceof FencedWriterError) await this.stepDown(`fenced: ${error.message}`, 'follower')
            throw error
        }
    }

    // ---------- helpers ----------

    private quorum(): number {
        return Math.floor(Math.max(1, this.options.replicaCount) / 2) + 1
    }

    private async collectExports(): Promise<ReplicaExport[]> {
        const remote = await Promise.all(this.options.replicas().filter(peer => peer.nodeId !== this.options.nodeId)
            .map(peer => peer.exportJournal().catch(() => null)))
        return [this.options.local.export(), ...remote.filter((item): item is ReplicaExport => Boolean(item))]
    }

    private targets() {
        return this.options.replicas().filter(peer => peer.nodeId !== this.options.nodeId)
            .map(peer => ({ nodeId: peer.nodeId, deliver: (message: JournalMessage) => peer.deliver(message).catch(() => null) }))
    }

    private async stepDown(reason: string, mode: SuccessionMode): Promise<void> {
        const wasMain = this.modeValue === 'main' || this.modeValue === 'emergency-main'
        this.writer = null
        this.secrets?.wipe()
        this.secrets = null
        this.emergencyUntil = 0
        this.pendingNotice = null
        this.modeValue = this.options.eligible ? mode : 'worker'
        this.reasonValue = reason
        if (wasMain) {
            try { await this.options.onSteppedDown?.({ reason, mode: this.modeValue }) } catch { /* observer only */ }
        }
    }

    private async unlockWithShares(epoch: number): Promise<UnlockedSecrets | null> {
        const vault = this.options.vault
        const keyPair = this.options.shareKeyPair
        if (!vault || !vault.k || !keyPair) return null
        const shares: string[] = []
        if (this.options.ownSealedShare) {
            try { shares.push(openSealedShare(this.options.ownSealedShare, keyPair)) } catch { /* own share unusable */ }
        }
        const holders = (this.options.shareHolders || this.options.replicas)().filter(peer => peer.nodeId !== this.options.nodeId)
        const releases = await Promise.all(holders.map(peer => peer.requestShare({
            requester: this.options.nodeId, requesterPublicKey: keyPair.publicKey, epoch,
        }).catch(() => null)))
        for (const release of releases) {
            if (!release?.ok || !release.share) continue
            try { shares.push(openSealedShare(release.share, keyPair)) } catch { /* not for us */ }
        }
        if (shares.length < vault.k) return null
        try { return unlockVaultWithShares(vault, shares) } catch { return null }
    }

    private async beginTerm(epoch: number, restored: RestoreResult, options: { emergency: boolean; code?: string }): Promise<boolean> {
        this.options.local.adoptRestoredLog(restored.entries)
        const writer = new StateJournalWriter({
            nodeId: this.options.nodeId, epoch, keys: this.options.keys, local: this.options.local,
            targets: () => this.targets(), quorum: this.quorum(), emergency: options.emergency, state: restored.state,
            onFenced: error => { void this.stepDown(`fenced: ${error.message}`, 'follower') },
        })
        try {
            await writer.start()
        } catch (error) {
            if (error instanceof NoQuorumError || error instanceof FencedWriterError) {
                await this.stepDown(`term ${epoch} not started: ${error.message}`, error instanceof FencedWriterError ? 'follower' : 'safe')
                return false
            }
            throw error
        }
        this.writer = writer
        this.epochValue = epoch
        this.modeValue = options.emergency ? 'emergency-main' : 'main'
        this.secrets = options.emergency && options.code && this.options.vault?.ownerWrap
            ? (() => { try { return unlockVaultWithOwnerCode(this.options.vault!, options.code!) } catch { return null } })()
            : await this.unlockWithShares(epoch)
        const missing: string[] = []
        if (this.options.vault && !this.secrets) missing.push('Schlüssel (Telegram, Verbindungen)')
        // Announce only a real move: another node held the previous term.
        const previous = lastTermHolder(restored)
        this.pendingNotice = previous && previous !== this.options.nodeId ? moveNoticeText(this.options.hostname, missing, options.emergency) : null
        this.reasonValue = options.emergency ? `emergency term ${epoch} confirmed by owner` : `term ${epoch} restored from ${restored.replicas} replica(s)`
        try { await this.options.onBecameMain?.({ epoch, emergency: options.emergency }) } catch { /* runtime hook best effort */ }
        return true
    }

    // ---------- the loop ----------

    /** Read-only refresh of follower/safe mode (no takeover). */
    async refreshView(): Promise<MainView | null> {
        if (!this.options.eligible) {
            this.modeValue = 'worker'
            return null
        }
        if (this.modeValue === 'main' || this.modeValue === 'emergency-main') return null
        const view = await this.options.peekMain().catch(() => ({ majorityReachable: false }) as MainView)
        if (!view.majorityReachable) {
            this.vacancySince = null
            this.modeValue = 'safe'
            this.reasonValue = 'no majority reachable'
            return view
        }
        if (view.holder && view.holder.nodeId !== this.options.nodeId) {
            this.vacancySince = null
            this.options.local.observeEpoch(view.holder.epoch)
            this.modeValue = 'follower'
            this.reasonValue = `Main is ${view.holder.nodeId} (epoch ${view.holder.epoch})`
            return view
        }
        if (this.modeValue === 'safe') {
            this.modeValue = 'follower'
            this.reasonValue = 'majority reachable again; no Main yet'
        }
        return view
    }

    async tick(): Promise<SuccessionStatus> {
        if (!this.options.eligible) {
            this.modeValue = 'worker'
            return this.status()
        }
        if (this.modeValue === 'main') return this.renewMain()
        if (this.modeValue === 'emergency-main') return this.renewEmergency()

        const view = await this.refreshView()
        if (!view || !view.majorityReachable || (view.holder && view.holder.nodeId !== this.options.nodeId)) return this.status()
        // Vacancy: only the best reachable eligible node goes first; the next
        // ones wait rank x grace so a slow but better node is not overtaken.
        const now = this.now()
        if (this.vacancySince === null) this.vacancySince = now
        const ranking = this.options.rank().filter(item => item.eligible && item.reachable)
        const position = Math.max(0, ranking.findIndex(item => item.nodeId === this.options.nodeId))
        if (position > 0 && now - this.vacancySince < position * (this.options.vacancyGraceMs ?? 20_000)) {
            this.modeValue = 'follower'
            this.reasonValue = `vacancy; ${ranking[0].nodeId} has priority`
            return this.status()
        }
        const prepared = await this.prepareTakeover()
        if (!prepared.ok || !prepared.restored) return this.status()
        const decision = await this.options.acquireMain()
        if (!decision.leader || !decision.epoch) {
            this.modeValue = decision.quorumReachable === false ? 'safe' : 'follower'
            this.reasonValue = decision.reason
            return this.status()
        }
        await this.adoptTerm(decision.epoch, prepared.restored)
        return this.status()
    }

    /**
     * Before acquiring the lease: read a majority of replica logs (else the
     * state is not provably complete: safe mode) and raise the epoch floor
     * above everything they saw.
     */
    async prepareTakeover(): Promise<{ ok: boolean; reason: string; restored?: RestoreResult }> {
        if (!this.options.eligible) return { ok: false, reason: 'node is not main-eligible (owner decision)' }
        let restored: RestoreResult
        try {
            restored = restoreMainState(this.options.keys, await this.collectExports(), { quorum: this.quorum(), requireQuorum: true })
        } catch (error) {
            this.modeValue = 'safe'
            this.reasonValue = `state not provably complete: ${(error as Error).message}`
            return { ok: false, reason: this.reasonValue }
        }
        this.options.raiseEpochFloor(restored.maxEpoch + 1)
        return { ok: true, reason: `restored from ${restored.replicas} replica(s)`, restored }
    }

    /** After the lease was acquired with `epoch`: restore, start the term, open the vault. */
    async adoptTerm(epoch: number, restored?: RestoreResult): Promise<boolean> {
        if (this.modeValue === 'main' && this.epochValue === epoch && this.writer && !this.writer.isFenced()) return true
        let base = restored
        if (!base) {
            const prepared = await this.prepareTakeover()
            if (!prepared.ok || !prepared.restored) return false
            base = prepared.restored
        }
        // A restarted Main may continue its own live term (same epoch from the
        // coordinator); any other node needs an epoch above everything known.
        const ownTerm = epoch === base.maxEpoch && lastTermHolder(base) === this.options.nodeId
        if (epoch < base.maxEpoch || (epoch === base.maxEpoch && !ownTerm)) {
            // The coordinator handed out a term the journal already knows: never act on it.
            this.modeValue = 'follower'
            this.reasonValue = `lease epoch ${epoch} is not above journal epoch ${base.maxEpoch}; refusing`
            return false
        }
        this.vacancySince = null
        this.writer = null
        return this.beginTerm(epoch, base, { emergency: false })
    }

    /** The lease layer reported the loss of nova-main. */
    async noteLeaseLost(reason: string, quorumReachable?: boolean): Promise<void> {
        await this.stepDown(`lease lost: ${reason}`, quorumReachable === false ? 'safe' : 'follower')
    }

    private async renewMain(): Promise<SuccessionStatus> {
        if (!this.writer || this.writer.isFenced()) {
            await this.stepDown('journal writer fenced', 'follower')
            return this.status()
        }
        const decision = await this.options.acquireMain()
        if (decision.leader && decision.epoch === this.epochValue) return this.status()
        if (decision.leader && decision.epoch && decision.epoch > this.epochValue) {
            // The coordinator moved the term (e.g. raised floor); continue in the new term.
            const restored: RestoreResult = {
                state: this.writer.state(), entries: this.options.local.log(), lastSeq: this.options.local.lastSeq(),
                maxEpoch: this.epochValue, source: this.options.nodeId, replicas: 1,
            }
            this.writer = null
            await this.beginTerm(decision.epoch, restored, { emergency: false })
            return this.status()
        }
        await this.stepDown(`lease lost: ${decision.reason}`, decision.quorumReachable === false ? 'safe' : 'follower')
        return this.status()
    }

    private async renewEmergency(): Promise<SuccessionStatus> {
        if (!this.writer || this.writer.isFenced()) {
            await this.stepDown('emergency journal fenced', 'follower')
            return this.status()
        }
        const view = await this.options.peekMain().catch(() => ({ majorityReachable: false }) as MainView)
        if (view.majorityReachable) {
            // A majority is back: become a regular Main or yield to the holder.
            const decision = await this.options.acquireMain()
            if (decision.leader && decision.epoch && decision.epoch > this.epochValue) {
                const restored = restoreMainState(this.options.keys, await this.collectExports(), { quorum: this.quorum(), requireQuorum: false })
                const keepSecrets = this.secrets
                this.secrets = null
                this.writer = null
                const ok = await this.beginTerm(decision.epoch, restored, { emergency: false })
                if (ok && !this.secrets && keepSecrets) this.secrets = keepSecrets
                else keepSecrets?.wipe()
                this.pendingNotice = null
                return this.status()
            }
            await this.stepDown(`majority back; Main is ${decision.holder || view.holder?.nodeId || 'another node'}`, 'follower')
            return this.status()
        }
        if (this.now() >= this.emergencyUntil) await this.stepDown('emergency time is over', 'safe')
        return this.status()
    }

    /**
     * Owner emergency path. Allowed only on an eligible node in safe mode
     * (fresh check: no majority reachable). The code is checked constant-time
     * and never stored, logged or returned.
     */
    async claimEmergency(code: string): Promise<{ ok: boolean; reason: string }> {
        if (!this.options.eligible) return { ok: false, reason: 'Dieser Rechner darf laut deiner Einstellung nicht Main werden.' }
        const gate = this.options.emergencyGate
        if (!gate?.configured()) return { ok: false, reason: 'Es ist kein Notfallcode eingerichtet.' }
        const verdict = gate.verify(code)
        if (!verdict.ok) {
            return { ok: false, reason: verdict.reason === 'locked' ? 'Zu viele falsche Versuche. Bitte später nochmal.' : 'Der Notfallcode stimmt nicht.' }
        }
        const view = await this.options.peekMain().catch(() => ({ majorityReachable: false }) as MainView)
        if (view.majorityReachable) {
            return { ok: false, reason: 'Die Mehrheit ist erreichbar – der Main wird automatisch gewählt, kein Notfall nötig.' }
        }
        if (this.modeValue === 'main' || this.modeValue === 'emergency-main') return { ok: true, reason: 'Dieser Rechner ist schon Main.' }
        const restored = restoreMainState(this.options.keys, await this.collectExports(), { quorum: this.quorum(), requireQuorum: false })
        const epoch = Math.max(restored.maxEpoch, this.options.local.highWater()) + 1
        // The next majority term must lie above this emergency term.
        this.options.raiseEpochFloor(epoch + 1)
        this.emergencyUntil = this.now() + (this.options.emergencyMaxMs ?? 4 * 60 * 60_000)
        const started = await this.beginTerm(epoch, restored, { emergency: true, code })
        if (!started) return { ok: false, reason: 'Notfall-Main konnte nicht starten.' }
        this.emergencyUntil = this.now() + (this.options.emergencyMaxMs ?? 4 * 60 * 60_000)
        return { ok: true, reason: `Dieser Rechner ist jetzt Notfall-Main (bis ${new Date(this.emergencyUntil).toISOString()}).` }
    }
}
