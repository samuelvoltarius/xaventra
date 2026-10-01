/**
 * Phase 6d — Modellsteuerung lokal.
 *
 * (a) Ollama: special models (vision, embeddings, whisper …) are loaded per
 *     task through the Ollama HTTP API (`/api/generate` with `keep_alive`,
 *     `/api/ps`, `/api/tags`) and unloaded with `keep_alive: 0` — only on a node
 *     whose profile shows enough free memory, never next to a vLLM bottleneck
 *     (OOM 13.09.). A model that is not on the node is never pulled here:
 *     `/api/pull` is L2 and becomes a Knopf-Karte; only "Ja" pulls.
 * (b) vLLM at the Spark: ONLY a plan + card ("Für Aufgabe X wäre Modell Y
 *     besser, Wechsel ~N min, Rückweg automatisch"). The recipe is defined with
 *     snapshot → switch → probe → automatic way back, executed through a
 *     host-agent port after "Ja". In this build the production port is
 *     UNWIRED: no real vLLM control exists here.
 *
 * Network access only through the injected `OllamaPort`; tests pass mocks.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { createApprovalCard, type ApprovalCard, type CardExecutor, type CardStoreOptions } from '../core/approval-cards.js'
import type { NodeProfile } from '../core/node-profile.js'
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

export type VllmPlanStatus = 'geplant' | 'bestaetigt' | 'ausgefuehrt' | 'zurueckgerollt' | 'abgelehnt' | 'fehlgeschlagen'
export interface VllmSwitchPlan {
    id: string
    node: string
    taskClass: TaskModelClass
    currentModel: string
    targetModel: string
    estimatedMinutes: number
    evidence: string
    createdAt: string
    status: VllmPlanStatus
    cardId?: string
    result?: string
}

/** Recipe definition. Effect is not on the Nie-Liste (`vllm:stoppen` stays forbidden as a standalone action);
 * executing it needs the owner's "Ja" and a wired host agent (not in this build). */
export const VLLM_SWITCH_RECIPE = Object.freeze({
    id: 'vllm-modell-wechsel',
    level: 'nach-ja' as const,
    via: 'host-agent' as const,
    effects: Object.freeze(['host-agent:vllm-modell-wechseln']),
    steps: Object.freeze([
        { id: 'messen', text: 'Last messen: kein Wechsel während Training/Scout/hoher GPU-Last' },
        { id: 'sichern', text: 'Aktuelles Modell + Startparameter festhalten (Rückweg)' },
        { id: 'wechseln', text: 'vLLM über den Host-Agenten mit dem Zielmodell starten' },
        { id: 'pruefen', text: 'Probe: /v1/models listet das Ziel, Prüfanfrage beantwortet' },
        { id: 'rueckweg', text: 'Probe gescheitert → vorheriges Modell automatisch wieder starten' },
    ]),
})

export interface VllmSwitchExecutor {
    snapshot(plan: VllmSwitchPlan): Promise<{ model: string }>
    switchModel(plan: VllmSwitchPlan, model: string): Promise<boolean>
    probe(plan: VllmSwitchPlan): Promise<boolean>
    restore(plan: VllmSwitchPlan, snapshot: { model: string }): Promise<boolean>
}

class UnwiredError extends Error { constructor() { super('Host-Agent für vLLM-Wechsel in diesem Bau nicht verdrahtet') } }
/** Production executor of this build: refuses every step, so no vLLM is ever touched. */
export const UNWIRED_VLLM_EXECUTOR: VllmSwitchExecutor = Object.freeze({
    async snapshot() { throw new UnwiredError() },
    async switchModel() { throw new UnwiredError() },
    async probe() { throw new UnwiredError() },
    async restore() { throw new UnwiredError() },
})

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

