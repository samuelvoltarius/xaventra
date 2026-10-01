/**
 * Phase 8 — vLLM-Modellwechsel am Spark (Alfred 01.10.2026: „Ein vLLM-
 * Modellwechsel am Spark darf laufen — als Knopf-Karte mit automatischem
 * Rückweg. ‚vLLM stoppen ohne Rückweg‘ bleibt auf der Nie-Liste.“).
 *
 * Ablauf nach dem „Ja“ auf der Karte `vllm-wechsel` (nie „immer“):
 *   1. Vorbedingungen (auch schon vor der Karte): Ziel auf der geschlossenen
 *      Liste, nicht schon aktiv, keine Wartungsmarke, kein laufender Wechsel,
 *      altes Ziel + beide Modell-IDs bekannt (sonst kein Rückweg), keine
 *      laufenden Aufgaben, die das LLM brauchen, Speicher nicht kritisch.
 *   2. Wartungsmarke setzen (der vLLM-Wächter funkt nicht dazwischen).
 *   3. `spark-models.sh switch <neu>` abgekoppelt über den Host-Agenten
 *      (fester argv, signiertes Einmal-Ticket an Plan, Ziel und Knoten).
 *   4. Bis zu 15 min pollen: Erfolg = neuer Container/Neustart gesehen UND
 *      `/v1/models` listet die erwartete ID UND eine Mini-Chat-Probe gelingt.
 *   5. Marke weg. Sonst Rückweg automatisch: `switch <alt>`, warten bis alt
 *      wieder antwortet, Meldung „zurückgerollt“ mit Grund. Scheitert auch
 *      das: Marke weg (der Wächter übernimmt) und dringender Gedanke.
 *
 * Alle Netz- und Host-Zugriffe laufen über injizierte Ports (Tests: Mocks).
 */
import type { NodeMemoryView } from './local-model-control.js'
import { clearActiveVllmSwitch, setActiveVllmSwitch } from './vllm-switch-state.js'
import { isAllowedVllmTarget, normalizeVllmTargets, type SignedVllmTicket, type VllmOperation, type VllmPurpose } from '../install/vllm-ticket.js'

export const VLLM_SWITCH_TIMEOUT_MS = 15 * 60_000
export const VLLM_RESTORE_TIMEOUT_MS = 15 * 60_000
export const VLLM_POLL_MS = 15_000
export const VLLM_PROBE_ATTEMPTS = 3
export const VLLM_SWITCH_MINUTES = 15

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

export interface VllmHostStateView {
    success?: boolean
    currentTarget: string | null
    maintenance: boolean
    ownMarkerPlan?: string | null
    modelIds: Record<string, string>
    switchRunning: boolean
    lastLaunch?: { ticketId: string; target: string; launchedAt: number; exitCode?: number | null }
    container?: { name: string; startedAt: string; running: boolean } | null
    error?: string
    unavailable?: boolean
}
export interface VllmHostClient {
    state(): Promise<VllmHostStateView>
    action(ticket: SignedVllmTicket): Promise<{ success?: boolean; error?: string; unavailable?: boolean; launchedAt?: number; [key: string]: unknown }>
}
export interface VllmEndpointProbe {
    /** Model ids from GET /v1/models; throws when vLLM does not answer. */
    models(): Promise<string[]>
    /** Mini chat (max 16 tokens); true when the model produced tokens. */
    chat(modelId: string): Promise<boolean>
}
export type VllmNoticeLevel = 'status' | 'info' | 'dringend'
export interface VllmSwitchRuntime {
    /** Node of the host agent (the ticket is bound to it). */
    nodeId: string
    targets: readonly string[]
    host: VllmHostClient
    endpoint: VllmEndpointProbe
    /** Signs one step ticket; plan id and owner approval are bound by the caller of this runtime. */
    issue(input: { operation: VllmOperation; purpose: VllmPurpose; target: string; planId: string; approvedBy: string }): SignedVllmTicket
    /** Reason when running owner tasks/missions need the LLM, else null. */
    busy(): Promise<string | null>
    memory(): Promise<NodeMemoryView | null>
    notify(level: VllmNoticeLevel, title: string, text: string): void
    baseUrl?: string
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    switchTimeoutMs?: number
    restoreTimeoutMs?: number
    pollMs?: number
}

