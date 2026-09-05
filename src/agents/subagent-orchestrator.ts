/**
 * Nova Subagent Orchestrator
 *
 * Real task delegation: Nova spawns focused child agents for subtasks.
 * Each subagent gets its own tool whitelist, timeout, and isolated context.
 *
 * Modes:
 *  - local:  runs runNovaAgent() in the same process (async, non-blocking)
 *  - mesh:   delegates task to a remote mesh node via HTTP (nova server API)
 *
 * Usage:
 *   const result = await spawnSubagent({
 *     task: "Suche nach aktuellen Neuigkeiten zu X",
 *     tools: ['web_search', 'read_file'],
 *     timeoutMs: 30_000,
 *   })
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Concurrency cap
// ============================================

const MAX_CONCURRENT_SUBAGENTS = 6
let runningCount = 0

function acquireSlot(): boolean {
    if (runningCount >= MAX_CONCURRENT_SUBAGENTS) return false
    runningCount++
    return true
}

function releaseSlot(): void {
    if (runningCount > 0) runningCount--
}

// ============================================
// Audit log
// ============================================

function writeAuditLog(entry: {
    id: string
    task: string
    status: string
    mode: string
    meshNode?: string
    toolsUsed: string[]
    durationMs: number
    error?: string
}): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n'
        appendFileSync(join(dir, 'subagent-audit.jsonl'), line)
    } catch { /* non-critical */ }
}

// ============================================
// Types
// ============================================

export type SubagentMode = 'local' | 'mesh'
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'

export interface SubagentTask {
    /** Human-readable description of what this agent should do */
    task: string
    /** Tool names this agent is allowed to use (empty = all safe tools) */
    tools?: string[]
    /** Max execution time in ms (default: 60s) */
    timeoutMs?: number
    /** Run on a specific mesh node name (e.g. "MacMini") */
    meshNode?: string
    /** System prompt override for this subagent */
    systemPrompt?: string
    /** Model to use (defaults to auto) */
    model?: string
    /** Parent userId for context */
    userId?: string
    /** Optional isolated writable workspace for implementation subagents. */
    workspace?: {
        mode?: 'temporary' | 'worktree' | 'container' | 'native'
        repository?: string
        baseRef?: string
        containerImage?: string
    }
}

export interface SubagentResult {
    id: string
    status: SubagentStatus
    output: string
    toolsUsed: string[]
    durationMs: number
    mode: SubagentMode
    meshNode?: string
    error?: string
    workspace?: { id: string; root: string; mode: 'temporary' | 'worktree' | 'container' | 'native'; status: string }
}

// ============================================
// Active subagent registry
// ============================================

interface ActiveSubagent {
    id: string
    task: SubagentTask
    status: SubagentStatus
    startedAt: number
    promise: Promise<SubagentResult>
    cancel?: () => void
}

const activeSubagents = new Map<string, ActiveSubagent>()

// ============================================
// Safe tool whitelist (no risky ops by default)
// ============================================

const SAFE_DEFAULT_TOOLS = new Set([
    'web_search', 'browser_search', 'fetch_url', 'read_file', 'list_directory',
    'run_python', 'calculate', 'get_weather', 'get_time',
    'memory_recall', 'memory_store',
    'mesh_scan', 'mesh_route',
    'get_system_info', 'read_url',
    'kg_search',
])
// write_file intentionally excluded — too broad for research/analysis subagents
// browser_open/click/type excluded — stateful, require explicit opt-in
// Callers can explicitly include it via task.tools if truly needed

const RISKY_TOOLS = new Set([
    'run_command', 'ssh_command', 'system_executor',
    'delete_file', 'send_telegram', 'send_email',
    'deploy', 'docker_run',
])

function filterTools(requested: string[] | undefined): string[] | undefined {
    if (!requested || requested.length === 0) return Array.from(SAFE_DEFAULT_TOOLS)
    // Remove risky tools unless explicitly approved
    return requested.filter(t => !RISKY_TOOLS.has(t))
}

// ============================================
// Local subagent execution
// ============================================

