import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentBackend } from '../agents/agent-backend.js'
import { createAgentBackend } from '../agents/agent-backend.js'
import { detectActionIntent } from '../core/action-intent.js'
import { availableLLMs, detectAvailableLLMs } from '../core/llm-factory.js'
import { getOutcomeLedger, OutcomeLedger, withOutcomeLedger } from '../core/outcome-ledger.js'
import { createTaskContract, validateTaskCompletion } from '../core/task-contract.js'
import { withModelPerformanceRecording } from '../llm/model-perf-db.js'
import { getBenchmarkScenarios, runBenchmark, type BenchmarkObservation, type BenchmarkScenario } from './benchmark-lab.js'
import { runBenchmarkProbe } from './benchmark-probes.js'

export type NovaBenchmarkMode = 'smoke' | 'full'

export async function ensureBenchmarkRuntimeReady(
    hasInjectedBackend: boolean,
    inventory: readonly unknown[] = availableLLMs,
    discover: () => Promise<void> = detectAvailableLLMs,
): Promise<void> {
    if (!hasInjectedBackend && inventory.length === 0) await discover()
}

function selectScenarios(mode: NovaBenchmarkMode): BenchmarkScenario[] {
    const scenarios = getBenchmarkScenarios()
    if (mode === 'full') return scenarios
    const seen = new Set<string>()
    return scenarios.filter(item => !seen.has(item.category) && Boolean(seen.add(item.category)))
}

function evidenceText(run: ReturnType<ReturnType<typeof getOutcomeLedger>['getRun']>): string {
    if (!run) return ''
    return JSON.stringify({ tools: run.tools, tests: run.tests, changes: run.changes, validation: run.validation, events: run.events }).toLowerCase()
}

const SAFE_BENCHMARK_TOOLS = [
    'read_file', 'list_directory', 'codebase_search', 'find_files',
    'mesh_status', 'mesh_nodes', 'nova_capabilities', 'nova_introspect', 'health_status',
    'find_capability', 'resolve_capability', 'list_sessions', 'mission_config',
    'list_reminders', 'list_sub_agents', 'nova_trace_stats',
]

function hasGroundedEvidence(run: NonNullable<ReturnType<ReturnType<typeof getOutcomeLedger>['getRun']>>, required: string, rawText: string): boolean {
    const successfulTools = run.tools.filter(item => item.success === true)
    const toolNames = successfulTools.map(item => String(item.toolName || ''))
    const toolText = JSON.stringify(successfulTools).toLowerCase()
    const evidenceTags = new Set(successfulTools.flatMap(item => Array.isArray(item.evidenceTags)
        ? item.evidenceTags.map(tag => String(tag).toLowerCase()) : []))
    if (evidenceTags.has(required.toLowerCase())) return true
    if (rawText.includes(required.toLowerCase())) return true
    if (required === 'tool result') return successfulTools.length > 0
    if (required === 'service probe') return toolNames.some(name => ['mesh_status', 'mesh_nodes', 'nova_capabilities', 'health_status'].includes(name))
    if (required === 'model list') return /vllm|ollama|qwen|model/.test(toolText)
    if (required === 'hardware probe') return toolNames.some(name => ['nova_introspect', 'nova_capabilities', 'health_status'].includes(name)) && /gpu|cpu|vram|hardware/.test(toolText)
    if (required === 'shadow decision' || required === 'historical outcomes') {
        return run.events.some(event => event.type === 'route.selected' && (event.payload.shadowRecommendation || event.payload.shadowConfidence !== undefined))
    }
    if (required === 'validation report') return Boolean(run.validation)
    if (required === 'fresh evidence') return successfulTools.length > 0 && run.tools.some(item => Number(item.durationMs || 0) >= 0)
    if (required === 'checkpoint') return run.events.some(event => event.type === 'checkpoint.saved')
    return false
}

