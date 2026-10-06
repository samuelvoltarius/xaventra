/**
 * Main succession (2.88) — runtime wiring of the SuccessionController.
 *
 * Opt-in via `mesh.succession.enabled` plus `mesh.succession.mainNodes` (the
 * owner-approved Main nodes = journal replicas). The existing lease layer
 * (leader-election.ts) still decides who is Main; this module:
 *   - reads the replicated journal and raises the epoch floor before a
 *     vacancy takeover (beforeMainAcquire),
 *   - restores the state, starts the term and opens the vault right after the
 *     lease was acquired (onLeadershipAcquired, before Telegram starts),
 *   - answers journal/share requests of other nodes ('succession.request'),
 *   - keeps safe mode visible and handles the owner emergency code
 *     (claimEmergencyMain): the emergency term is honoured by the lease layer
 *     only while no majority is reachable (reconcileLeaseDecision).
 *
 * Secrets never leave memory in plaintext; the emergency code is never
 * logged or stored (only its scrypt hash).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createPrivateKey } from 'node:crypto'
import { hostname } from 'node:os'
import { getNovaDataDir } from '../core/data-root.js'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getLocalNodeId } from './mesh-registry.js'
import { getHeldFence, monoNow } from './fence.js'
import { getFenceHighWater } from './fence-highwater.js'
import type { LeaseDecision } from './leader-election.js'
import { loadSuccessionConfig, type SuccessionConfig } from './succession-config.js'
import { JournalReplica, deriveJournalKeys, type JournalKeys, type JournalMessage, type RestoreResult } from './state-journal.js'
import {
    ShareHolder, createShareKeyPair, sealSecretVault, type SealedShare, type SealedVault, type ShareKeyPair, type ShareRequest,
} from './secret-vault.js'
import { EmergencyCodeGate, createEmergencyCodeRecord, type EmergencyCodeRecord } from './emergency-code.js'
import { SAFE_MODE_TEXT, SuccessionController, type SuccessionPeer, type SuccessionStatus } from './succession.js'

const MAIN = 'nova-main'
const BOUND = ['telegram', 'whatsapp', 'discord', 'dashboard']
const REQUEST_TIMEOUT_MS = 10_000

let controller: SuccessionController | null = null
let active = false
let config: SuccessionConfig | null = null
let keys: JournalKeys | null = null
let localReplica: JournalReplica | null = null
let prepared: RestoreResult | null = null
let emergencyGrant: { epoch: number; deadlineMono: number } | null = null
let viewTimer: ReturnType<typeof setInterval> | null = null
let readyWaiters: Array<() => void> = []
let gate: EmergencyCodeGate | null = null
let localApi: { close: () => void } | null = null

function dataPath(...parts: string[]): string {
    return getNovaDataDir('succession', ...parts)
}

function readJson<T>(path: string): T | null {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null } catch { return null }
}

// ---------------------------------------------------------------------------
// Small public surface used by the lease layer, channels and status views
// ---------------------------------------------------------------------------

export function isSuccessionActive(): boolean {
    return active && controller !== null
}

export function getSuccessionController(): SuccessionController | null {
    return controller
}

export function hasEmergencyGrant(nowMono = monoNow()): boolean {
    return Boolean(emergencyGrant && nowMono < emergencyGrant.deadlineMono)
}

export function isEmergencyTermValid(epoch: number, nowMono = monoNow()): boolean {
    return Boolean(emergencyGrant && emergencyGrant.epoch === epoch && nowMono < emergencyGrant.deadlineMono
        && controller?.mode() === 'emergency-main')
}

/** Lease decision for an owner-confirmed emergency term (no coordinator involved). */
export function emergencyLeaseDecision(service: string, nowMono = monoNow()): LeaseDecision | null {
    if (!emergencyGrant || nowMono >= emergencyGrant.deadlineMono) return null
    if (service !== MAIN && !BOUND.includes(service)) return null
    const remaining = emergencyGrant.deadlineMono - nowMono
    let nodeId: string
    try { nodeId = getLocalNodeId() } catch { nodeId = hostname() }
    return {
        leader: true, epoch: emergencyGrant.epoch, coordinator: 'emergency', quorumReachable: false,
        fencingToken: `${service}:e${emergencyGrant.epoch}:${nodeId}`,
        leaseExpiresAt: new Date(Date.now() + remaining).toISOString(), deadlineMono: emergencyGrant.deadlineMono,
        reason: 'owner-confirmed emergency Main (no majority reachable)',
    }
}

