/**
 * Phase 6d — Modellsteuerung lokal.
 *
 * (a) Ollama: special models (vision, embeddings, whisper …) are loaded per
 *     task through the Ollama HTTP API (`/api/generate` with `keep_alive`,
 *     `/api/ps`, `/api/tags`) and unloaded with `keep_alive: 0` — only on a node
 *     whose profile shows enough free memory, never next to a vLLM bottleneck
 *     (OOM 13.09.). A model that is not on the node is never pulled here:
 *     `/api/pull` is L2 and becomes a Knopf-Karte; only "Ja" pulls.
 * (b) vLLM at the Spark: plan + card ("Für Aufgabe X wäre Modell Y besser,
 *     Wechsel ~15 min, Rückweg automatisch"). After the owner's "Ja" (never
 *     "immer") the recipe runs through the host agent (src/routing/vllm-switch.ts,
 *     src/host/vllm-agent.ts) — only when that recipe is configured; otherwise
 *     an honest refusal "Host-Agent nicht eingerichtet". Alfred 01.10.2026.
 *
 * Network access only through the injected `OllamaPort`; tests pass mocks.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { createApprovalCard, type ApprovalCard, type CardExecutor, type CardStoreOptions } from '../core/approval-cards.js'
import type { NodeProfile } from '../core/node-profile.js'
import { recordActionOutcome } from '../core/action-policy.js'
import { isAllowedVllmTarget, issueVllmTicket, normalizeVllmTargets } from '../install/vllm-ticket.js'
import { checkVllmSwitchPreconditions, createVllmHttpProbe, defaultVllmBusyCheck, readVllmTargetsFromConfig, startVllmSwitch, VLLM_SWITCH_MINUTES, type VllmHostClient, type VllmSwitchOutcome, type VllmSwitchRuntime } from './vllm-switch.js'
import { TASK_CLASS_LABELS, type TaskModelClass } from './task-model-routing.js'

const GIB = 1024 ** 3
/** Free memory that must remain after loading on an ordinary node. */
export const OLLAMA_RESERVE_BYTES = 4 * GIB
/** On the vLLM node (unified memory, GB10) twice the scout runtime reserve must remain. */
export const VLLM_NODE_RESERVE_BYTES = 16 * GIB
export const DEFAULT_KEEP_ALIVE = '10m'

/** Action levels of this module (Verantwortungsstufen: L1 selbst, L2 Karte). */
export const MODEL_CONTROL_LEVELS = Object.freeze({
    'ollama-laden': 'L1', 'ollama-entladen': 'L1', 'ollama-pull': 'L2', 'vllm-wechsel': 'L2',
} as const)

// ---------------------------------------------------------------------------
// Ollama port (HTTP API)
// ---------------------------------------------------------------------------

export interface OllamaPort {
    tags(baseUrl: string): Promise<Array<{ name: string; sizeBytes: number }>>
    ps(baseUrl: string): Promise<Array<{ name: string; sizeBytes: number }>>
    /** POST /api/generate { model, keep_alive } without prompt: load (duration) or unload (0). */
    keepAlive(baseUrl: string, model: string, keepAlive: string | number): Promise<void>
    pull(baseUrl: string, model: string): Promise<void>
}

const trimBase = (baseUrl: string) => String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')

export function createOllamaHttpPort(options: { fetchImpl?: typeof fetch; timeoutMs?: number; pullTimeoutMs?: number } = {}): OllamaPort {
    const doFetch = options.fetchImpl || fetch
    const call = async (url: string, init: RequestInit | undefined, timeoutMs: number) => {
        const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) throw new Error(`Ollama ${new URL(url).pathname}: HTTP ${response.status}`)
        return response
    }
    const timeout = options.timeoutMs ?? 15_000
    const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return {
        async tags(baseUrl) {
            const json: any = await (await call(`${trimBase(baseUrl)}/api/tags`, undefined, timeout)).json()
            return (json?.models || []).map((item: any) => ({ name: String(item?.name || item?.model || ''), sizeBytes: Number(item?.size) || 0 })).filter((item: any) => item.name)
        },
        async ps(baseUrl) {
            const json: any = await (await call(`${trimBase(baseUrl)}/api/ps`, undefined, timeout)).json()
            return (json?.models || []).map((item: any) => ({ name: String(item?.name || item?.model || ''), sizeBytes: Number(item?.size_vram || item?.size) || 0 })).filter((item: any) => item.name)
        },
        async keepAlive(baseUrl, model, keepAlive) {
            await call(`${trimBase(baseUrl)}/api/generate`, post({ model, keep_alive: keepAlive }), Math.max(timeout, 120_000))
        },
        async pull(baseUrl, model) {
            await call(`${trimBase(baseUrl)}/api/pull`, post({ model, stream: false }), options.pullTimeoutMs ?? 60 * 60_000)
        },
    }
}

