/**
 * Stufe 3 — production wiring of the self-heal engine: fence state, the
 * latest Nachtwache report, statfs, the live LLM runtime and mesh peers.
 *
 * Kept apart from `self-heal.ts` so the engine stays testable without the
 * mesh, the lease layer or the LLM runtime.
 */
import { statfsSync } from 'node:fs'
import type { CheckResult } from '../core/autonomy-loop.js'
import { getNovaDataDir } from '../core/data-root.js'
import {
    createSelfHealEngine, decideFenceGate, formatSelfHealStatus, getSelfHealMeshSummary, parseSelfHealSettings,
    setSelfHealSwitch, type EndpointController, type EndpointEntry, type FenceGate, type SelfHealMeshSummary, type SelfHealSettings,
} from './self-heal.js'
import { createDefaultRecipes, type DiskUsage } from './self-heal-recipes.js'

let settings: SelfHealSettings = parseSelfHealSettings(undefined)
let configuredNightwatchJournalDir: string | undefined

/** Called once by the daemon with `autonomy.selfHeal` from the config. */
export function setSelfHealConfig(raw: unknown, options: { nightwatchJournalDir?: string } = {}): void {
    settings = parseSelfHealSettings(raw)
    configuredNightwatchJournalDir = options.nightwatchJournalDir
}

export function getSelfHealSettings(): SelfHealSettings {
    return settings
}

export function statfsUsage(path: string): DiskUsage | null {
    try {
        const stats = statfsSync(path)
        const total = Number(stats.blocks) * Number(stats.bsize)
        if (!(total > 0)) return null
        const free = Number(stats.bavail) * Number(stats.bsize)
        // df semantics: used share of what non-root users can get.
        const used = (Number(stats.blocks) - Number(stats.bfree)) * Number(stats.bsize)
        return { usedPercent: Math.round((used / (used + free)) * 100), freeBytes: free, totalBytes: total }
    } catch {
        return null
    }
}

/** Window after an LLM-SDK failover in which self-heal never switches endpoints. */
export const FAILOVER_HOLD_MS = 10 * 60_000

/**
 * Abgrenzung (2.82.0): the endpoint recipe never switches while
 *   - a vLLM model switch is confirmed or running (vllm-switch plans),
 *   - the host agent reports the vLLM maintenance marker or a running switch,
 *   - the LLM SDK did its own failover within the last 10 minutes.
 * Those paths own the endpoint at that moment; two switchers fight otherwise.
 */
export async function endpointSwitchHold(deps: {
    plans?: () => Array<{ status: string; id: string }>
    hostState?: () => Promise<{ maintenance?: boolean; switchRunning?: boolean } | null>
    lastFailoverAt?: () => number
    now?: () => number
} = {}): Promise<string | null> {
    const now = (deps.now ?? Date.now)()
    try {
        const plans = deps.plans ? deps.plans() : (await import('../routing/local-model-control.js')).readVllmPlans()
        const running = plans.find(plan => plan.status === 'bestaetigt' || plan.status === 'laeuft')
        if (running) return `vLLM-Wechsel ${running.id} läuft (${running.status}) — kein Endpoint-Umschalten`
    } catch { /* no plans */ }
    try {
        const state = deps.hostState ? await deps.hostState() : await defaultHostState()
        if (state?.maintenance) return 'vLLM-Wartungsmarke gesetzt — kein Endpoint-Umschalten'
        if (state?.switchRunning) return 'vLLM-Wechsel läuft am Host — kein Endpoint-Umschalten'
    } catch { /* host agent optional */ }
    try {
        const at = deps.lastFailoverAt ? deps.lastFailoverAt() : (await import('../llm/nova-llm-sdk.js')).lastLlmFailoverAt()
        if (at > 0 && now - at < FAILOVER_HOLD_MS) return `LLM-Failover vor ${Math.round((now - at) / 60_000)} min — der Failover führt, kein Endpoint-Umschalten`
    } catch { /* sdk optional */ }
    return null
}