// ---------------------------------------------------------------------------
// preconditions (card AND execution)
// ---------------------------------------------------------------------------

export interface VllmPreconditionInput {
    target: string
    targets: readonly string[]
    state: VllmHostStateView | null
    busy: string | null
    memory: NodeMemoryView | null
}

/** null = the switch may run; otherwise the honest reason. Pure. */
export function vllmSwitchRefusal(input: VllmPreconditionInput): string | null {
    if (!isAllowedVllmTarget(input.target, input.targets)) return `Ziel „${String(input.target).slice(0, 40)}“ ist nicht auf der Liste (${input.targets.join(', ')})`
    const state = input.state
    if (!state || state.success === false) return `Host-Agent-Zustand nicht lesbar${state?.error ? `: ${String(state.error).slice(0, 120)}` : ''}`
    if (state.maintenance) return 'Wartungsmarke gesetzt (geplante Wartung läuft) — kein Wechsel'
    if (state.switchRunning) return 'Ein Wechsel läuft bereits'
    if (state.currentTarget === input.target) return `${input.target} ist schon aktiv`
    if (!state.currentTarget || !isAllowedVllmTarget(state.currentTarget, input.targets)) return 'Aktuelles Ziel unbekannt — ohne Rückweg kein Wechsel'
    if (!state.modelIds?.[input.target]) return `Keine erwartete Modell-ID für ${input.target} (~/.spark-model-ids) — Erfolg nicht prüfbar`
    if (!state.modelIds?.[state.currentTarget]) return `Keine erwartete Modell-ID für ${state.currentTarget} — Rückweg nicht prüfbar`
    if (input.busy) return input.busy
    if (!input.memory) return 'Speicher des Knotens unbekannt (kein Knotenprofil) — kein Wechsel'
    if (input.memory.memoryStatus === 'crit') return 'Arbeitsspeicher kritisch — kein Wechsel (nie zwei Modelle gleichzeitig)'
    return null
}