// ---------------------------------------------------------------------------
// Memory guard
// ---------------------------------------------------------------------------

export interface NodeMemoryView {
    nodeId: string
    totalBytes: number
    freeBytes: number
    memoryStatus: 'ok' | 'warn' | 'crit' | 'unbekannt'
    /** GPU of this node is used by vLLM (Knotenprofil `gpu.viaVllm`). */
    vllmNode: boolean
}

/** Free memory from the node profile ("NN % frei" of the memory self-check). null = unknown. */
export function nodeMemoryFromProfile(profile: Pick<NodeProfile, 'nodeId' | 'ramGB' | 'gpu' | 'selfCheck'> | null | undefined): NodeMemoryView | null {
    if (!profile || !(profile.ramGB > 0)) return null
    const item = (profile.selfCheck?.items || []).find(entry => entry.id === 'memory')
    const match = item ? /(\d+(?:[.,]\d+)?)\s*%\s*frei/i.exec(item.detail || '') : null
    if (!item || !match) return null
    const totalBytes = profile.ramGB * GIB
    const freePct = Math.max(0, Math.min(100, Number(match[1].replace(',', '.'))))
    return {
        nodeId: profile.nodeId, totalBytes, freeBytes: Math.round(totalBytes * freePct / 100),
        memoryStatus: item.status === 'ok' || item.status === 'warn' || item.status === 'crit' ? item.status : 'unbekannt',
        vllmNode: profile.gpu?.viaVllm === true,
    }
}

export function judgeOllamaLoad(memory: NodeMemoryView | null, modelBytes: number): { ok: boolean; reason: string } {
    if (!memory) return { ok: false, reason: 'Speicher des Knotens unbekannt (kein Knotenprofil) — nicht geladen' }
    const size = Math.max(0, Number(modelBytes) || 0)
    if (!(size > 0)) return { ok: false, reason: 'Modellgröße unbekannt — nicht geladen' }
    const gib = (value: number) => `${(value / GIB).toFixed(1)} GB`
    if (memory.vllmNode && memory.memoryStatus !== 'ok') return { ok: false, reason: `vLLM-Knoten mit Speicher ${memory.memoryStatus} — nie neben vLLM-Engpass laden (OOM 13.09.)` }
    if (memory.memoryStatus === 'crit') return { ok: false, reason: 'Arbeitsspeicher kritisch — nicht geladen' }
    const reserve = memory.vllmNode ? VLLM_NODE_RESERVE_BYTES : OLLAMA_RESERVE_BYTES
    const after = memory.freeBytes - size
    if (after < reserve) return { ok: false, reason: `zu wenig frei: ${gib(memory.freeBytes)} frei, Modell ${gib(size)}, Reserve ${gib(reserve)}${memory.vllmNode ? ' (vLLM-Knoten)' : ''}` }
    return { ok: true, reason: `${gib(memory.freeBytes)} frei, Modell ${gib(size)}, danach ${gib(after)} ≥ Reserve ${gib(reserve)}` }
}

// ---------------------------------------------------------------------------
// Ollama: ensure / unload / pull request
// ---------------------------------------------------------------------------

export interface OllamaModelRequest { node: string; baseUrl: string; model: string; taskClass: TaskModelClass; keepAlive?: string | number }
export type OllamaEnsureStatus = 'geladen' | 'schon-geladen' | 'zu-wenig-speicher' | 'pull-karte' | 'fehler'
export interface OllamaEnsureResult { status: OllamaEnsureStatus; reason: string; cardId?: string }

const sameName = (a: string, b: string) => {
    const norm = (value: string) => value.trim().toLowerCase()
    const left = norm(a), right = norm(b)
    return left === right || left === `${right}:latest` || right === `${left}:latest`
}