/**
 * The real coordinator answered. While an emergency term is active it only
 * survives as long as no majority is reachable: a majority lease for this
 * node ends the emergency (regular term above it), a reachable majority
 * without us ends it too (step down).
 */
export function reconcileLeaseDecision(service: string, decision: LeaseDecision): LeaseDecision {
    if (!emergencyGrant) return decision
    if (decision.leader) {
        emergencyGrant = null
        if (service === MAIN && decision.epoch) void controller?.adoptTerm(decision.epoch).catch(() => false)
        return decision
    }
    if (decision.quorumReachable !== false) {
        emergencyGrant = null
        void controller?.noteLeaseLost(`majority back: ${decision.reason}`, true)
        return decision
    }
    return emergencyLeaseDecision(service) || decision
}

/** One-time "Ich bin jetzt auf X umgezogen" text for the first channel on the new Main. */
export function takeSuccessionMoveNotice(): string | null {
    return controller?.takeMoveNotice() ?? null
}

export function getSuccessionSecret(name: string): string | undefined {
    return controller?.secret(name)
}

/** The vault can provide this secret once this node is the legitimate Main. */
export function successionCanProvide(name: string): boolean {
    const stored = readJson<{ vault?: SealedVault }>(dataPath('vault.json'))
    return Boolean(isSuccessionActive() && stored?.vault?.names?.includes(name))
}

/** Wait (bounded) until the controller restored the term after a lease takeover. */
export async function waitForSuccessionMain(timeoutMs = 20_000): Promise<boolean> {
    if (!controller) return true
    if (controller.isActingMain()) return true
    await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
        readyWaiters.push(() => { clearTimeout(timer); resolve() })
    })
    return controller.isActingMain()
}

export function getSuccessionStatus(): SuccessionStatus | null {
    return controller?.status() ?? null
}

/** Short German status line for failover/desktop views; null when inactive. */
export function successionStatusText(): string | null {
    const status = getSuccessionStatus()
    if (!status) return null
    switch (status.mode) {
        case 'main': return `Main (Amtszeit ${status.epoch}); Wissen wird laufend auf die anderen Main-fähigen Rechner gespiegelt.`
        case 'emergency-main': return `Notfall-Main (vom Owner bestätigt) bis ${new Date(status.emergencyUntil || Date.now()).toLocaleString('de-AT')}.`
        case 'safe': return SAFE_MODE_TEXT
        case 'follower': return 'Bereit als Nachfolger: Wissen ist gespiegelt.'
        default: return 'Arbeiter (darf laut Owner nicht Main werden).'
    }
}

// ---------------------------------------------------------------------------
// Lease hooks
// ---------------------------------------------------------------------------

/** Before a vacancy takeover: majority of journal replicas readable, epoch floor raised. */
export async function beforeMainAcquire(): Promise<{ allow: boolean; reason: string; quorumReachable?: boolean }> {
    if (!controller) return { allow: true, reason: 'succession inactive' }
    const { peekMainLease } = await import('./leader-election.js')
    const view = await peekMainLease()
    if (!view.majorityReachable) return { allow: false, reason: 'no majority reachable (safe mode)', quorumReachable: false }
    let nodeId: string
    try { nodeId = getLocalNodeId() } catch { nodeId = hostname() }
    if (view.holder && view.holder.nodeId !== nodeId) return { allow: true, reason: 'live holder elsewhere; coordinator decides' }
    const result = await controller.prepareTakeover()
    if (!result.ok || !result.restored) return { allow: false, reason: result.reason, quorumReachable: true }
    prepared = result.restored
    const { resolveWitnessAuthority, raiseWitnessEpochFloor } = await import('./witness-quorum.js')
    if (resolveWitnessAuthority(MAIN)) raiseWitnessEpochFloor(MAIN, result.restored.maxEpoch + 1)
    return { allow: true, reason: result.reason }
}