/** Card-time check: reads the live state once. */
export async function checkVllmSwitchPreconditions(target: string, runtime: Pick<VllmSwitchRuntime, 'targets' | 'host' | 'busy' | 'memory'>): Promise<{ ok: true; state: VllmHostStateView } | { ok: false; reason: string }> {
    if (!isAllowedVllmTarget(target, runtime.targets)) return { ok: false, reason: vllmSwitchRefusal({ target, targets: runtime.targets, state: null, busy: null, memory: null })! }
    let state: VllmHostStateView | null = null
    try { state = await runtime.host.state() } catch (error) { return { ok: false, reason: `Host-Agent nicht erreichbar: ${String((error as Error)?.message || error).slice(0, 120)}` } }
    const [busy, memory] = await Promise.all([runtime.busy().catch(() => 'Aufgabenstand nicht lesbar — kein Wechsel'), runtime.memory().catch(() => null)])
    const reason = vllmSwitchRefusal({ target, targets: runtime.targets, state, busy, memory })
    return reason ? { ok: false, reason } : { ok: true, state: state! }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

export type VllmSwitchStatus = 'ausgefuehrt' | 'zurueckgerollt' | 'fehlgeschlagen' | 'nicht-ausgefuehrt'
export interface VllmSwitchOutcome { status: VllmSwitchStatus; message: string; reason?: string; from?: string; to: string }
export interface VllmSwitchPlanRef { id: string; node: string; target: string; approvedBy: string }
export type VllmSwitchStart =
    | { started: false; outcome: VllmSwitchOutcome }
    | { started: true; message: string; done: Promise<VllmSwitchOutcome> }

const errorText = (value: unknown) => String((value as Error)?.message || value).slice(0, 160)

/**
 * Preflight and marker synchronously (so the card answer is honest), the
 * switch itself in the background (`done`). Never throws.
 */
export async function startVllmSwitch(plan: VllmSwitchPlanRef, runtime: VllmSwitchRuntime): Promise<VllmSwitchStart> {
    const refuse = (reason: string): VllmSwitchStart => ({ started: false, outcome: { status: 'nicht-ausgefuehrt', message: `Nicht ausgeführt: ${reason}`, reason, to: plan.target } })
    const targets = normalizeVllmTargets(runtime.targets)
    if (!isAllowedVllmTarget(plan.target, targets)) return refuse(`Ziel „${String(plan.target).slice(0, 40)}“ ist nicht auf der Liste`)
    if (!/^owner:[^\s]{1,120}$/.test(String(plan.approvedBy || ''))) return refuse('kein Ja des Owners')
    if (plan.node !== runtime.nodeId) return refuse(`Host-Agent gehört zu ${runtime.nodeId}, Plan zu ${plan.node}`)
    const pre = await checkVllmSwitchPreconditions(plan.target, { ...runtime, targets })
    if (!pre.ok) return refuse((pre as { reason: string }).reason)
    const from = pre.state.currentTarget!
    const expected = { neu: pre.state.modelIds[plan.target], alt: pre.state.modelIds[from] }
    const ticket = (operation: VllmOperation, purpose: VllmPurpose, target: string) =>
        runtime.issue({ operation, purpose, target, planId: plan.id, approvedBy: plan.approvedBy })
    const step = async (operation: VllmOperation, purpose: VllmPurpose, target: string) => {
        try { return await runtime.host.action(ticket(operation, purpose, target)) } catch (error) { return { success: false, unavailable: true, error: errorText(error) } }
    }

    const marked = await step('markieren', 'wechsel', plan.target)
    if (!marked?.success) return refuse(`Wartungsmarke nicht gesetzt (${String(marked?.error || 'Host-Agent lehnte ab').slice(0, 120)}) — nichts geändert`)

    const now = runtime.now || Date.now
    const sleep = runtime.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const switchTimeout = runtime.switchTimeoutMs ?? VLLM_SWITCH_TIMEOUT_MS
    const restoreTimeout = runtime.restoreTimeoutMs ?? VLLM_RESTORE_TIMEOUT_MS
    const pollMs = runtime.pollMs ?? VLLM_POLL_MS
    // Wall clock on purpose: the LLM provider reads this hold with Date.now().
    const wall = Date.now()
    setActiveVllmSwitch({ planId: plan.id, node: plan.node, from, to: plan.target, baseUrl: runtime.baseUrl, startedAt: wall, until: wall + switchTimeout + restoreTimeout + 5 * 60_000 })
    runtime.notify('status', `Modellwechsel läuft: ${from} → ${plan.target}`,
        `vLLM auf ${plan.node}: ~${VLLM_SWITCH_MINUTES} min ohne lokales LLM. Anfragen bekommen in der Zeit eine klare Meldung; Privates geht nicht in die Cloud. Rückweg auf ${from} ist automatisch.`)

    async function waitFor(target: string, expectedId: string, launch: { launchedAt?: number }, timeoutMs: number, ticketTarget: string): Promise<{ ok: boolean; reason: string }> {
        const deadline = now() + timeoutMs
        const launchedAt = Number(launch.launchedAt) || 0
        let sawDown = false, probeFails = 0, last = 'keine Antwort'
        while (now() < deadline) {
            await sleep(pollMs)
            let ids: string[] | null = null
            try { ids = await runtime.endpoint.models() } catch { sawDown = true }
            let state: VllmHostStateView | null = null
            try { state = await runtime.host.state() } catch { state = null }
            if (state?.lastLaunch?.target === ticketTarget && state.switchRunning === false && typeof state.lastLaunch.exitCode === 'number' && state.lastLaunch.exitCode !== 0 && !ids?.includes(expectedId)) {
                return { ok: false, reason: `Wechsel-Skript endete mit Code ${state.lastLaunch.exitCode}` }
            }
            // The old model may still answer right after the launch (all ids may be equal): require a restart.
            const fresh = state?.container ? (Date.parse(state.container.startedAt) >= launchedAt && state.container.running) : state?.container === null ? false : sawDown
            if (state && state.currentTarget !== target) { last = `aktuelles Ziel ist ${state.currentTarget || 'unbekannt'}`; continue }
            if (!ids) { last = 'vLLM antwortet nicht'; continue }
            if (!ids.includes(expectedId)) { last = `/v1/models ohne ${expectedId}`; continue }
            if (!fresh) { last = 'noch kein Neustart gesehen'; continue }
            let probed = false
            try { probed = await runtime.endpoint.chat(expectedId) } catch { probed = false }
            if (probed) return { ok: true, reason: 'Probe bestanden' }
            probeFails++
            last = 'Prüfanfrage gescheitert'
            if (probeFails >= VLLM_PROBE_ATTEMPTS) return { ok: false, reason: `Prüfanfrage ${probeFails}× gescheitert` }
        }
        return { ok: false, reason: `Zeitüberschreitung nach ${Math.round(timeoutMs / 60_000)} min (${last})` }
    }

    const release = async (): Promise<string | null> => {
        const result = await step('freigeben', 'wechsel', plan.target)
        return result?.success ? null : String(result?.error || 'Host-Agent lehnte ab').slice(0, 120)
    }

    const done = (async (): Promise<VllmSwitchOutcome> => {
        try {
            const launched = await step('wechseln', 'wechsel', plan.target)
            let reason: string
            if (launched?.success) {
                const waited = await waitFor(plan.target, expected.neu, launched, switchTimeout, plan.target)
                if (waited.ok) {
                    const releaseError = await release()
                    if (releaseError) runtime.notify('dringend', 'vLLM-Wartungsmarke bleibt stehen', `${plan.target} läuft, aber die Wartungsmarke ließ sich nicht entfernen (${releaseError}). Der vLLM-Wächter greift erst nach Entfernen von ~/.spark-stage-saved-target wieder.`)
                    const message = `${plan.target} läuft auf ${plan.node} (${expected.neu}), Probe bestanden.${releaseError ? ' Achtung: Wartungsmarke blieb stehen.' : ''}`
                    runtime.notify('info', `Modellwechsel fertig: ${plan.target}`, message)
                    return { status: 'ausgefuehrt', message, from, to: plan.target }
                }
                reason = waited.reason
            } else if (!launched?.unavailable) {
                // Explicit refusal before the launch: nothing was switched.
                const why = String(launched?.error || 'Host-Agent lehnte ab').slice(0, 120)
                const releaseError = await release()
                if (releaseError) runtime.notify('dringend', 'vLLM-Wartungsmarke bleibt stehen', `Wechsel abgelehnt (${why}); Marke ließ sich nicht entfernen (${releaseError}).`)
                const message = `Wechsel nicht gestartet: ${why} — ${from} läuft unverändert.`
                runtime.notify('info', 'Modellwechsel nicht gestartet', message)
                return { status: 'nicht-ausgefuehrt', message, reason: why, from, to: plan.target }
            } else reason = `Start unklar (${String(launched?.error || 'Host-Agent nicht erreichbar').slice(0, 100)})`

            // Automatic way back.
            const back = await step('wechseln', 'rueckweg', from)
            const restored = back?.success ? await waitFor(from, expected.alt, back, restoreTimeout, from) : { ok: false, reason: String(back?.error || 'Rückweg nicht gestartet').slice(0, 120) }
            const releaseError = await release()
            if (restored.ok) {
                const message = `Wechsel auf ${plan.target} gescheitert (${reason}) — zurückgerollt: ${from} läuft wieder, Probe bestanden.${releaseError ? ` Achtung: Wartungsmarke blieb stehen (${releaseError}).` : ''}`
                runtime.notify(releaseError ? 'dringend' : 'info', `Modellwechsel zurückgerollt: ${from}`, message)
                return { status: 'zurueckgerollt', message, reason, from, to: plan.target }
            }
            const message = `Wechsel auf ${plan.target} gescheitert (${reason}) und Rückweg auf ${from} gescheitert (${restored.reason}). `
                + (releaseError ? `Wartungsmarke ließ sich NICHT entfernen (${releaseError}) — bitte ~/.spark-stage-saved-target prüfen.` : 'Wartungsmarke entfernt: der vLLM-Wächter übernimmt.')
            runtime.notify('dringend', 'vLLM-Wechsel und Rückweg gescheitert', message)
            return { status: 'fehlgeschlagen', message, reason, from, to: plan.target }
        } catch (error) {
            // Last line of defence: give the guard back its control.
            const releaseError = await release().catch(() => 'unbekannt')
            const message = `Wechsel abgebrochen (${errorText(error)}). ${releaseError ? `Wartungsmarke blieb stehen (${releaseError}).` : 'Wartungsmarke entfernt: der vLLM-Wächter übernimmt.'}`
            runtime.notify('dringend', 'vLLM-Wechsel abgebrochen', message)
            return { status: 'fehlgeschlagen', message, reason: errorText(error), from, to: plan.target }
        } finally {
            clearActiveVllmSwitch(plan.id)
        }
    })()
    return { started: true, message: `Wechsel ${from} → ${plan.target} gestartet (~${VLLM_SWITCH_MINUTES} min, Rückweg automatisch). Ergebnis kommt als Meldung.`, done }
}

// ---------------------------------------------------------------------------
// production ports
// ---------------------------------------------------------------------------

/** vLLM HTTP probe: /v1/models and a 16-token chat (reasoning models: thinking off, reasoning tokens count). */
export function createVllmHttpProbe(baseUrl: string, options: { fetchImpl?: typeof fetch; apiKey?: string; timeoutMs?: number } = {}): VllmEndpointProbe {
    const doFetch = options.fetchImpl || fetch
    const base = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) }
    const timeout = options.timeoutMs ?? 20_000
    return {
        async models() {
            const response = await doFetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(timeout) })
            if (!response.ok) throw Error(`HTTP ${response.status}`)
            const json: any = await response.json()
            return (Array.isArray(json?.data) ? json.data : []).map((item: any) => String(item?.id || '')).filter(Boolean)
        },
        async chat(modelId) {
            const body = (extension: boolean) => JSON.stringify({
                model: modelId, messages: [{ role: 'user', content: 'Antworte nur mit: OK' }], max_tokens: 16, temperature: 0,
                ...(extension ? { chat_template_kwargs: { enable_thinking: false } } : {}),
            })
            let response = await doFetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: body(true), signal: AbortSignal.timeout(timeout * 3) })
            if (response.status === 400) response = await doFetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: body(false), signal: AbortSignal.timeout(timeout * 3) })
            if (!response.ok) return false
            const json: any = await response.json()
            const choice = json?.choices?.[0]
            const text = String(choice?.message?.content || choice?.message?.reasoning_content || choice?.message?.reasoning || '')
            return Number(json?.usage?.completion_tokens) > 0 || text.trim().length > 0
        },
    }
}