export async function ensureOllamaModel(request: OllamaModelRequest, deps: { port: OllamaPort; memory: NodeMemoryView | null; cards?: CardStoreOptions }): Promise<OllamaEnsureResult> {
    try {
        const loaded = await deps.port.ps(request.baseUrl)
        if (loaded.some(item => sameName(item.name, request.model))) return { status: 'schon-geladen', reason: `${request.model} ist auf ${request.node} schon geladen` }
        const present = (await deps.port.tags(request.baseUrl)).find(item => sameName(item.name, request.model))
        if (!present) {
            const card = requestOllamaPull(request, deps.cards)
            return card.ok
                ? { status: 'pull-karte', reason: `${request.model} fehlt auf ${request.node}; Ziehen ist L2 → Karte`, cardId: card.card.id }
                : { status: 'fehler', reason: `Karte nicht möglich: ${(card as { reason: string }).reason}` }
        }
        const verdict = judgeOllamaLoad(deps.memory, present.sizeBytes)
        if (!verdict.ok) return { status: 'zu-wenig-speicher', reason: verdict.reason }
        await deps.port.keepAlive(request.baseUrl, present.name, request.keepAlive ?? DEFAULT_KEEP_ALIVE)
        return { status: 'geladen', reason: `${present.name} auf ${request.node} geladen (${verdict.reason})` }
    } catch (error) {
        return { status: 'fehler', reason: String((error as Error)?.message || error).slice(0, 200) }
    }
}

export async function unloadOllamaModel(baseUrl: string, model: string, port: OllamaPort): Promise<void> {
    await port.keepAlive(baseUrl, model, 0)
}

interface PullRequestEntry { id: string; node: string; baseUrl: string; model: string; taskClass: TaskModelClass; createdAt: string; status: 'offen' | 'gezogen' | 'abgelehnt' | 'fehler'; result?: string }

const controlDir = (dataDir?: string) => dataDir ? join(dataDir, 'model-control') : getNovaDataDir('model-control')
const pullFile = (dataDir?: string) => join(controlDir(dataDir), 'pull-requests.json')
const planFile = (dataDir?: string) => join(controlDir(dataDir), 'vllm-plans.json')

function readJsonList<T>(file: string): T[] {
    try { const raw = JSON.parse(readFileSync(file, 'utf8')); return raw?.version === 1 && Array.isArray(raw.items) ? raw.items : [] } catch { return [] }
}
function writeJsonList<T>(file: string, dir: string, items: T[]): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file, { version: 1, items: items.slice(-200) })
}

export function requestOllamaPull(request: OllamaModelRequest, cards: CardStoreOptions = {}): { ok: true; card: ApprovalCard } | { ok: false; reason: string } {
    const items = readJsonList<PullRequestEntry>(pullFile(cards.dataDir))
    const existing = items.find(item => item.status === 'offen' && item.node === request.node && sameName(item.model, request.model))
    const entry: PullRequestEntry = existing || {
        id: `p${randomBytes(6).toString('hex')}`, node: request.node, baseUrl: request.baseUrl, model: request.model,
        taskClass: request.taskClass, createdAt: new Date((cards.now || Date.now)()).toISOString(), status: 'offen',
    }
    if (!existing) writeJsonList(pullFile(cards.dataDir), controlDir(cards.dataDir), [...items, entry])
    const result = createApprovalCard({
        art: 'modell-pull', titel: `Modell ${request.model} auf ${request.node} ziehen?`,
        beleg: `Für ${TASK_CLASS_LABELS[request.taskClass]} gebraucht; auf ${request.node} nicht vorhanden (Ollama /api/tags).`,
        vorschlag: `Ollama-Modell ${request.model} auf ${request.node} herunterladen (/api/pull). Danach lade ich es nur bei genug freiem Speicher.`,
        aktion: { kind: 'ollama-pull', ref: entry.id }, node: request.node, quelle: 'modellsteuerung',
        dedupeKey: `ollama-pull:${request.node}:${request.model.toLowerCase()}`,
    }, cards)
    return result.ok ? { ok: true, card: result.card } : { ok: false, reason: (result as { reason: string }).reason }
}

