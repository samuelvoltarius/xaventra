/**
 * Knopf-Karten — sources, executors and delivery (Phase 1 Teil A).
 *
 * Sources (read on the Main, every minute):
 * - Stufe 2: install queue items `queued` on the host-agent route
 *   -> "Ja" = approveQueuedInstall (signed owner ticket), "Immer erlauben" =
 *   the same approval plus a standing grant for this catalog entry in the one
 *   permission store (trust.json, written by answerApprovalCard). Entries with
 *   a standing permission are installed by `runStandingInstalls` before any
 *   card is created (signed as 'policy:vertrauensleiter').
 * - Stufe 3: open self-heal proposals (local `self-heal/proposals.json` and
 *   worker reports carried by the signed mesh summary) -> "Ja"/"Nein" only
 *   records the decision on the proposal; there is no restart executor, so
 *   nothing is started.
 * - PATCH_GATE: queued patch proposals -> "Ja" = the one PATCH_GATE chain
 *   (synthesis/patch-gate.ts: owner, single flight, live Main fencing,
 *   NOVA_PATCH_GATE_TOKEN, atomic state; sandbox evidence, signed activation).
 * - Werkzeug-Schmiede (P9): activation cards `werkzeug-*` are registered by
 *   tools/skill-builder.ts itself.
 * - 2.85 Paket D (Werkzeugkasten): „Entfernen“ offers an `install-rollback`
 *   card; „Ja“ = rollbackQueuedInstall (owner, signed rollback ticket). It is
 *   only offered on request (toolbox-actions.ts), never from a sync, and never
 *   gets „Immer erlauben“ (rollback is excluded from standing permissions).
 *
 * P9 „ein Knopf-Rahmen“: `/patch approve`, `/setup approve` and the Skill-Forge
 * only (re)send these cards (`offerCard`); the old Telegram callbacks
 * `patch_ok/no`, `skill_ok/no` and `ni:` are refused with „bitte neue Karte“.
 *
 * Delivery: only a Main with a live Telegram adapter sends; a worker
 * (`NOVA_NODE_ONLY=true`) never sends — its proposals reach the Main via mesh.
 */
import {
    cardKeyboard, createApprovalCard, formatCardText, formatCardTextShort, listApprovalCards, maintainApprovalCards, recordCardDelivery,
    registerCardExecutor, requestCardRedelivery, type ApprovalCard, type CardExecutor, type CardStoreOptions, type NewCardInput,
} from './approval-cards.js'
import { approveQueuedInstall, loadInstallQueue, rollbackQueuedInstall, type InstallProposal, type InstallQueueDeps } from '../install/install-queue.js'
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
        // A standing permission is meaningful per catalog entry (P9: stored in trust.json).
        allowAlways: () => true,
        standingSubject: card => proposal(card)?.catalogId ?? null,
        async execute(card, _answer, ctx) {
            const deps = getDeps()
            const approver = { permission: 'owner', principalId: ctx.decidedBy, channel: 'telegram' }
            const result = await approveQueuedInstall(card.aktion.ref, approver, deps)
            // The trust ladder counts the real outcome on the host, not the accepted ticket.
            const completion = result.ok && result.completion
                ? result.completion.then(item => ({ ok: item?.status === 'done', rolledBack: item?.status === 'rolled-back' }))
                : undefined
            return { ok: result.ok, message: result.message, ...(completion ? { completion } : {}) }
        },
        isStillOpen(card) {
            try { return proposal(card)?.status === 'queued' } catch { return true }
        },
    }
}