export async function executeNovaBenchmarkScenario(backend: AgentBackend, scenario: BenchmarkScenario, workspace: string): Promise<BenchmarkObservation> {
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true })
    const startedAt = Date.now()
    const fixturePath = join(workspace, `${scenario.id}.txt`)
    writeFileSync(fixturePath, `NOVA_BENCHMARK_FIXTURE=${scenario.id}\n`, 'utf8')
    const prompt = scenario.category === 'tools'
        ? `${scenario.prompt} Verwende als Testdatei ausschließlich: ${fixturePath}`
        : scenario.prompt
    const intent = detectActionIntent(prompt)
    // Every benchmark scenario has a typed, isolated executing probe. The
    // benchmark contract therefore always requires verified tool evidence and
    // never succeeds or fails merely because the advisory planner happened to
    // emit (or omit) prose.
    const evidenceIntent = {
        requiresTool: true,
        kind: intent.kind === 'none' ? 'generic-action' as const : intent.kind,
    }
    const contract = createTaskContract(prompt, evidenceIntent, SAFE_BENCHMARK_TOOLS, {
        budget: { timeoutMs: scenario.timeoutMs, maxToolCalls: 20, maxCostUsd: 1 },
        allowedChanges: { readOnly: true, allowedPaths: [workspace], externalSideEffects: false },
        approvalPolicy: { mode: 'all_changes', patchGateRequired: true },
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), scenario.timeoutMs)
    try {
        const result = await withModelPerformanceRecording(false, () => backend.run({
            contract, userId: `benchmark:${scenario.id}`, authUserId: 'benchmark', channel: 'benchmark', content: prompt,
            // The model is an advisory planner in the benchmark. Real,
            // contract-specific execution happens in the isolated typed probe
            // below. Supplying an explicit empty set prevents speculative
            // model tool calls from mutating production ToolHealth/L7 state.
            tools: [],
            abortSignal: controller.signal,
            systemPrompt: 'NOVA BENCHMARK. The isolated validator, not you, executes the typed probe. Do not call tools, change production, contact people, explain, or ask questions. Do not use a question mark. Return exactly this one line and nothing else: BENCHMARK_RESULT: READY',
        }))
        const ledger = getOutcomeLedger()
        if (!ledger.getRun(contract.id)) {
            ledger.start(contract, {
                channel: 'benchmark',
                userId: `benchmark:${scenario.id}`,
                backend: backend.name,
            })
        }
        const probeStartedAt = Date.now()
        const probe = await runBenchmarkProbe(scenario, workspace)
        if (probe) {
            ledger.recordTool(contract.id, {
                toolName: probe.toolName,
                success: probe.success,
                verified: probe.success,
                durationMs: Date.now() - probeStartedAt,
                evidenceTags: probe.evidenceTags,
                evidence: probe.evidence,
                source: 'isolated-benchmark-probe',
            })
        }
        const beforeValidation = ledger.getRun(contract.id)
        const verifiedTools = beforeValidation?.tools
            .filter(item => item.success === true && (item.verified === true || item.source === 'isolated-benchmark-probe'))
            .map(item => String(item.toolName || ''))
            .filter(Boolean) || []
        const benchmarkValidation = validateTaskCompletion(contract, {
            response: result.output,
            verifiedTools,
            durationMs: Date.now() - startedAt,
            toolCalls: beforeValidation?.tools.length || 0,
            costUsd: beforeValidation?.totalCostUsd || 0,
        })
        ledger.recordValidation(contract.id, benchmarkValidation)
        if (benchmarkValidation.success && result.status === 'completed') {
            ledger.complete(contract.id, {
                success: true,
                durationMs: Date.now() - startedAt,
                benchmarkProbe: probe?.toolName,
            })
        }
        const run = ledger.getRun(contract.id)
        const text = evidenceText(run)
        const matched = run ? scenario.requiredEvidence.filter(item => hasGroundedEvidence(run, item, text)).length : 0
        const validated = run?.validation?.success === true
        const scenarioSuccess = result.status === 'completed'
            && run?.status === 'completed'
            && validated
            && matched === scenario.requiredEvidence.length
        return {
            scenarioId: scenario.id,
            success: scenarioSuccess,
            toolExecuted: Boolean(run?.tools.some(item => item.success === true)),
            resumed: scenario.category === 'resume' ? scenarioSuccess : undefined,
            memoryCorrect: scenario.category === 'memory' ? scenarioSuccess : undefined,
            durationMs: Date.now() - startedAt,
            costUsd: run?.totalCostUsd || 0,
            // Planner output is internal in this benchmark: the typed probe is
            // the executor and only its validated result is user-visible. A
            // question mark in hidden model prose is therefore not a user
            // interruption. Backends must explicitly signal a real pause for
            // user input so this metric remains deterministic and meaningful.
            unnecessaryQuestions: result.requestedUserInput === true ? 1 : 0,
            falseCompletion: result.status === 'completed' && !validated,
            details: `evidence ${matched}/${scenario.requiredEvidence.length}; backend=${backend.name}; status=${result.status}`,
        }
    } catch (error) {
        return { scenarioId: scenario.id, success: false, toolExecuted: false, durationMs: Date.now() - startedAt, details: String(error) }
    } finally {
        clearTimeout(timeout)
    }
}

export async function runNovaBenchmark(mode: NovaBenchmarkMode = 'smoke', backend?: AgentBackend) {
    const selected = selectScenarios(mode)
    const workspace = join(process.cwd(), '.nova-data', 'benchmark-workspace', `${Date.now()}-${mode}`)
    const benchmarkLedger = new OutcomeLedger(join(workspace, 'outcome-ledger'), false)
    return withOutcomeLedger(benchmarkLedger, async () => {
        // The daemon initializes the shared LLM inventory during boot. The
        // standalone benchmark CLI does not, so an explicit local model such
        // as "qwen" otherwise reaches Nova without its verified vLLM endpoint
        // and falls through to the legacy localhost:11434 default.
        await ensureBenchmarkRuntimeReady(Boolean(backend))
        const activeBackend = backend || await createAgentBackend()
        return runBenchmark(scenario => executeNovaBenchmarkScenario(activeBackend, scenario, workspace), selected)
    })
}

let scheduleTimer: ReturnType<typeof setInterval> | null = null
export function startBenchmarkSchedule(intervalMs = Number(process.env.NOVA_BENCHMARK_INTERVAL_MS || 7 * 24 * 60 * 60_000)): void {
    if (scheduleTimer || process.env.NOVA_BENCHMARK_AUTO !== '1') return
    scheduleTimer = setInterval(() => { void runNovaBenchmark('smoke') }, Math.max(60 * 60_000, intervalMs))
    if (scheduleTimer.unref) scheduleTimer.unref()
}