/** Card executor for `ollama-pull`: runs only after the owner's "Ja" (answerApprovalCard). */
export function createOllamaPullExecutor(deps: { port: OllamaPort; dataDir?: string }): CardExecutor {
    const update = (id: string, patch: Partial<PullRequestEntry>) => {
        const items = readJsonList<PullRequestEntry>(pullFile(deps.dataDir))
        const index = items.findIndex(item => item.id === id)
        if (index >= 0) { items[index] = { ...items[index], ...patch }; writeJsonList(pullFile(deps.dataDir), controlDir(deps.dataDir), items) }
        return index >= 0 ? items[index] : undefined
    }
    return {
        kind: 'ollama-pull',
        impact: 'intern',
        async execute(card) {
            const entry = readJsonList<PullRequestEntry>(pullFile(deps.dataDir)).find(item => item.id === card.aktion.ref)
            if (!entry || entry.status !== 'offen') return { ok: false, message: 'Pull-Auftrag unbekannt oder schon erledigt — nichts gezogen.' }
            try {
                await deps.port.pull(entry.baseUrl, entry.model)
                update(entry.id, { status: 'gezogen', result: 'ok' })
                return { ok: true, message: `${entry.model} auf ${entry.node} gezogen. Geladen wird es nur bei genug freiem Speicher.` }
            } catch (error) {
                const message = String((error as Error)?.message || error).slice(0, 200)
                update(entry.id, { status: 'fehler', result: message })
                return { ok: false, message: `Ziehen fehlgeschlagen: ${message}` }
            }
        },
        async reject(card) {
            update(card.aktion.ref, { status: 'abgelehnt' })
            return { ok: true, message: 'Abgelehnt — nichts gezogen.' }
        },
    }
}

// ---------------------------------------------------------------------------
// vLLM switch at the Spark: plan + card + recipe (executor via host agent)
// ---------------------------------------------------------------------------

export type VllmPlanStatus = 'geplant' | 'bestaetigt' | 'laeuft' | 'ausgefuehrt' | 'zurueckgerollt' | 'abgelehnt' | 'nicht-ausgefuehrt' | 'fehlgeschlagen'
export interface VllmSwitchPlan {
    id: string
    node: string
    taskClass: TaskModelClass
    currentModel: string
    /** Target name from the closed list (spark-models.sh), never free text. */
    targetModel: string
    estimatedMinutes: number
    evidence: string
    createdAt: string
    status: VllmPlanStatus
    /** vLLM base URL of the node (probe + "Modellwechsel läuft" hold). */
    baseUrl?: string
    cardId?: string
    approvedBy?: string
    result?: string
}

/** Recipe definition (Alfred 01.10.2026: switch allowed as card with automatic way back).
 * The effect is not on the Nie-Liste; `vllm:stoppen` stays forbidden as a standalone action.
 * Executed only after the owner's "Ja" (never "immer") through the host agent. */
export const VLLM_SWITCH_RECIPE = Object.freeze({
    id: 'vllm-modell-wechsel',
    level: 'nach-ja' as const,
    via: 'host-agent' as const,
    effects: Object.freeze(['host-agent:vllm-modell-wechseln']),
    steps: Object.freeze([
        { id: 'messen', text: 'Vorbedingungen: keine Wartungsmarke, kein laufender Wechsel, keine LLM-Aufgaben, Speicher nicht kritisch' },
        { id: 'sichern', text: 'Altes Ziel lesen, Wartungsmarke setzen (Wächter hält still)' },
        { id: 'wechseln', text: 'spark-models.sh switch <ziel> abgekoppelt über den Host-Agenten (fester argv, Einmal-Ticket)' },
        { id: 'pruefen', text: 'Bis 15 min: Neustart gesehen, /v1/models listet die erwartete ID, Mini-Chat-Probe beantwortet' },
        { id: 'rueckweg', text: 'Sonst automatisch switch <alt>, warten bis alt antwortet; scheitert auch das: Marke weg, Wächter übernimmt, dringende Meldung' },
    ]),
})

/** Honest refusal when the host-agent recipe is not configured on this node. */
export const VLLM_HOST_AGENT_MISSING = 'Host-Agent nicht eingerichtet (vLLM-Wechsel am Spark: Ticket-Schlüssel, Host-Agent-Socket und vllm-Abschnitt der Host-Konfiguration nötig, siehe docs/VLLM_SWITCH.md) — kein vLLM-Eingriff.'