async function onMainAcquired(epoch: number): Promise<void> {
    if (!controller || !epoch) return
    const fence = getHeldFence(MAIN)
    if (fence?.coordinator === 'emergency') return
    const restored = prepared
    prepared = null
    const ok = await controller.adoptTerm(epoch, restored || undefined)
    if (!ok) {
        const { relinquishMainLeadership } = await import('./leader-election.js')
        await relinquishMainLeadership(`succession refused term ${epoch}: ${controller.status().reason}`)
    }
    flushReadyWaiters()
}

function flushReadyWaiters(): void {
    const waiters = readyWaiters
    readyWaiters = []
    for (const resolve of waiters) resolve()
}

async function refresh(): Promise<void> {
    if (!controller) return
    const fence = getHeldFence(MAIN)
    const mode = controller.mode()
    if (fence && fence.coordinator !== 'emergency' && (mode !== 'main' || controller.epoch() !== fence.epoch)) {
        await onMainAcquired(fence.epoch)
        return
    }
    if (!fence && (mode === 'main' || mode === 'emergency-main') && !hasEmergencyGrant()) {
        await controller.noteLeaseLost('no Main fence held', undefined)
        return
    }
    if (mode === 'emergency-main' && !hasEmergencyGrant()) {
        await controller.noteLeaseLost('emergency time is over', false)
        return
    }
    await controller.refreshView()
}

// ---------------------------------------------------------------------------
// Node-to-node requests ('succession.request' / 'succession.response')
// ---------------------------------------------------------------------------

export type SuccessionOp = 'export' | 'deliver' | 'share' | 'share-key' | 'vault-store'
export interface SuccessionRequestPayload { op: SuccessionOp; message?: JournalMessage; request?: ShareRequest; epoch?: number; vault?: SealedVault; sealedShare?: SealedShare }

const pending = new Map<string, { node: string; resolve: (value: unknown) => void }>()

/** Response envelope from another node (called by the mesh transport). */
export function receiveSuccessionResponse(sourceNode: string, payload: { requestId?: string; success?: boolean; result?: unknown }): void {
    const entry = payload?.requestId ? pending.get(payload.requestId) : undefined
    if (!entry || entry.node !== sourceNode) return
    pending.delete(payload.requestId!)
    entry.resolve(payload.success === true ? payload.result ?? null : null)
}

async function request(node: string, payload: SuccessionRequestPayload): Promise<unknown> {
    const { getMeshTransport } = await import('./mesh-transport-runtime.js')
    const transport = getMeshTransport()
    if (!transport || pending.size >= 256) return null
    const envelope = transport.create('succession.request', node, payload, { ttlMs: REQUEST_TIMEOUT_MS })
    const response = new Promise<unknown>(resolve => {
        pending.set(envelope.id, { node, resolve })
        const timer = setTimeout(() => { pending.delete(envelope.id); resolve(null) }, REQUEST_TIMEOUT_MS)
        timer.unref?.()
    })
    try {
        const ack = await transport.send(node, envelope)
        if (ack.status === 'rejected' || ack.status === 'unreachable') {
            pending.delete(envelope.id)
            return null
        }
    } catch {
        pending.delete(envelope.id)
        return null
    }
    return response
}

function remotePeer(nodeId: string): SuccessionPeer {
    return {
        nodeId,
        exportJournal: async () => (await request(nodeId, { op: 'export' })) as any,
        deliver: async message => (await request(nodeId, { op: 'deliver', message })) as any,
        requestShare: async shareRequest => (await request(nodeId, { op: 'share', request: shareRequest })) as any,
    }
}

/** Holder side: does the coordinator (from THIS node's view) confirm that claim? */
async function verifyMainClaim(claim: { requester: string; epoch: number }): Promise<boolean> {
    const { resolveWitnessAuthority, peekWitnessQuorum } = await import('./witness-quorum.js')
    if (resolveWitnessAuthority(MAIN)) {
        const view = await peekWitnessQuorum(MAIN)
        return Boolean(view && view.reachable >= view.majority && view.holder?.nodeId === claim.requester && view.holder.epoch === claim.epoch)
    }
    const { checkRemoteFence } = await import('./leader-election.js')
    const remote = await checkRemoteFence(MAIN, claim.epoch, claim.requester)
    return remote.available && remote.valid
}

