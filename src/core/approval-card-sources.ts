/**
 * Knopf-Karten — sources, executors and delivery (Phase 1 Teil A).
 *
 * Sources (read on the Main, every minute):
 * - Stufe 2: install queue items `queued` on the host-agent route
 *   -> "Ja" = approveQueuedInstall (signed ticket), "Immer erlauben" =
 *   setApprovalLevel('erlauben') + the same approval.
 * - Stufe 3: open self-heal proposals (local `self-heal/proposals.json` and
 *   worker reports carried by the signed mesh summary) -> "Ja"/"Nein" only
 *   records the decision on the proposal; there is no restart executor, so
 *   nothing is started.
 * - PATCH_GATE: queued patch proposals -> "Ja" = the existing PATCH_GATE
 *   approval (NOVA_PATCH_GATE_TOKEN, sandbox evidence, signed activation).
 *
 * Delivery: only a Main with a live Telegram adapter sends; a worker
 * (`NOVA_NODE_ONLY=true`) never sends — its proposals reach the Main via mesh.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import {
    cardKeyboard, createApprovalCard, formatCardText, listApprovalCards, maintainApprovalCards, recordCardDelivery,
    registerCardExecutor, type ApprovalCard, type CardExecutor, type CardStoreOptions,
} from './approval-cards.js'
import { approveQueuedInstall, loadInstallQueue, setApprovalLevel, type InstallQueueDeps } from '../install/install-queue.js'
import { readHealProposals, sanitizeSelfHealSummary, setHealProposalStatus, type SelfHealMeshSummary } from '../doctor/self-heal.js'

const DAY_MS = 24 * 60 * 60_000
const MAX_NEW_CARDS_PER_SYNC = 5

export interface BuiltinExecutorDeps {
    installDeps: () => InstallQueueDeps
    selfHealDataDir: () => string
    patchProposals: () => any[]
}

export interface CardSourceDeps {
    dataDir: string
    installDeps: InstallQueueDeps
    patchProposals: () => any[]
    peers: () => Array<{ nodeId: string; selfHeal?: SelfHealMeshSummary | null }>
    nodeId: string
}

export interface CardSender {
    /** Live Main + Telegram authority. */
    canSend(): Promise<boolean> | boolean
    /** Numeric owner ids from allowFrom (private chat id == user id). */
    ownerChatIds(): string[]
    send(chatId: string, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>): Promise<number | null>
}