/** Resolves the runtime for one plan, or an honest refusal. */
export type VllmRuntimeResolver = (plan: Pick<VllmSwitchPlan, 'id' | 'node' | 'baseUrl'>) => Promise<VllmSwitchRuntime | { refusal: string }>

export function readVllmPlans(opts: Pick<CardStoreOptions, 'dataDir'> = {}): VllmSwitchPlan[] {
    return readJsonList<VllmSwitchPlan>(planFile(opts.dataDir))
}
function updatePlan(id: string, patch: Partial<VllmSwitchPlan>, dataDir?: string): VllmSwitchPlan | undefined {
    const items = readJsonList<VllmSwitchPlan>(planFile(dataDir))
    const index = items.findIndex(item => item.id === id)
    if (index < 0) return undefined
    items[index] = { ...items[index], ...patch }
    writeJsonList(planFile(dataDir), controlDir(dataDir), items)
    return items[index]
}

export interface VllmPlanInput { node: string; taskClass: TaskModelClass; currentModel: string; targetModel: string; estimatedMinutes?: number; evidence: string; baseUrl?: string; targets?: readonly string[] }

/** Card creation only (no live checks). Target must be on the closed list. */
export function planVllmSwitch(input: VllmPlanInput, opts: CardStoreOptions = {}): { ok: true; plan: VllmSwitchPlan; card: ApprovalCard } | { ok: false; reason: string } {
    const targets = normalizeVllmTargets(input.targets)
    const minutes = Math.max(1, Math.round(Number(input.estimatedMinutes) || VLLM_SWITCH_MINUTES))
    if (!isAllowedVllmTarget(input.targetModel, targets)) return { ok: false, reason: `Ziel „${String(input.targetModel || '').slice(0, 40)}“ ist nicht auf der Liste (${targets.join(', ')})` }
    if (input.targetModel === input.currentModel) return { ok: false, reason: 'Zielmodell ist schon aktiv' }
    const plan: VllmSwitchPlan = {
        id: `v${randomBytes(6).toString('hex')}`, node: input.node, taskClass: input.taskClass, currentModel: String(input.currentModel || '').slice(0, 80),
        targetModel: input.targetModel, estimatedMinutes: minutes, evidence: String(input.evidence || '').slice(0, 600),
        createdAt: new Date((opts.now || Date.now)()).toISOString(), status: 'geplant',
        ...(input.baseUrl ? { baseUrl: String(input.baseUrl).slice(0, 200) } : {}),
    }
    const label = TASK_CLASS_LABELS[input.taskClass]
    const card = createApprovalCard({
        art: 'modell-wechsel', titel: `vLLM-Modellwechsel auf ${input.node}: ${input.targetModel}?`,
        beleg: plan.evidence || 'kein Beleg angegeben',
        vorschlag: `Für Aufgabe ${label} wäre Modell ${input.targetModel} besser als ${plan.currentModel}. Wechsel ~${minutes} min ohne lokales LLM, Rückweg automatisch (Probe scheitert → ${plan.currentModel} wieder starten).`,
        aktion: { kind: 'vllm-wechsel', ref: plan.id }, node: input.node, quelle: 'modellsteuerung',
        effects: [...VLLM_SWITCH_RECIPE.effects],
        dedupeKey: `vllm-wechsel:${input.node}:${input.targetModel.toLowerCase()}`,
    }, opts)
    if (!card.ok) return { ok: false, reason: (card as { reason: string }).reason }
    const stored: VllmSwitchPlan = { ...plan, cardId: card.card.id }
    writeJsonList(planFile(opts.dataDir), controlDir(opts.dataDir), [...readVllmPlans(opts), stored])
    return { ok: true, plan: stored, card: card.card }
}