async function defaultHostState(): Promise<{ maintenance?: boolean; switchRunning?: boolean } | null> {
    if (!process.env.XAVENTRA_HOST_AGENT_SOCKET) return null
    const { callHostAgent } = await import('../host/docker-client.js')
    const state: any = await callHostAgent('/v1/vllm/state', {})
    return state?.success ? { maintenance: state.maintenance === true, switchRunning: state.switchRunning === true } : null
}

/** The live runtime: model id + switchModel with an exact endpoint. */
export function createRuntimeEndpointController(): EndpointController {
    const llm = () => (globalThis as any).__novaState?.llm
    return {
        hold: () => endpointSwitchHold(),
        currentModel: () => llm()?.modelId,
        async probe(endpoint) {
            try {
                const response = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(5_000), redirect: 'manual' })
                // Any answer below 500 (incl. 401) means the server is there.
                return response.status < 500
            } catch {
                return false
            }
        },
        async switchTo(entry: EndpointEntry) {
            const runtime = llm()
            if (!runtime?.switchModel) return false
            try {
                const { availableLLMs } = await import('../core/llm-factory.js')
                if (!availableLLMs.some(item => item.model === entry.model && item.endpoint === entry.endpoint)) {
                    availableLLMs.push({ provider: 'local', model: entry.model, local: true, endpoint: entry.endpoint })
                }
            } catch { /* registry optional */ }
            return Boolean(await runtime.switchModel(entry.model, 'local', entry.endpoint))
        },
    }
}

async function currentGate(): Promise<FenceGate> {
    const { FENCE_MAIN_SERVICE, getFencingMode, hasValidFence } = await import('../mesh/fence.js')
    return decideFenceGate({ held: hasValidFence(FENCE_MAIN_SERVICE), mode: getFencingMode() })
}

async function peerSummaries(): Promise<Array<{ nodeId: string; selfHeal?: SelfHealMeshSummary | null }>> {
    try {
        const { getMeshPeerStates } = await import('../mesh/mesh-transport-runtime.js')
        return Object.values(getMeshPeerStates()).filter(peer => peer.nodeId && peer.selfHeal).map(peer => ({ nodeId: peer.nodeId, selfHeal: peer.selfHeal }))
    } catch {
        return []
    }
}

async function runtimeRecipes() {
    const { getLeaseCoordinatorFailures } = await import('../mesh/leader-election.js')
    const { getFenceStatus } = await import('../mesh/fence.js')
    return createDefaultRecipes({
        diskUsage: statfsUsage,
        endpoints: createRuntimeEndpointController(),
        leaseFailures: getLeaseCoordinatorFailures,
        fenceStatus: () => getFenceStatus() as unknown as Record<string, unknown>,
    })
}

let lastGateNote = ''

/**
 * One self-heal cycle. Callers outside this module use `triggerSelfHeal`
 * (one trigger, single-flight, minimum gap). On the Main the returned checks
 * flow into the loop's normal alarm policy (quiet hours, dedupe, governed
 * notifier). A worker (`isMain=false`) or a channel-less node never gets
 * checks back: its reports ride the mesh summary to the Main.
 */
export async function runSelfHealCycle(options: { isMain: boolean; nightwatchJournalDir?: string }): Promise<CheckResult[]> {
    if (!settings.enabled) return []
    const dataDir = getNovaDataDir()
    const gate = await currentGate()
    if (!gate.held && gate.note !== lastGateNote) console.log(`[Selbstheilung] ${gate.note}`)
    lastGateNote = gate.held ? '' : gate.note
    let nightwatch = null
    if (options.nightwatchJournalDir) {
        try {
            const { readLatestNightwatchReport } = await import('./nightwatch.js')
            nightwatch = readLatestNightwatchReport(options.nightwatchJournalDir)
        } catch { /* optional */ }
    }
    const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
    const canNotifyOwner = options.isMain && String(process.env.NOVA_NODE_ONLY || '').toLowerCase() !== 'true'
    const engine = createSelfHealEngine({ dataDir, nodeId: getLocalNodeId(), settings, recipes: await runtimeRecipes() })
    const result = await engine.run({ gate, canNotifyOwner, nightwatch, peers: canNotifyOwner ? await peerSummaries() : [] })
    for (const entry of result.entries) console.log(`[Selbstheilung] ${entry.recipe}: ${entry.ergebnis} (${entry.signature})`)
    return result.checks
}