const short = (value: unknown, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const json = (value: unknown, max = 600) => { try { return short(JSON.stringify(value), max) } catch { return '' } }

// ---------------------------------------------------------------------------
// executors (existing paths only)
// ---------------------------------------------------------------------------

export function createInstallExecutor(getDeps: () => InstallQueueDeps): CardExecutor {
    const proposal = (card: ApprovalCard) => loadInstallQueue(getDeps()).find(item => item.id === card.aktion.ref)
    return {
        kind: 'install',
        impact: 'intern',
        // An existing standing permission: catalog level 'erlauben' (takes effect in YOLO mode only).
        allowAlways: () => true,
        async execute(card, answer, ctx) {
            const deps = getDeps()
            const approver = { permission: 'owner', principalId: ctx.decidedBy, channel: 'telegram' }
            let note = ''
            if (answer === 'immer') {
                const item = proposal(card)
                if (!item) return { ok: false, message: `Kein Vorschlag ${card.aktion.ref} in der Warteschlange.` }
                const level = setApprovalLevel(item.catalogId, 'erlauben', approver, deps)
                note = level.ok ? ` (${item.catalogId}: Stufe erlauben — gilt nur im YOLO-Modus automatisch)` : ` (Stufe nicht geändert: ${level.message})`
            }
            const result = await approveQueuedInstall(card.aktion.ref, approver, deps)
            return { ok: result.ok, message: `${result.message}${note}` }
        },
        isStillOpen(card) {
            try { return proposal(card)?.status === 'queued' } catch { return true }
        },
    }
}

export function createSelfHealExecutor(getDataDir: () => string): CardExecutor {
    const decide = async (card: ApprovalCard, status: 'angenommen' | 'abgelehnt') => setHealProposalStatus(getDataDir(), card.aktion.ref, status)
    return {
        kind: 'self-heal',
        impact: 'intern',
        async execute(card) {
            const ok = await decide(card, 'angenommen')
            return ok
                ? { ok: true, message: 'Angenommen und im Vorschlag vermerkt. Für diese Aktion gibt es keinen freigegebenen Ausführungsweg — ich führe nichts selbst aus (z. B. Neustart macht Alfred).' }
                : { ok: false, message: 'Vorschlag nicht mehr offen oder nicht gefunden.' }
        },
        async reject(card) {
            const ok = await decide(card, 'abgelehnt')
            return { ok, message: ok ? 'Abgelehnt und im Vorschlag vermerkt.' : 'Vorschlag nicht mehr offen oder nicht gefunden.' }
        },
        isStillOpen(card) {
            try {
                const item = readHealProposals(getDataDir()).find(entry => entry.id === card.aktion.ref)
                return !item || item.status === 'offen'
            } catch { return true }
        },
    }
}

/** Worker proposals arrive via the signed mesh summary; the answer is recorded on the Main only. */
export function createPeerSelfHealExecutor(): CardExecutor {
    return {
        kind: 'self-heal-peer',
        impact: 'intern',
        async execute(card) {
            return { ok: true, message: `Vorschlag von ${card.node} angenommen und vermerkt. Worker führen nichts auf Zuruf aus; es gibt keinen Ausführungsweg.` }
        },
        async reject(card) {
            return { ok: true, message: `Vorschlag von ${card.node} abgelehnt und vermerkt.` }
        },
    }
}

const patchFile = () => join(process.cwd(), '.nova-data', 'patch-proposals.json')

export function createPatchExecutor(getProposals: () => any[]): CardExecutor {
    const find = (card: ApprovalCard) => getProposals().find((item: any) => item?.id === card.aktion.ref)
    return {
        kind: 'patch',
        impact: 'intern',
        // Code changes never get a standing permission (PATCH_GATE, STUFENPLAN S3.2).
        allowAlways: () => false,
        async execute(card) {
            const token = process.env.NOVA_PATCH_GATE_TOKEN
            if (!token) return { ok: false, message: 'NOVA_PATCH_GATE_TOKEN ist nicht gesetzt — Patch nicht angewendet.' }
            const proposal = find(card)
            if (!proposal) return { ok: false, message: `Patch-Vorschlag ${card.aktion.ref} nicht gefunden.` }
            if (proposal.status !== 'queued') return { ok: false, message: `Patch-Vorschlag ist bereits ${proposal.status}.` }
            if (proposal.kind === 'doctor-config') {
                const { applyApprovedDoctorProposal } = await import('../doctor/safe-fixes.js')
                const applied = await applyApprovedDoctorProposal(proposal, token)
                if (applied.applied) markPatch(card.aktion.ref, { status: 'applied', appliedAt: Date.now() })
                return { ok: applied.applied, message: applied.applied ? 'Config-Patch angewendet; Neustart und Live-Nachprüfung stehen aus.' : applied.message }
            }
            const { approveEvolutionProposal } = await import('../synthesis/self-evolution.js')
            const result = await approveEvolutionProposal(card.aktion.ref, token)
            if (result.activationPending) return { ok: true, message: 'Aktivierung noch nicht abschließend verifiziert; /patch status zeigt den signierten Stand.' }
            return result.success
                ? { ok: true, message: 'Patch aktiviert; ursprünglicher Fehler unabhängig live nachgeprüft.' }
                : { ok: false, message: `Patch fehlgeschlagen: ${short(result.error || 'unbekannt', 200)}${result.rollbackPerformed ? ' (Rollback durchgeführt)' : ''}` }
        },
        async reject(card) {
            const proposal = find(card)
            if (!proposal || proposal.status !== 'queued') return { ok: false, message: 'Patch-Vorschlag nicht mehr offen.' }
            const ok = markPatch(card.aktion.ref, { status: 'rejected', rejectedAt: Date.now() })
            return { ok, message: ok ? `Patch ${card.aktion.ref} abgelehnt.` : 'Patch-Vorschlag konnte nicht markiert werden.' }
        },
        isStillOpen(card) {
            try { const proposal = find(card); return !proposal || proposal.status === 'queued' } catch { return true }
        },
    }
}

/** Same file and marking as the existing /patch reject and Telegram patch_no paths. */
function markPatch(id: string, patch: Record<string, unknown>): boolean {
    try {
        const path = patchFile()
        if (!existsSync(path)) return false
        const all = JSON.parse(readFileSync(path, 'utf8'))
        if (!Array.isArray(all)) return false
        const index = all.findIndex((item: any) => item?.id === id)
        if (index < 0) return false
        all[index] = { ...all[index], ...patch }
        atomicWriteJsonSync(path, all)
        return true
    } catch { return false }
}

let builtinsRegistered = false

/** Registers install / self-heal / peer / patch executors. Tests pass their own deps. */
export function registerBuiltinCardExecutors(deps: BuiltinExecutorDeps): void {
    registerCardExecutor(createInstallExecutor(deps.installDeps))
    registerCardExecutor(createSelfHealExecutor(deps.selfHealDataDir))
    registerCardExecutor(createPeerSelfHealExecutor())
    registerCardExecutor(createPatchExecutor(deps.patchProposals))
    builtinsRegistered = true
}

/** Production wiring (idempotent). */
export async function ensureBuiltinCardExecutors(): Promise<void> {
    if (builtinsRegistered) return
    const { defaultInstallDeps } = await import('../install/install-queue.js')
    const { getNovaDataDir } = await import('./data-root.js')
    const { getPatchProposals } = await import('../synthesis/self-evolution.js')
    registerBuiltinCardExecutors({ installDeps: () => defaultInstallDeps(), selfHealDataDir: () => getNovaDataDir(), patchProposals: () => getPatchProposals(200) })
}

// ---------------------------------------------------------------------------
// sources -> cards
// ---------------------------------------------------------------------------

const recent = (at: unknown, now: number, maxAgeMs: number) => {
    const ms = typeof at === 'number' ? at : Date.parse(String(at))
    return Number.isFinite(ms) && now - ms <= maxAgeMs
}

/** Creates cards for new proposals. Returns only the newly created cards. */
export function syncApprovalCardsFromSources(deps: CardSourceDeps, opts: CardStoreOptions = {}): ApprovalCard[] {
    const now = (opts.now || Date.now)()
    const created: ApprovalCard[] = []
    const add = (input: Parameters<typeof createApprovalCard>[0]) => {
        if (created.length >= MAX_NEW_CARDS_PER_SYNC) return
        const result = createApprovalCard(input, opts)
        if (result.ok && result.created) created.push(result.card)
    }
    const known = new Set(listApprovalCards(opts).map(card => card.dedupeKey).filter(Boolean))
    const fresh = (key: string) => !known.has(key)

    // Stufe 2
    try {
        const queue = loadInstallQueue(deps.installDeps)
        for (const item of queue) {
            if (item.status !== 'queued' || item.route.kind !== 'host-agent' || !recent(item.createdAt, now, 7 * DAY_MS)) continue
            const key = `install:${item.id}`
            if (!fresh(key)) continue
            add({
                art: 'install', titel: `${item.catalogId} auf ${item.nodeId} installieren?`,
                beleg: `Installationskatalog-Eintrag ${item.catalogId}, Quelle ${item.source}, vorgeschlagen ${item.createdAt.slice(0, 16).replace('T', ' ')} UTC. Ausführung nur über signiertes Ticket an den Host-Agenten, mit Rückweg.`,
                vorschlag: `Installieren (Warteschlange ${item.id}).`,
                aktion: { kind: 'install', ref: item.id }, node: item.nodeId, quelle: 'stufe-2', dedupeKey: key, ablaufMs: DAY_MS,
            })
        }
    } catch (error) { console.warn(`[Knopf-Karten] Installations-Warteschlange nicht lesbar: ${short(error, 120)}`) }

    // Stufe 3 (local)
    try {
        const proposals = readHealProposals(deps.dataDir)
        for (const item of proposals) {
            if (item.status !== 'offen' || !recent(item.at, now, DAY_MS)) continue
            const key = `self-heal:${item.recipe}:${item.signature}`
            if (!fresh(key)) continue
            add({
                art: 'self-heal', titel: short(item.title, 160), beleg: `${short(item.message, 400)} Befund: ${json(item.befund, 500)}`,
                vorschlag: short(item.message, 400), aktion: { kind: 'self-heal', ref: item.id }, node: item.node || deps.nodeId,
                quelle: 'stufe-3', dedupeKey: key, ablaufMs: DAY_MS,
            })
        }
    } catch (error) { console.warn(`[Knopf-Karten] Heil-Vorschläge nicht lesbar: ${short(error, 120)}`) }

    // Stufe 3 (workers via the Main)
    try {
        for (const peer of deps.peers()) {
            const summary = sanitizeSelfHealSummary(peer.selfHeal)
            if (!summary || !/^[A-Za-z0-9._-]{1,64}$/.test(peer.nodeId)) continue
            for (const report of summary.reports) {
                if (report.level !== 'vorschlag' || !report.notify || !recent(report.at, now, DAY_MS)) continue
                const ref = `${peer.nodeId}:${report.id}`.replace(/[^A-Za-z0-9_.:@-]/g, '-').slice(0, 160)
                const key = `self-heal-peer:${ref}`
                if (!fresh(key)) continue
                add({
                    art: 'self-heal-peer', titel: `${peer.nodeId}: ${short(report.recipe, 64)}`, beleg: short(report.message, 400),
                    vorschlag: short(report.message, 300), aktion: { kind: 'self-heal-peer', ref }, node: peer.nodeId,
                    quelle: 'stufe-3', dedupeKey: key, ablaufMs: DAY_MS,
                })
            }
        }
    } catch (error) { console.warn(`[Knopf-Karten] Worker-Vorschläge nicht lesbar: ${short(error, 120)}`) }

    // PATCH_GATE
    try {
        for (const patch of deps.patchProposals()) {
            if (patch?.status !== 'queued' || typeof patch.id !== 'string' || !recent(patch.createdAt, now, 7 * DAY_MS)) continue
            const key = `patch:${patch.id}`
            if (!fresh(key)) continue
            add({
                art: 'patch', titel: `Patch: ${short(patch.description || patch.file, 140)}`,
                beleg: `Datei ${short(patch.file, 120)}${patch.reason ? `, Grund: ${short(patch.reason, 200)}` : ''}; Sandbox ${patch.sandbox?.verified ? 'grün' : 'ohne Beleg'}${patch.kind === 'doctor-config' ? ' (Config-Patch)' : ''}.`,
                vorschlag: 'Über PATCH_GATE anwenden (Token, Sandbox-Belege, signierte Aktivierung).',
                aktion: { kind: 'patch', ref: patch.id }, quelle: 'patch-gate', dedupeKey: key, ablaufMs: 3 * DAY_MS,
            })
        }
    } catch (error) { console.warn(`[Knopf-Karten] Patch-Vorschläge nicht lesbar: ${short(error, 120)}`) }

    return created
}

// ---------------------------------------------------------------------------
// delivery (Main only)
// ---------------------------------------------------------------------------

export function isWorkerNode(env: NodeJS.ProcessEnv = process.env): boolean {
    return String(env.NOVA_NODE_ONLY || '').toLowerCase() === 'true'
}

/** Sends every open, undelivered card to the owner. Returns the number of delivered cards. */
export async function deliverPendingCards(sender: CardSender, opts: CardStoreOptions = {}): Promise<number> {
    if (isWorkerNode()) return 0
    const pending = listApprovalCards({ ...opts, status: 'offen' }).filter(card => !card.deliveredAt)
    if (!pending.length) return 0
    if (!(await sender.canSend())) return 0
    const chats = sender.ownerChatIds().filter(id => /^\d{1,20}$/.test(id)).slice(0, 3)
    if (!chats.length) return 0
    let delivered = 0
    for (const card of pending) {
        const messages: Array<{ chatId: string; messageId: number }> = []
        for (const chatId of chats) {
            try {
                const messageId = await sender.send(chatId, formatCardText(card), cardKeyboard(card))
                if (typeof messageId === 'number') messages.push({ chatId, messageId })
            } catch (error) {
                console.warn(`[Knopf-Karten] Zustellung ${card.id} fehlgeschlagen: ${short(error, 160)}`)
            }
        }
        if (messages.length) {
            recordCardDelivery(card.id, messages, opts)
            delivered++
        }
    }
    return delivered
}

// ---------------------------------------------------------------------------
// production loop
// ---------------------------------------------------------------------------

let loopTimer: ReturnType<typeof setInterval> | null = null
let loopRunning = false

export async function runApprovalCardTick(): Promise<void> {
    if (loopRunning || isWorkerNode()) return
    loopRunning = true
    try {
        await ensureBuiltinCardExecutors()
        const { defaultInstallDeps } = await import('../install/install-queue.js')
        const { getNovaDataDir } = await import('./data-root.js')
        const { getPatchProposals } = await import('../synthesis/self-evolution.js')
        const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
        const peers = async () => {
            try {
                const { getMeshPeerStates } = await import('../mesh/mesh-transport-runtime.js')
                return Object.values(getMeshPeerStates()).filter((peer: any) => peer.nodeId && peer.selfHeal).map((peer: any) => ({ nodeId: peer.nodeId, selfHeal: peer.selfHeal }))
            } catch { return [] }
        }
        const peerList = await peers()
        maintainApprovalCards()
        syncApprovalCardsFromSources({ dataDir: getNovaDataDir(), installDeps: defaultInstallDeps(), patchProposals: () => getPatchProposals(200), peers: () => peerList, nodeId: getLocalNodeId() })
        const { getTelegramAdapter } = await import('../channels/telegram.js')
        const tg = getTelegramAdapter()
        if (!tg) return
        await deliverPendingCards({
            canSend: () => tg.hasCardAuthority(),
            ownerChatIds: () => tg.getOwnerChatIds(),
            send: (chatId, text, keyboard) => tg.sendApprovalCard(chatId, text, keyboard),
        })
    } catch (error) {
        console.warn(`[Knopf-Karten] Durchlauf fehlgeschlagen: ${short(error, 200)}`)
    } finally {
        loopRunning = false
    }
}

/** Started by the Telegram channel on the Main; idempotent; never on a worker. */
export function startApprovalCardLoop(intervalMs = 60_000): void {
    if (loopTimer || isWorkerNode()) return
    loopTimer = setInterval(() => { void runApprovalCardTick() }, intervalMs)
    loopTimer.unref?.()
    const first = setTimeout(() => { void runApprovalCardTick() }, 15_000)
    first.unref?.()
}

export function stopApprovalCardLoop(): void {
    if (loopTimer) clearInterval(loopTimer)
    loopTimer = null
}