/** Card with live preconditions: no card while the host agent is missing, a marker is set, the LLM is busy … */
export async function proposeVllmSwitch(input: Omit<VllmPlanInput, 'currentModel' | 'targets'>, deps: { resolveRuntime: VllmRuntimeResolver; cards?: CardStoreOptions }): Promise<{ ok: true; plan: VllmSwitchPlan; card: ApprovalCard } | { ok: false; reason: string }> {
    const runtime = await deps.resolveRuntime({ id: 'v000000000000', node: input.node, baseUrl: input.baseUrl })
    if ('refusal' in runtime) return { ok: false, reason: runtime.refusal }
    if (runtime.nodeId !== input.node) return { ok: false, reason: `Host-Agent gehört zu ${runtime.nodeId}, vLLM-Endpunkt zu ${input.node}` }
    const pre = await checkVllmSwitchPreconditions(input.targetModel, runtime)
    if (!pre.ok) return { ok: false, reason: (pre as { reason: string }).reason }
    return planVllmSwitch({ ...input, currentModel: pre.state.currentTarget || '?', targets: runtime.targets }, deps.cards)
}

/**
 * Runs the recipe after the owner's "Ja". Refuses unless the approval is an
 * answered card with "ja" (never "immer") bound to this plan. Preflight and
 * marker run before this returns; the switch finishes in `done`.
 */
export async function executeVllmSwitch(planId: string, approval: { status: string; ref: string; approvedBy?: string }, resolveRuntime: VllmRuntimeResolver, opts: Pick<CardStoreOptions, 'dataDir'> = {}): Promise<{ ok: boolean; message: string; done?: Promise<VllmSwitchOutcome> }> {
    const plan = readVllmPlans(opts).find(item => item.id === planId)
    if (!plan) return { ok: false, message: 'Plan unbekannt — nichts ausgeführt.' }
    if (approval?.status !== 'ja' || approval.ref !== planId) return { ok: false, message: 'Kein Ja zu genau diesem Plan — nichts ausgeführt (vLLM-Wechsel nie „immer“).' }
    if (!/^owner:[^\s]{1,120}$/.test(String(approval.approvedBy || ''))) return { ok: false, message: 'Freigabe nicht vom Owner — nichts ausgeführt.' }
    if (plan.status !== 'geplant' && plan.status !== 'bestaetigt') return { ok: false, message: `Plan ist ${plan.status} — nichts ausgeführt.` }
    updatePlan(plan.id, { status: 'bestaetigt', approvedBy: approval.approvedBy }, opts.dataDir)
    let runtime: VllmSwitchRuntime | { refusal: string }
    try { runtime = await resolveRuntime(plan) } catch (error) { runtime = { refusal: `Host-Agent nicht nutzbar: ${String((error as Error)?.message || error).slice(0, 120)}` } }
    if ('refusal' in runtime) {
        updatePlan(plan.id, { status: 'nicht-ausgefuehrt', result: runtime.refusal }, opts.dataDir)
        return { ok: false, message: runtime.refusal }
    }
    const start = await startVllmSwitch({ id: plan.id, node: plan.node, target: plan.targetModel, approvedBy: approval.approvedBy! }, runtime)
    if (!start.started) {
        const outcome = (start as { outcome: VllmSwitchOutcome }).outcome
        updatePlan(plan.id, { status: 'nicht-ausgefuehrt', result: outcome.message }, opts.dataDir)
        return { ok: false, message: outcome.message }
    }
    updatePlan(plan.id, { status: 'laeuft', result: start.message }, opts.dataDir)
    const done = start.done.then(outcome => {
        updatePlan(plan.id, { status: outcome.status, result: outcome.message.slice(0, 600) }, opts.dataDir)
        if (outcome.status !== 'nicht-ausgefuehrt') recordActionOutcome('vllm-wechsel', { ok: outcome.status === 'ausgefuehrt', rolledBack: outcome.status === 'zurueckgerollt' }, { dataDir: opts.dataDir })
        return outcome
    })
    done.catch(() => undefined)
    return { ok: true, message: start.message, done }
}