/** 2.85 Paket D: „Entfernen“ from the Werkzeugkasten — the existing owner rollback, after „Ja“ only. */
export function createInstallRollbackExecutor(getDeps: () => InstallQueueDeps): CardExecutor {
    const proposal = (card: ApprovalCard) => loadInstallQueue(getDeps()).find(item => item.id === card.aktion.ref)
    return {
        kind: 'install-rollback',
        impact: 'intern',
        allowAlways: () => false,
        async execute(card, _answer, ctx) {
            const approver = { permission: 'owner', principalId: ctx.decidedBy, channel: 'karte' }
            const result = await rollbackQueuedInstall(card.aktion.ref, approver, getDeps())
            const completion = result.ok && result.completion
                ? result.completion.then(item => ({ ok: item?.status === 'rolled-back' }))
                : undefined
            return { ok: result.ok, message: result.message, ...(completion ? { completion } : {}) }
        },
        async reject() {
            return { ok: true, message: 'Bleibt installiert.' }
        },
        isStillOpen(card) {
            try { return proposal(card)?.status === 'done' } catch { return true }
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

export function createPatchExecutor(getProposals: () => any[]): CardExecutor {
    const find = (card: ApprovalCard) => getProposals().find((item: any) => item?.id === card.aktion.ref)
    return {
        kind: 'patch',
        impact: 'intern',
        // Code changes never get a standing permission (PATCH_GATE, STUFENPLAN S3.2).
        allowAlways: () => false,
        async execute(card, _answer, ctx) {
            // The owner's press is the approval; the token proves the gate is configured.
            const token = process.env.NOVA_PATCH_GATE_TOKEN
            if (!token) return { ok: false, message: 'NOVA_PATCH_GATE_TOKEN ist nicht gesetzt — Patch nicht angewendet.' }
            const { approvePatchProposal } = await import('../synthesis/patch-gate.js')
            const result = await approvePatchProposal(card.aktion.ref, { approver: { permission: 'owner', principalId: ctx.decidedBy }, token })
            return { ok: result.ok, message: result.message }
        },
        async reject(card, ctx) {
            const { rejectPatchProposal } = await import('../synthesis/patch-gate.js')
            const result = await rejectPatchProposal(card.aktion.ref, { permission: 'owner', principalId: ctx.decidedBy })
            return { ok: result.ok, message: result.message }
        },
        isStillOpen(card) {
            try { const proposal = find(card); return !proposal || proposal.status === 'queued' } catch { return true }
        },
    }
}


// ---------------------------------------------------------------------------
// card builders (one text per source; used by the sync and by offerCard)
// ---------------------------------------------------------------------------

export function installCardInput(item: InstallProposal): NewCardInput {
    return {
        art: 'install', titel: `${item.catalogId} auf ${item.nodeId} installieren?`,
        beleg: `Installationskatalog-Eintrag ${item.catalogId}, Quelle ${item.source}, vorgeschlagen ${item.createdAt.slice(0, 16).replace('T', ' ')} UTC. Ausführung nur über signiertes Ticket an den Host-Agenten, mit Rückweg.`,
        vorschlag: `Installieren (Warteschlange ${item.id}).`,
        aktion: { kind: 'install', ref: item.id }, node: item.nodeId, quelle: 'stufe-2', dedupeKey: `install:${item.id}`, ablaufMs: DAY_MS,
    }
}

/** 2.85 Paket D: card for „Entfernen“ of a finished installation (Werkzeugkasten). */
export function installRollbackCardInput(item: InstallProposal): NewCardInput {
    return {
        art: 'install-rollback', titel: `${item.catalogId} auf ${item.nodeId} wieder entfernen?`,
        beleg: `Installiert über Warteschlange ${item.id} (Ticket ${item.ticketId || '–'}), abgeschlossen ${item.updatedAt.slice(0, 16).replace('T', ' ')} UTC. Der Host-Agent nimmt genau seinen aufgezeichneten Rückweg.`,
        vorschlag: `Rückgängig machen (Warteschlange ${item.id}).`,
        aktion: { kind: 'install-rollback', ref: item.id }, node: item.nodeId, quelle: 'werkzeugkasten', dedupeKey: `install-rollback:${item.id}`, ablaufMs: DAY_MS,
    }
}

export function patchCardInput(patch: any): NewCardInput {
    return {
        art: 'patch', titel: `Patch: ${short(patch.description || patch.file, 140)}`,
        beleg: `Datei ${short(patch.file, 120)}${patch.reason ? `, Grund: ${short(patch.reason, 200)}` : ''}; Sandbox ${patch.sandbox?.verified ? 'grün' : 'ohne Beleg'}${patch.kind === 'doctor-config' ? ' (Config-Patch)' : ''}.`,
        vorschlag: 'Über PATCH_GATE anwenden (Token, Sandbox-Belege, signierte Aktivierung).',
        aktion: { kind: 'patch', ref: patch.id }, quelle: 'patch-gate', dedupeKey: `patch:${patch.id}`, ablaufMs: 3 * DAY_MS,
    }
}


/**
 * P9 „ein Knopf-Rahmen“: create the card (or find the open one) and have the
 * card loop deliver it now — again, if it was already delivered. Commands like
 * `/patch approve` and `/setup approve` use this instead of acting themselves.
 */
export function offerCard(input: NewCardInput, opts: CardStoreOptions & { deliverNow?: boolean } = {}): { ok: true; card: ApprovalCard; created: boolean; message: string } | { ok: false; message: string } {
    const result = createApprovalCard(input, opts)
    if (!result.ok) return { ok: false, message: `Keine Karte möglich: ${(result as { reason: string }).reason}` }
    // Due now (never waits for the report) and — if already delivered — sent again with the same tokens.
    if (result.card.status === 'offen') requestCardRedelivery(result.card.id, opts)
    if (opts.deliverNow !== false) void runApprovalCardTick()
    return { ok: true, card: result.card, created: result.created, message: `🔘 Karte „${result.card.titel}“ ${result.created ? 'geschickt' : 'erneut geschickt'} — bitte dort Ja oder Nein drücken.` }
}

let builtinsRegistered = false

/** Registers install / self-heal / peer / patch executors. Tests pass their own deps. */
export function registerBuiltinCardExecutors(deps: BuiltinExecutorDeps): void {
    registerCardExecutor(createInstallExecutor(deps.installDeps))
    registerCardExecutor(createInstallRollbackExecutor(deps.installDeps))
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
    const { registerThoughtCardExecutor } = await import('./planner-card-bridge.js')
    registerThoughtCardExecutor()
    // Release-Knopf (Phase 6a): refuses every press while autonomy.releaseButton is off.
    const { registerReleaseButtonExecutor } = await import('./release-button.js')
    registerReleaseButtonExecutor()

    // Phase 6b: Verantwortung übernehmen (Ja/Nein) and Missions-Schritt (Ja = genau dieser Schritt).
    const { getResponsibilityRuntime } = await import('./responsibility-runtime.js')
    const { createResponsibilityCardExecutor } = await import('./responsibilities.js')
    const { createMissionCardExecutor } = await import('./missions.js')
    registerCardExecutor(createResponsibilityCardExecutor(() => getResponsibilityRuntime()?.responsibilities ?? null))
    registerCardExecutor(createMissionCardExecutor(() => getResponsibilityRuntime()?.missions ?? null))

    // Phase 6d: Ollama pull (after Ja) and vLLM switch (plan only, executor unwired).
    const { registerModelControlExecutors } = await import('../routing/local-model-control.js')
    registerModelControlExecutors(registerCardExecutor)

    // Phase 6c: Proxmox kinds (pve-*); each re-checks pool/tag/protection/cap before its single write.
    const { registerProxmoxCardExecutors } = await import('../infra/proxmox-command.js')
    registerProxmoxCardExecutors()

    // 2.85 Paket A: „Verbinden“ (one card = approval of the connection config).
    const { registerConnectCardExecutor } = await import('../connections/connect-flow.js')
    registerConnectCardExecutor()

    // 2.88: Tresor-Freigabe (entry × service) and Proxmox setup (fingerprint, pool) — each only after the owner's Ja.
    const { registerFreigabeExecutor } = await import('../secrets/tresor-cards.js')
    registerFreigabeExecutor()
    const { registerProxmoxSetupExecutors } = await import('../infra/proxmox-setup.js')
    registerProxmoxSetupExecutors()

    // 2.85.11 Paket L: „Gerät verbinden“ (HA login, Hue pairing, Tuya lokal/Cloud, Matter) — one card per device.
    const { createDeviceConnectExecutor, productionDeviceConnectDeps } = await import('../sensing/device-connect.js')
    const deviceDeps = await productionDeviceConnectDeps()
    registerCardExecutor(createDeviceConnectExecutor(deviceDeps))

    // 2.86 Paket N: preview → Ja → switch, „Rückgängig“, retry when reachable, room question, routines.
    const { createSchaltExecutor, productionSchaltDeps } = await import('../sensing/device-switch.js')
    const schaltDeps = await productionSchaltDeps()
    registerCardExecutor(createSchaltExecutor(schaltDeps))

    // 2.87 Paket P: Anruf an eine fremde Nummer (extern, kostet Guthaben) — erst das Ja wählt.
    const { createTelefonCardExecutor } = await import('../voice/telefon-ausgang.js')
    registerCardExecutor(createTelefonCardExecutor())
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
            if (!fresh(`install:${item.id}`)) continue
            add(installCardInput(item))
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
            if (!fresh(`patch:${patch.id}`)) continue
            add(patchCardInput(patch))
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
export async function deliverPendingCards(sender: CardSender, opts: CardStoreOptions & { bundleIntoReport?: boolean } = {}): Promise<number> {
    if (isWorkerNode()) return 0
    // P8: while the morning/evening report is on, non-time-critical cards wait for it (approval-cards.ts).
    const now = (opts.now || Date.now)()
    // Paket L: bundled cards (one message for many devices) are delivered by card-bundle.ts.
    // 2.86 Paket M: only ONE question at a time — the queue decides which card goes out now.
    const { planQuestions } = await import('./question-queue.js')
    const { isBundleVisible } = await import('./card-bundle.js')
    const open = listApprovalCards({ ...opts, status: 'offen' })
    const plan = new Set(planQuestions({ cards: open, bundleVisible: key => isBundleVisible(key, opts), bundleIntoReport: opts.bundleIntoReport, now }).karten)
    const pending = open.filter(card => plan.has(card.id))
    if (!pending.length) return 0
    if (!(await sender.canSend())) return 0
    const chats = sender.ownerChatIds().filter(id => /^\d{1,20}$/.test(id)).slice(0, 3)
    if (!chats.length) return 0
    let delivered = 0
    for (const card of pending) {
        const messages: Array<{ chatId: string; messageId: number }> = []
        for (const chatId of chats) {
            try {
                // Paket L: short text without technical ids; the full evidence behind „Details“.
                const { detailsButton } = await import('../channels/telegram-pages.js')
                const keyboard = [...cardKeyboard(card), [detailsButton(chatId, formatCardText(card), { dataDir: opts.dataDir, now: opts.now })]]
                const messageId = await sender.send(chatId, formatCardTextShort(card), keyboard)
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
        // P9: entries with a standing permission (trust.json) are installed before any card is made.
        try {
            const { runStandingInstalls } = await import('../install/install-queue.js')
            await runStandingInstalls(defaultInstallDeps())
        } catch (error) { console.warn(`[Knopf-Karten] Dauer-Erlaubnis-Installationen: ${short(error, 160)}`) }
        syncApprovalCardsFromSources({ dataDir: getNovaDataDir(), installDeps: defaultInstallDeps(), patchProposals: () => getPatchProposals(200), peers: () => peerList, nodeId: getLocalNodeId() })
        const { getTelegramAdapter } = await import('../channels/telegram.js')
        const tg = getTelegramAdapter()
        if (!tg) return
        let bundleIntoReport = false
        try {
            const { getPlannerRuntime } = await import('../planner/runtime.js')
            bundleIntoReport = getPlannerRuntime()?.settings.briefing.enabled === true
        } catch { bundleIntoReport = false }
        await deliverPendingCards({
            canSend: () => tg.hasCardAuthority(),
            ownerChatIds: () => tg.getOwnerChatIds(),
            send: (chatId, text, keyboard) => tg.sendApprovalCard(chatId, text, keyboard),
        }, { bundleIntoReport })
        // Paket L: related questions (found devices) as ONE message, edited instead of resent.
        const { deliverBundles } = await import('./card-bundle.js')
        await deliverBundles({
            canSend: () => tg.hasCardAuthority(),
            ownerChatIds: () => tg.getOwnerChatIds(),
            send: (chatId, text, keyboard) => tg.sendApprovalCard(chatId, text, keyboard),
            edit: (chatId, messageId, text, keyboard) => tg.editOwnerView(chatId, messageId, text, keyboard),
        })
        // 2.86 Paket M: pinned status message, example sentences after a new connection, one tip per day.
        try {
            const { runGuidedTelegramTick } = await import('../guided/guided-runtime.js')
            let timeZone: string | undefined
            try { timeZone = (await import('../planner/runtime.js')).getPlannerRuntime()?.settings.briefing.timeZone } catch { timeZone = undefined }
            await runGuidedTelegramTick({
                canSend: () => tg.hasCardAuthority(),
                ownerChatIds: () => tg.getOwnerChatIds(),
                send: (chatId, text, keyboard) => tg.sendApprovalCard(chatId, text, keyboard),
                edit: (chatId, messageId, text, keyboard) => tg.editOwnerView(chatId, messageId, text, keyboard),
                pin: (chatId, messageId) => tg.pinOwnerMessage(chatId, messageId),
            }, { timeZone })
        } catch (error) { console.warn(`[Knopf-Karten] Geführt: ${short(error, 160)}`) }
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