/** Owner work that needs the LLM right now (missions, team runs, subagents, tasks). */
export async function defaultVllmBusyCheck(): Promise<string | null> {
    const reasons: string[] = []
    try {
        const { getActiveMission } = await import('../core/autonomous-executor.js')
        const mission: any = getActiveMission()
        if (mission && (mission.status === 'active' || mission.status === 'planning')) reasons.push(`Mission „${String(mission.goal || '').slice(0, 60)}“`)
    } catch { /* module not loaded */ }
    try {
        const { getActiveRuns } = await import('../agents/team-coordinator.js')
        const runs = getActiveRuns().length
        if (runs) reasons.push(`${runs} Team-Lauf/Läufe`)
    } catch { /* optional */ }
    try {
        const { listSubagents } = await import('../agents/subagent-orchestrator.js')
        const agents = listSubagents().filter(item => item.status === 'running' || item.status === 'pending').length
        if (agents) reasons.push(`${agents} Subagent(en)`)
    } catch { /* optional */ }
    try {
        const { getTaskQueue } = await import('../core/tasks.js')
        const tasks = getTaskQueue().getTasksByStatus('in_progress').length
        if (tasks) reasons.push(`${tasks} Aufgabe(n) in Arbeit`)
    } catch { /* optional */ }
    return reasons.length ? `Laufende Aufgaben brauchen das LLM: ${reasons.join(', ')} — Wechsel erst danach (~${VLLM_SWITCH_MINUTES} min ohne lokales LLM)` : null
}

export function readVllmTargetsFromConfig(config: any): string[] {
    return normalizeVllmTargets(config?.routing?.vllm?.targets)
}