function holderHighWater(): number {
    return Math.max(getFenceHighWater(MAIN), localReplica?.highWater() || 0)
}

function loadShareKeyPair(): ShareKeyPair {
    const file = dataPath('share-key.json')
    const stored = readJson<{ publicKey: string; privateKey: string }>(file)
    if (stored?.publicKey && stored.privateKey) {
        return { publicKey: stored.publicKey, privateKey: createPrivateKey(stored.privateKey) }
    }
    const pair = createShareKeyPair()
    mkdirSync(dataPath(), { recursive: true })
    atomicWriteJsonSync(file, { publicKey: pair.publicKey, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })
    return pair
}

function loadVault(): { vault: SealedVault | null; sealedShare: SealedShare | null } {
    const stored = readJson<{ vault?: SealedVault; sealedShare?: SealedShare }>(dataPath('vault.json'))
    return { vault: stored?.vault || null, sealedShare: stored?.sealedShare || null }
}

/** Mesh handler for 'succession.request'. Never returns secrets in plaintext. */
export async function handleSuccessionRequest(payload: SuccessionRequestPayload, sourceNode: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    if (!active || !config) return { success: false, error: 'succession inactive on this node' }
    let nodeId: string
    try { nodeId = getLocalNodeId() } catch { nodeId = hostname() }
    const isReplica = config.mainNodes.includes(nodeId) && Boolean(localReplica)
    switch (payload?.op) {
        case 'export':
            if (!config.mainNodes.includes(sourceNode)) return { success: false, error: 'not a main node' }
            return { success: true, result: isReplica ? localReplica!.export() : null }
        case 'deliver': {
            if (!isReplica || !config.mainNodes.includes(sourceNode)) return { success: false, error: 'not a journal replica' }
            const entries = payload.message?.entries || []
            const newest = entries[entries.length - 1]
            // Writer binding: the newest entry must come from the sending node.
            if (!newest || newest.nodeId !== sourceNode) return { success: false, error: 'journal writer does not match sender' }
            return { success: true, result: localReplica!.append(payload.message!) }
        }
        case 'share': {
            const { vault, sealedShare } = loadVault()
            if (!vault || !sealedShare || !payload.request || payload.request.requester !== sourceNode) return { success: false, error: 'no share' }
            const holder = new ShareHolder({ nodeId, keyPair: loadShareKeyPair(), sealedShare, verifyMainClaim, highWater: holderHighWater })
            return { success: true, result: await holder.release(payload.request) }
        }
        case 'share-key':
            return { success: true, result: { nodeId, publicKey: loadShareKeyPair().publicKey } }
        case 'vault-store': {
            const epoch = Number(payload.epoch || 0)
            if (!payload.vault || !payload.sealedShare || payload.sealedShare.recipient !== nodeId || payload.sealedShare.vaultId !== payload.vault.id) {
                return { success: false, error: 'invalid vault' }
            }
            if (epoch < holderHighWater() || !(await verifyMainClaim({ requester: sourceNode, epoch }))) return { success: false, error: 'sender is not the current Main' }
            mkdirSync(dataPath(), { recursive: true })
            atomicWriteJsonSync(dataPath('vault.json'), { vault: payload.vault, sealedShare: payload.sealedShare, storedAt: new Date().toISOString(), fromEpoch: epoch })
            return { success: true, result: { stored: true } }
        }
        default:
            return { success: false, error: 'unknown succession operation' }
    }
}

// ---------------------------------------------------------------------------
// Owner actions
// ---------------------------------------------------------------------------

/**
 * Store the hash of a new owner emergency code (never the code). Replacing
 * an existing code needs the current one (same lockout as the claim).
 */
export function setupEmergencyCode(code: string, current?: string): { ok: boolean; reason: string } {
    try {
        if (gate?.configured()) {
            const verdict = gate.verify(current || '')
            if (!verdict.ok) return { ok: false, reason: verdict.reason === 'locked' ? 'Zu viele falsche Versuche. Bitte später nochmal.' : 'Der bisherige Notfallcode stimmt nicht.' }
        }
        const record = createEmergencyCodeRecord(code)
        mkdirSync(dataPath(), { recursive: true })
        atomicWriteJsonSync(dataPath('emergency-code.json'), record)
        gate?.replaceRecord(record)
        return { ok: true, reason: 'Notfallcode gespeichert (nur als Prüfwert).' }
    } catch (error) {
        return { ok: false, reason: (error as Error).message }
    }
}