/** Card executor `vllm-wechsel`: no allowAlways — "Immer erlauben" never exists for a vLLM switch. */
export function createVllmSwitchCardExecutor(deps: { resolveRuntime: VllmRuntimeResolver; dataDir?: string; onDone?: (outcome: VllmSwitchOutcome) => void }): CardExecutor {
    return {
        kind: 'vllm-wechsel',
        impact: 'intern',
        async execute(card, answer, ctx) {
            if (answer !== 'ja') return { ok: false, message: 'vLLM-Wechsel nur mit einzelnem Ja — nichts ausgeführt.' }
            const userId = String(ctx?.userId || '').trim()
            const result = await executeVllmSwitch(card.aktion.ref, { status: card.status, ref: card.aktion.ref, approvedBy: userId ? `owner:${userId}` : undefined }, deps.resolveRuntime, { dataDir: deps.dataDir })
            if (result.done && deps.onDone) result.done.then(deps.onDone, () => undefined)
            return { ok: result.ok, message: result.message }
        },
        async reject(card) {
            updatePlan(card.aktion.ref, { status: 'abgelehnt' }, deps.dataDir)
            return { ok: true, message: 'Abgelehnt — vLLM bleibt unverändert.' }
        },
    }
}

/** Production runtime: only when the host agent and its vLLM recipe are configured; otherwise an honest refusal. */
export async function resolveProductionVllmRuntime(plan: Pick<VllmSwitchPlan, 'id' | 'node' | 'baseUrl'>): Promise<VllmSwitchRuntime | { refusal: string }> {
    const env = process.env
    const keyFile = env.XAVENTRA_VLLM_TICKET_KEY_FILE || env.XAVENTRA_INSTALL_TICKET_KEY_FILE
    const nodeId = env.XAVENTRA_HOST_AGENT_NODE_ID, clientId = env.XAVENTRA_HOST_AGENT_CLIENT_ID
    if (!keyFile || !nodeId || !clientId || !env.XAVENTRA_HOST_AGENT_SOCKET || !env.XAVENTRA_HOST_AGENT_TOKEN_FILE || !existsSync(keyFile)) return { refusal: VLLM_HOST_AGENT_MISSING }
    let privateKey: string
    try { privateKey = readFileSync(keyFile, 'utf8') } catch { return { refusal: VLLM_HOST_AGENT_MISSING } }
    const { callHostAgent } = await import('../host/docker-client.js')
    const host: VllmHostClient = {
        state: async () => await callHostAgent('/v1/vllm/state', {}),
        action: async ticket => await callHostAgent('/v1/vllm/action', { ticket }),
    }
    const probe: any = await host.state().catch(() => null)
    if (!probe?.success) {
        const missing = !probe || probe.unavailable || /unsupported host operation/i.test(String(probe.error || ''))
        return { refusal: missing ? VLLM_HOST_AGENT_MISSING : `Host-Agent: ${String(probe.error || 'Zustand nicht lesbar').slice(0, 120)}` }
    }
    if (!plan.baseUrl) return { refusal: 'vLLM-Endpunkt des Plans unbekannt — kein Wechsel (ohne Probe kein Erfolg prüfbar).' }
    const config = (globalThis as any).__novaState?.config || {}
    const targets = readVllmTargetsFromConfig(config)
    const [{ envOpenAIKeyFor }, { addThought }, { profileForNode }] = await Promise.all([
        import('../llm/endpoint-trust.js'), import('../planner/index.js'), import('./model-runtime.js'),
    ])
    return {
        nodeId, targets, host, baseUrl: plan.baseUrl,
        endpoint: createVllmHttpProbe(plan.baseUrl, { apiKey: envOpenAIKeyFor(plan.baseUrl) }),
        issue: input => issueVllmTicket({ ...input, nodeId, clientId, targets }, privateKey),
        busy: defaultVllmBusyCheck,
        memory: async () => nodeMemoryFromProfile(await profileForNode(plan.node)),
        notify: (level, title, text) => {
            try {
                addThought({ source: 'modellsteuerung', title, evidence: text, kind: 'ereignis', severity: level === 'dringend' ? 'critical' : 'warning', node: plan.node, signature: `vllm-wechsel:${plan.id}:${title}` })
            } catch (error) { console.warn(`[vLLM-Wechsel] Meldung nicht zugestellt: ${String((error as Error)?.message || error).slice(0, 120)}`) }
        },
    }
}

/** Production wiring: real Ollama HTTP port for pulls after "Ja"; vLLM switch through the host agent (or honest refusal). */
export function registerModelControlExecutors(register: (executor: CardExecutor) => void): void {
    register(createOllamaPullExecutor({ port: createOllamaHttpPort() }))
    register(createVllmSwitchCardExecutor({ resolveRuntime: resolveProductionVllmRuntime }))
}