async function runLocalSubagent(
    id: string,
    task: SubagentTask,
    abortSignal: { cancelled: boolean },
    hardAbort?: AbortController
): Promise<SubagentResult> {
    const start = Date.now()
    const allowedTools = filterTools(task.tools)

    try {
        const { runNovaAgent } = await import('./nova-runner.js')

        const writesFiles = Boolean(allowedTools?.some(tool => ['write_file', 'delete_file', 'run_command', 'system_executor'].includes(tool)))
        let workspace: SubagentResult['workspace']
        if (task.workspace || writesFiles) {
            const { getMissionWorkspaceManager } = await import('../runtime/mission-workspace.js')
            const created = await getMissionWorkspaceManager().create({
                missionId: id,
                mode: task.workspace?.mode || (task.workspace?.repository ? 'worktree' : 'temporary'),
                repository: task.workspace?.repository,
                baseRef: task.workspace?.baseRef,
                containerImage: task.workspace?.containerImage,
            })
            workspace = { id: created.id, root: created.root, mode: created.mode, status: created.status }
        }

        // Build a focused system prompt
        let systemPrompt = task.systemPrompt ||
            `Du bist ein fokussierter Subagent. Deine einzige Aufgabe: ${task.task}\n` +
            `Führe die Aufgabe direkt aus und antworte NUR mit dem Ergebnis. Keine Erklärungen.`

        if (workspace) {
            systemPrompt += `\nISOLIERTER ARBEITSBEREICH: ${workspace.root}\nAlle Dateiänderungen und Kommandos müssen ausschließlich dort stattfinden. Änderungen bleiben bis zur unabhängigen Prüfung und Freigabe isoliert.`
        }

        // Get LLM client
        const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
        const llm = await createNovaLLMClient({ model: task.model || 'auto', role: 'chat' })

        // Get scoped tool registry
        let toolSubset: any[] | undefined
        if (allowedTools && allowedTools.length > 0) {
            try {
                const { ALL_TOOLS } = await import('../tools/complete-registry.js')
                const effectiveTools = workspace
                    ? [...allowedTools.filter(name => !['run_command', 'system_executor', 'ssh_command'].includes(name)), 'mission_workspace_run']
                    : allowedTools
                toolSubset = ALL_TOOLS.filter((t: any) => effectiveTools.includes(t.name))
            } catch { /* use all tools */ }
        }

        if (abortSignal.cancelled) {
            return { id, status: 'cancelled', output: '', toolsUsed: [], durationMs: Date.now() - start, mode: 'local' }
        }

        // Opt-in migration path: Nova remains the orchestrator and policy
        // authority; only the inner agent loop is delegated to the SDK.
        if (process.env.NOVA_AGENT_BACKEND === 'openai-agents') {
            const { ExecutionKernel } = await import('../core/execution-kernel.js')
            const { createAgentBackend } = await import('./agent-backend.js')
            const contract = new ExecutionKernel(task.task).contract
            const backend = await createAgentBackend({ backend: 'openai-agents' })
            const { withExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
            const sdkResult = await withExecutionPolicyContext({
                runId: contract.id, userId: task.userId || 'subagent', channel: 'subagent', workspaceId: workspace?.id,
            }, () => backend.run({
                contract,
                userId: task.userId || 'subagent',
                channel: 'subagent',
                content: task.task,
                systemPrompt,
                model: task.model || 'auto',
                tools: toolSubset,
                abortSignal: hardAbort?.signal,
            }))
            return {
                id,
                status: sdkResult.status === 'completed' ? 'completed'
                    : sdkResult.status === 'cancelled' ? 'cancelled'
                        : sdkResult.status === 'interrupted' ? 'pending'
                            : 'failed',
                output: sdkResult.output,
                toolsUsed: sdkResult.toolsUsed,
                durationMs: Date.now() - start,
                mode: 'local',
                error: sdkResult.error,
                workspace,
            }
        }

        const result = await runNovaAgent({
            userId: task.userId || 'subagent',
            channel: 'subagent',
            content: task.task,
            systemPrompt,
            llm,
            tools: toolSubset,
            // Pass hard abort signal if provided — nova-runner will honor it
            abortSignal: hardAbort?.signal,
            workspaceId: workspace?.id,
        })

        if (abortSignal.cancelled) {
            return { id, status: 'cancelled', output: '', toolsUsed: result.toolsUsed || [], durationMs: Date.now() - start, mode: 'local' }
        }

        return {
            id,
            status: result.error ? 'failed' : 'completed',
            output: result.content || '',
            toolsUsed: result.toolsUsed || [],
            durationMs: Date.now() - start,
            mode: 'local',
            error: result.error,
            workspace,
        }
    } catch (err) {
        // AbortError = hard timeout fired — return timeout status
        if (String(err).includes('AbortError') || String(err).includes('aborted')) {
            return { id, status: 'timeout', output: '', toolsUsed: [], durationMs: Date.now() - start, mode: 'local', error: 'Hard abort' }
        }
        return {
            id,
            status: 'failed',
            output: '',
            toolsUsed: [],
            durationMs: Date.now() - start,
            mode: 'local',
            error: String(err),
        }
    }
}

// ============================================
// Mesh delegation
// ============================================

async function runMeshSubagent(
    id: string,
    task: SubagentTask,
    meshNode: string
): Promise<SubagentResult> {
    const start = Date.now()

    try {
        // Find node in config
        const { readFileSync } = await import('node:fs')
        const { join } = await import('node:path')
        const config = JSON.parse(readFileSync(join(process.cwd(), 'nova.config.json'), 'utf-8'))
        const node = (config.nodes || []).find((n: any) =>
            n.name?.toLowerCase() === meshNode.toLowerCase() ||
            n.host?.includes(meshNode)
        )

        if (!node) {
            return { id, status: 'failed', output: '', toolsUsed: [], durationMs: 0, mode: 'mesh', error: `Node "${meshNode}" not found in config` }
        }

        // Check if the node has a Nova API server
        const novaUrl = node.services?.nova
        if (!novaUrl) {
            // No Nova server on that node — fall back to local execution
            console.log(`[SubagentOrch] Node ${meshNode} has no Nova API — falling back to local`)
            const abortSignal = { cancelled: false }
            return runLocalSubagent(id, task, abortSignal)
        }

        // Delegate via HTTP to remote Nova server
        console.log(`[SubagentOrch] 🌐 Delegating to ${meshNode} @ ${novaUrl}`)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), task.timeoutMs || 60_000)

        try {
            const resp = await fetch(`${novaUrl}/api/agent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: task.userId || 'subagent',
                    content: task.task,
                    tools: filterTools(task.tools),
                    systemPrompt: task.systemPrompt,
                }),
                signal: controller.signal,
            })
            clearTimeout(timer)

            if (!resp.ok) {
                console.warn(`[SubagentOrch] ⚠️ Mesh ${meshNode} returned ${resp.status} — falling back to local`)
                const abortSignal = { cancelled: false }
                return runLocalSubagent(id, task, abortSignal)
            }
            const data = await resp.json() as any

            return {
                id,
                status: 'completed',
                output: data.content || data.output || '',
                toolsUsed: data.toolsUsed || [],
                durationMs: Date.now() - start,
                mode: 'mesh',
                meshNode,
            }
        } finally {
            clearTimeout(timer)
        }
    } catch (err) {
        // Network error, timeout, DNS failure — fall back to local execution
        const isNetwork = String(err).includes('fetch') || String(err).includes('abort') || String(err).includes('ECONNREFUSED')
        console.warn(`[SubagentOrch] ⚠️ Mesh ${meshNode} unreachable (${err})${isNetwork ? ' — falling back to local' : ''}`)
        if (isNetwork) {
            const abortSignal = { cancelled: false }
            return runLocalSubagent(id, task, abortSignal)
        }
        return {
            id,
            status: 'failed',
            output: '',
            toolsUsed: [],
            durationMs: Date.now() - start,
            mode: 'mesh',
            meshNode,
            error: String(err),
        }
    }
}

// ============================================
// Public API
// ============================================

/**
 * Spawn a subagent to handle a focused subtask.
 * Returns result when done (respects timeoutMs).
 */
export async function spawnSubagent(task: SubagentTask): Promise<SubagentResult> {
    const id = randomUUID().slice(0, 8)
    const timeoutMs = task.timeoutMs ?? 60_000
    const abortSignal = { cancelled: false }
    // Hard abort: fires after timeout and cancels any in-flight fetch inside nova-runner
    const hardAbort = new AbortController()

    // Concurrency cap: reject if too many subagents already running
    if (!acquireSlot()) {
        const busy: SubagentResult = {
            id, status: 'failed', output: '', toolsUsed: [],
            durationMs: 0, mode: task.meshNode ? 'mesh' : 'local',
            error: `Concurrency limit reached (max ${MAX_CONCURRENT_SUBAGENTS} parallel subagents)`,
        }
        writeAuditLog({ ...busy, task: task.task.slice(0, 120) })
        console.warn(`[SubagentOrch] ⚠️ Concurrency limit — rejected subagent for: "${task.task.slice(0, 60)}"`)
        return busy
    }

    console.log(`[SubagentOrch] 🚀 Spawning subagent ${id} [${runningCount}/${MAX_CONCURRENT_SUBAGENTS}]: "${task.task.slice(0, 80)}..."`)

    const runFn = task.meshNode
        ? () => runMeshSubagent(id, task, task.meshNode!)
        : () => runLocalSubagent(id, task, abortSignal, hardAbort)

    // Wrap with timeout
    const promise = Promise.race([
        runFn(),
        new Promise<SubagentResult>((resolve) =>
            setTimeout(() => {
                abortSignal.cancelled = true
                hardAbort.abort()   // ← hard-cancels the underlying LLM fetch
                resolve({
                    id,
                    status: 'timeout',
                    output: '',
                    toolsUsed: [],
                    durationMs: timeoutMs,
                    mode: task.meshNode ? 'mesh' : 'local',
                    error: `Timeout after ${timeoutMs}ms`,
                })
            }, timeoutMs)
        ),
    ])

    const active: ActiveSubagent = {
        id,
        task,
        status: 'running',
        startedAt: Date.now(),
        promise,
        cancel: () => { abortSignal.cancelled = true; hardAbort.abort() },
    }
    activeSubagents.set(id, active)

    let result: SubagentResult
    try {
        result = await promise
    } catch (err) {
        result = {
            id,
            status: 'failed',
            output: '',
            toolsUsed: [],
            durationMs: timeoutMs,
            mode: task.meshNode ? 'mesh' : 'local',
            meshNode: task.meshNode,
            error: String(err),
        }
    } finally {
        releaseSlot()
    }

    // Update status in registry
    if (activeSubagents.has(id)) {
        activeSubagents.get(id)!.status = result.status
    }

    // Audit log
    writeAuditLog({
        id, task: task.task.slice(0, 120),
        status: result.status, mode: result.mode,
        meshNode: result.meshNode, toolsUsed: result.toolsUsed,
        durationMs: result.durationMs, error: result.error,
    })

    console.log(`[SubagentOrch] ✅ Subagent ${id} finished: ${result.status} in ${result.durationMs}ms`)
    return result
}

/**
 * Spawn multiple subagents in parallel and wait for all.
 */
export async function spawnParallel(tasks: SubagentTask[]): Promise<SubagentResult[]> {
    return Promise.all(tasks.map(t => spawnSubagent(t)))
}

/**
 * Tool-friendly parallel spawn — accepts an array of task specs, fires all at once.
 * Returns a combined summary once all are done.
 */
export async function spawnSubagentsParallel(
    tasks: Array<{ task: string; tools?: string[]; timeout_seconds?: number; mesh_node?: string }>
): Promise<string> {
    if (!tasks.length) return 'Keine Tasks angegeben.'
    console.log(`[SubagentOrch] 🚀 Parallel spawn: ${tasks.length} subagents`)
    const results = await spawnParallel(tasks.map(t => ({
        task: t.task,
        tools: t.tools,
        timeoutMs: (t.timeout_seconds || 60) * 1000,
        meshNode: t.mesh_node,
    })))
    return results.map((r, i) =>
        `[${i + 1}/${results.length}] ${r.status.toUpperCase()} (${r.durationMs}ms):\n${r.output || r.error || '(leer)'}`
    ).join('\n\n---\n\n')
}

/**
 * Cancel a running subagent.
 */
export function cancelSubagent(id: string): boolean {
    const agent = activeSubagents.get(id)
    if (!agent || agent.status !== 'running') return false
    agent.cancel?.()
    agent.status = 'cancelled'
    return true
}

/**
 * List all active/recent subagents.
 */
export function listSubagents(): Array<{ id: string; task: string; status: SubagentStatus; durationMs: number }> {
    return Array.from(activeSubagents.values()).map(a => ({
        id: a.id,
        task: a.task.task.slice(0, 80),
        status: a.status,
        durationMs: Date.now() - a.startedAt,
    }))
}