/** Owner: make this node Main without a majority. The code is never logged. */
export async function claimEmergencyMain(code: string): Promise<{ ok: boolean; reason: string }> {
    if (!controller || !config) return { ok: false, reason: 'Die Main-Nachfolge ist auf diesem Rechner nicht eingeschaltet.' }
    const { resolveWitnessAuthority } = await import('./witness-quorum.js')
    if (!resolveWitnessAuthority(MAIN)) {
        // Supabase epochs come from a database sequence we cannot raise; an
        // emergency term could later collide with a regular one.
        return { ok: false, reason: 'Notfall-Main geht nur mit Zeugen-Mehrheit (Witness-Koordination).' }
    }
    const result = await controller.claimEmergency(code)
    if (result.ok && controller.mode() === 'emergency-main') {
        emergencyGrant = { epoch: controller.epoch(), deadlineMono: monoNow() + config.emergencyMaxMs }
        flushReadyWaiters()
    }
    return result
}

/**
 * Acting Main: seal the given secrets for every node (shares + owner wrap)
 * and push each node its copy. Returns the nodes that stored it.
 */
export async function distributeSecretVault(secrets: Record<string, string>, ownerCode?: string): Promise<{ stored: string[]; missing: string[] }> {
    if (!controller?.isActingMain()) throw new Error('only the acting Main distributes the vault')
    const { watchKnownNodes } = await import('./mesh-transport-runtime.js')
    let nodeId: string
    try { nodeId = getLocalNodeId() } catch { nodeId = hostname() }
    const others = [...new Set(watchKnownNodes())].filter(id => id && id !== nodeId)
    const keysFound = await Promise.all(others.map(async id => (await request(id, { op: 'share-key' })) as { nodeId?: string; publicKey?: string } | null))
    const holders = [{ nodeId, publicKey: loadShareKeyPair().publicKey }]
    keysFound.forEach((item, index) => { if (item?.publicKey && item.nodeId === others[index]) holders.push({ nodeId: others[index], publicKey: item.publicKey }) })
    const { vault, sealedShares } = sealSecretVault(secrets, holders, { ownerCode })
    const epoch = controller.epoch()
    const stored: string[] = []
    if (sealedShares[nodeId] || vault.k === 0) {
        mkdirSync(dataPath(), { recursive: true })
        atomicWriteJsonSync(dataPath('vault.json'), { vault, sealedShare: sealedShares[nodeId] || null, storedAt: new Date().toISOString(), fromEpoch: epoch })
        stored.push(nodeId)
    }
    for (const holder of holders.filter(item => item.nodeId !== nodeId)) {
        const reply = await request(holder.nodeId, { op: 'vault-store', epoch, vault, sealedShare: sealedShares[holder.nodeId] }) as { stored?: boolean } | null
        if (reply?.stored) stored.push(holder.nodeId)
    }
    return { stored, missing: [nodeId, ...others].filter(id => !stored.includes(id)) }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startSuccessionRuntime(): Promise<boolean> {
    if (controller) return true
    config = loadSuccessionConfig()
    if (!config.enabled) return false
    if (config.mainNodes.length < 1) {
        console.warn('[Nachfolge] mesh.succession.mainNodes fehlt – Main-Nachfolge bleibt aus.')
        return false
    }
    const { haStateKeyMaterial } = await import('../core/ha-state.js')
    const material = haStateKeyMaterial()
    if (!material) {
        console.warn('[Nachfolge] Kein gemeinsamer Zustandsschlüssel (NOVA_HA_STATE_KEY) – Main-Nachfolge bleibt aus.')
        return false
    }
    keys = deriveJournalKeys(material)
    let nodeId: string
    try { nodeId = getLocalNodeId() } catch { nodeId = hostname() }
    mkdirSync(dataPath(), { recursive: true })
    localReplica = new JournalReplica(nodeId, keys, dataPath('journal.json'))
    const shareKeyPair = loadShareKeyPair()
    const { vault, sealedShare } = loadVault()
    const record = readJson<EmergencyCodeRecord>(dataPath('emergency-code.json'))
    const leader = await import('./leader-election.js')
    const { watchKnownNodes } = await import('./mesh-transport-runtime.js')
    const mainNodes = config.mainNodes
    controller = new SuccessionController({
        nodeId, hostname: hostname(), eligible: config.mainEligible && mainNodes.includes(nodeId), keys, local: localReplica,
        replicaCount: mainNodes.length,
        replicas: () => mainNodes.filter(id => id !== nodeId).map(remotePeer),
        shareHolders: () => [...new Set(watchKnownNodes())].filter(id => id !== nodeId).map(remotePeer),
        acquireMain: () => leader.acquireServiceLease(MAIN),
        peekMain: () => leader.peekMainLease(),
        raiseEpochFloor: epoch => { void import('./witness-quorum.js').then(module => module.raiseWitnessEpochFloor(MAIN, epoch)) },
        rank: () => mainNodes.map((id, index) => ({ nodeId: id, eligible: true, reachable: true, score: mainNodes.length - index })),
        vault, ownSealedShare: sealedShare, shareKeyPair,
        emergencyGate: gate = new EmergencyCodeGate({ record, attemptsFile: dataPath('emergency-attempts.json') }),
        emergencyMaxMs: config.emergencyMaxMs, vacancyGraceMs: config.vacancyGraceMs,
        onSteppedDown: ({ reason }) => { console.warn(`[Nachfolge] Main abgegeben: ${reason}`) },
        onBecameMain: ({ epoch, emergency }) => { console.log(`[Nachfolge] ${emergency ? 'Notfall-Main' : 'Main'} übernommen (Amtszeit ${epoch})`) },
    })
    active = true
    leader.onLeadershipAcquired(MAIN, epoch => onMainAcquired(epoch))
    leader.onLeadershipLost(MAIN, () => controller?.noteLeaseLost('lease lost', undefined))
    viewTimer = setInterval(() => { void refresh().catch(() => undefined) }, 10_000)
    viewTimer.unref?.()
    void refresh().catch(() => undefined)
    if (config.localPort > 0 && controller.mode() !== 'worker') {
        try {
            const { createSuccessionLocalApi } = await import('./succession-local-api.js')
            const api = createSuccessionLocalApi({
                status: () => controller ? { mode: controller.mode(), text: successionStatusText() } : null,
                claim: code => claimEmergencyMain(code),
                setup: (code, current) => setupEmergencyCode(code, current),
                ownerToken: () => process.env.NOVA_DESKTOP_API_TOKEN || '',
            })
            await api.listen(config.localPort)
            api.server.unref()
            localApi = { close: () => api.server.close() }
        } catch (error) {
            console.warn(`[Nachfolge] lokale Notfall-Tür nicht gestartet: ${String(error).slice(0, 120)}`)
        }
    }
    console.log(`[Nachfolge] aktiv: ${mainNodes.length} Main-fähige Rechner, dieser ${controller.mode() === 'worker' ? 'ist Arbeiter' : 'kann Main werden'}`)
    return true
}

/** Test helper. */
export function resetSuccessionRuntimeForTests(): void {
    if (viewTimer) clearInterval(viewTimer)
    viewTimer = null
    localApi?.close()
    localApi = null
    gate = null
    controller = null
    active = false
    config = null
    keys = null
    localReplica = null
    prepared = null
    emergencyGrant = null
    readyWaiters = []
    pending.clear()
}

/** Test helper: install a controller without the mesh. */
export function installSuccessionControllerForTests(instance: SuccessionController, options: { mainNodes?: string[]; emergencyMaxMs?: number; replica?: JournalReplica } = {}): void {
    controller = instance
    active = true
    localReplica = options.replica || null
    config = { enabled: true, mainEligible: true, emergencyMaxMs: options.emergencyMaxMs ?? 60_000, vacancyGraceMs: 0, mainNodes: options.mainNodes || [], localPort: 0 }
}

/** Test helper: grant an emergency term directly. */
export function grantEmergencyForTests(epoch: number, ms: number): void {
    emergencyGrant = { epoch, deadlineMono: monoNow() + ms }
}