/** Minimum gap between two self-heal cycles, whoever asks. */
export const SELF_HEAL_MIN_GAP_MS = 5 * 60_000
let healInFlight: { reason: string; run: Promise<CheckResult[]> } | null = null
let lastHeal: { at: number; reason: string } | null = null

/**
 * The ONE trigger for a self-heal cycle (2.82.0). Autonomy loop, Wächter-L1,
 * mission step and an owner Ja all come here: one run at a time (a second
 * caller joins it) and at most one cycle per 5 minutes, so the same symptom
 * is never healed twice in parallel from different places.
 */
export async function triggerSelfHeal(options: { isMain: boolean; reason: string; nightwatchJournalDir?: string; now?: () => number }): Promise<{ ran: boolean; checks: CheckResult[]; note: string }> {
    if (!settings.enabled) return { ran: false, checks: [], note: 'Selbstheilung aus (autonomy.selfHeal.enabled ist nicht true)' }
    const now = (options.now ?? Date.now)()
    if (healInFlight) {
        const joined = healInFlight
        const checks = await joined.run
        return { ran: true, checks, note: `läuft bereits (Anstoß: ${joined.reason}) — Ergebnis übernommen` }
    }
    if (lastHeal && now - lastHeal.at < SELF_HEAL_MIN_GAP_MS) {
        return { ran: false, checks: [], note: `vor ${Math.max(0, Math.round((now - lastHeal.at) / 60_000))} min gelaufen (Anstoß: ${lastHeal.reason}) — nicht erneut` }
    }
    const run = runSelfHealCycle({ isMain: options.isMain, nightwatchJournalDir: options.nightwatchJournalDir ?? configuredNightwatchJournalDir })
    healInFlight = { reason: options.reason, run }
    try {
        const checks = await run
        lastHeal = { at: now, reason: options.reason }
        return { ran: true, checks, note: `Selbstheilung gelaufen (${checks.length} Meldungen, Anstoß: ${options.reason})` }
    } finally {
        healInFlight = null
    }
}

/** Tests only. */
export function resetSelfHealTrigger(): void { healInFlight = null; lastHeal = null }

/** Summary for the mesh capability payload (worker → Main). */
export function currentSelfHealMeshSummary(): SelfHealMeshSummary | null {
    return getSelfHealMeshSummary(getNovaDataDir(), settings.enabled)
}

/** /heilung (owner): status, brakes, open proposals, last journal entries, peers. */
export async function formatSelfHealOverview(): Promise<string> {
    return formatSelfHealStatus({ dataDir: getNovaDataDir(), settings, recipes: await runtimeRecipes(), gate: await currentGate(), peers: await peerSummaries() })
}

/** /selbstheilung aus|an [rezept] (owner). */
export function handleSelfHealSwitch(args: string): string {
    const [value, recipeId] = String(args || '').trim().toLowerCase().split(/\s+/)
    if (value !== 'an' && value !== 'aus') {
        return 'Nutzung: /selbstheilung aus | /selbstheilung an [rezept-id]\nStatus: /heilung'
    }
    if (recipeId && !/^[a-z0-9-]{2,64}$/.test(recipeId)) return 'Ungültige Rezept-ID.'
    const text = setSelfHealSwitch(getNovaDataDir(), value, recipeId)
    return !settings.enabled && value === 'an' && !recipeId ? `${text}\nHinweis: Config autonomy.selfHeal.enabled ist nicht true — Selbstheilung bleibt aus.` : text
}