export function planVllmSwitch(input: { node: string; taskClass: TaskModelClass; currentModel: string; targetModel: string; estimatedMinutes: number; evidence: string }, opts: CardStoreOptions = {}): { ok: true; plan: VllmSwitchPlan; card: ApprovalCard } | { ok: false; reason: string } {
    const minutes = Math.max(1, Math.round(Number(input.estimatedMinutes) || 10))
    if (!input.targetModel || input.targetModel === input.currentModel) return { ok: false, reason: 'Zielmodell fehlt oder ist schon aktiv' }
    const plan: VllmSwitchPlan = {
        id: `v${randomBytes(6).toString('hex')}`, node: input.node, taskClass: input.taskClass, currentModel: input.currentModel,
        targetModel: input.targetModel, estimatedMinutes: minutes, evidence: String(input.evidence || '').slice(0, 600),
        createdAt: new Date((opts.now || Date.now)()).toISOString(), status: 'geplant',
    }
    const label = TASK_CLASS_LABELS[input.taskClass]
    const card = createApprovalCard({
        art: 'modell-wechsel', titel: `vLLM-Modellwechsel auf ${input.node}: ${input.targetModel}?`,
        beleg: plan.evidence || 'kein Beleg angegeben',
        vorschlag: `Für Aufgabe ${label} wäre Modell ${input.targetModel} besser als ${input.currentModel}. Wechsel ~${minutes} min, Rückweg automatisch (Probe scheitert → ${input.currentModel} wieder starten).`,
        aktion: { kind: 'vllm-wechsel', ref: plan.id }, node: input.node, quelle: 'modellsteuerung',
        dedupeKey: `vllm-wechsel:${input.node}:${input.targetModel.toLowerCase()}`,
    }, opts)
    if (!card.ok) return { ok: false, reason: (card as { reason: string }).reason }
    const stored: VllmSwitchPlan = { ...plan, cardId: card.card.id }
    writeJsonList(planFile(opts.dataDir), controlDir(opts.dataDir), [...readVllmPlans(opts), stored])
    return { ok: true, plan: stored, card: card.card }
}

/** Runs the recipe. Refuses unless the approval is an answered card ("ja"/"immer") bound to this plan. */
export async function executeVllmSwitch(planId: string, approval: { status: string; ref: string }, executor: VllmSwitchExecutor, opts: Pick<CardStoreOptions, 'dataDir'> = {}): Promise<{ ok: boolean; message: string }> {
    const plan = readVllmPlans(opts).find(item => item.id === planId)
    if (!plan) return { ok: false, message: 'Plan unbekannt — nichts ausgeführt.' }
    if (!(approval?.status === 'ja' || approval?.status === 'immer') || approval.ref !== planId) return { ok: false, message: 'Kein Ja zu genau diesem Plan — nichts ausgeführt.' }
    if (plan.status !== 'geplant' && plan.status !== 'bestaetigt') return { ok: false, message: `Plan ist ${plan.status} — nichts ausgeführt.` }
    updatePlan(plan.id, { status: 'bestaetigt' }, opts.dataDir)
    let snapshot: { model: string }
    try { snapshot = await executor.snapshot(plan) } catch (error) {
        const message = String((error as Error)?.message || error)
        updatePlan(plan.id, { result: message }, opts.dataDir)
        return { ok: false, message: `Plan bestätigt; ${message} — kein vLLM-Eingriff.` }
    }
    try {
        const switched = await executor.switchModel(plan, plan.targetModel)
        const healthy = switched && await executor.probe(plan)
        if (healthy) {
            updatePlan(plan.id, { status: 'ausgefuehrt', result: `${plan.targetModel} aktiv, Probe bestanden` }, opts.dataDir)
            return { ok: true, message: `${plan.targetModel} läuft auf ${plan.node}, Probe bestanden.` }
        }
    } catch { /* fall through to the way back */ }
    let restored = false
    try { restored = await executor.restore(plan, snapshot) } catch { restored = false }
    updatePlan(plan.id, { status: restored ? 'zurueckgerollt' : 'fehlgeschlagen', result: restored ? `Probe gescheitert, ${snapshot.model} wiederhergestellt` : 'Probe und Rückweg gescheitert' }, opts.dataDir)
    return { ok: false, message: restored ? `Wechsel gescheitert, Rückweg ausgeführt: ${snapshot.model} läuft wieder.` : 'Wechsel und Rückweg gescheitert — bitte prüfen.' }
}

export function createVllmSwitchCardExecutor(deps: { executor: VllmSwitchExecutor; dataDir?: string }): CardExecutor {
    return {
        kind: 'vllm-wechsel',
        impact: 'intern',
        async execute(card) {
            return executeVllmSwitch(card.aktion.ref, { status: card.status, ref: card.aktion.ref }, deps.executor, { dataDir: deps.dataDir })
        },
        async reject(card) {
            updatePlan(card.aktion.ref, { status: 'abgelehnt' }, deps.dataDir)
            return { ok: true, message: 'Abgelehnt — vLLM bleibt unverändert.' }
        },
    }
}

/** Production wiring: real Ollama HTTP port for pulls after "Ja"; vLLM executor unwired. */
export function registerModelControlExecutors(register: (executor: CardExecutor) => void): void {
    register(createOllamaPullExecutor({ port: createOllamaHttpPort() }))
    register(createVllmSwitchCardExecutor({ executor: UNWIRED_VLLM_EXECUTOR }))
}
