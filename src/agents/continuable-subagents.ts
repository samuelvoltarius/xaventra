import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import type { SubagentResult, SubagentTask } from './subagent-orchestrator.js'

export interface ContinuableSubagentProvider {
    name: string
    capabilities: Readonly<{ coldResume: boolean; mesh: boolean; toolFilter: boolean }>
    run(request: { conversationId: string; task: SubagentTask; prompt: string; signal?: AbortSignal; history?: readonly ContinuableTurn[] }): Promise<SubagentResult>
}

export interface ContinuableTurn {
    id: string
    prompt: string
    output: string
    status: SubagentResult['status']
    toolsUsed: string[]
    outputHash: string
    at: string
}

export interface ContinuableSubagentRecord {
    id: string
    provider: string
    task: SubagentTask
    principalId: string
    phase: 'idle' | 'running' | 'interrupted' | 'failed' | 'complete'
    turns: ContinuableTurn[]
    createdAt: string
    updatedAt: string
    lastError?: string
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

/** A follow-up continues the conversation: earlier turns go along, bounded. */
export function continuationPrompt(turns: readonly ContinuableTurn[], prompt: string): string {
    const previous = turns.slice(-5)
    if (previous.length === 0) return prompt
    const history = previous.map((turn, index) =>
        `[${index + 1}] Auftrag: ${turn.prompt.slice(0, 1_000)}\nErgebnis (${turn.status}): ${turn.output.slice(0, 2_000)}`).join('\n\n')
    return `Bisheriger Verlauf dieser Subagent-Konversation:\n${history}\n\nNächster Auftrag: ${prompt}`
}

export class ContinuableSubagentRuntime {
    private readonly providers = new Map<string, ContinuableSubagentProvider>()
    private readonly records = new Map<string, ContinuableSubagentRecord>()
    private readonly active = new Map<string, AbortController>()

    constructor(private readonly path = join(process.cwd(), '.nova-data', 'continuable-subagents.json')) {
        this.load()
    }

    registerProvider(provider: ContinuableSubagentProvider): () => void {
        if (this.providers.has(provider.name)) throw new Error(`Subagent provider already registered: ${provider.name}`)
        this.providers.set(provider.name, provider)
        return () => this.providers.delete(provider.name)
    }

    listProviders(): Array<{ name: string; capabilities: ContinuableSubagentProvider['capabilities'] }> {
        return [...this.providers.values()].map(provider => ({ name: provider.name, capabilities: provider.capabilities }))
    }

    async start(task: SubagentTask, provider = task.meshNode ? 'nova-mesh' : 'nova-local'): Promise<ContinuableSubagentRecord> {
        const id = randomUUID()
        const now = new Date().toISOString()
        // The conversation acts for, and belongs to, the parent principal of
        // the governed tool call (not a role-less "subagent:<id>" guest).
        const { resolveParentIdentity } = await import('./subagent-orchestrator.js')
        const parent = await resolveParentIdentity(task)
        const record: ContinuableSubagentRecord = {
            id,
            provider,
            task: { ...task, userId: parent.userId, authUserId: parent.authUserId },
            principalId: `subagent:${id}`,
            phase: 'idle',
            turns: [],
            createdAt: now,
            updatedAt: now,
        }
        this.records.set(id, record)
        this.persist()
        return this.runTurn(record, task.task)
    }

    async followup(id: string, prompt: string): Promise<ContinuableSubagentRecord> {
        const record = this.records.get(id)
        if (!record) throw new Error(`Continuable subagent not found: ${id}`)
        if (!prompt.trim()) throw new Error('Subagent follow-up must not be empty')
        await this.assertRequester(record)
        return this.runTurn(record, prompt)
    }

    /** Stops the turn in flight. The provider receives the abort signal and the
     * turn is recorded as interrupted, never as complete. */
    interrupt(id: string, requesterAuthUserId?: string): boolean {
        const controller = this.active.get(id)
        if (!controller) return false
        const record = this.records.get(id)
        if (requesterAuthUserId && record?.task.authUserId && requesterAuthUserId !== record.task.authUserId) return false
        controller.abort(new Error('Subagent interrupted'))
        return true
    }

    /** Another principal must not continue (and read) someone else's conversation. */
    private async assertRequester(record: ContinuableSubagentRecord): Promise<void> {
        let requester: string | undefined
        try {
            const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
            requester = getExecutionPolicyContext().authUserId
        } catch { /* no governed caller context */ }
        if (requester && record.task.authUserId && requester !== record.task.authUserId) {
            throw new Error(`Continuable subagent ${record.id} belongs to another principal`)
        }
    }

    get(id: string): ContinuableSubagentRecord | undefined {
        const record = this.records.get(id)
        return record ? structuredClone(record) : undefined
    }

    list(): ContinuableSubagentRecord[] {
        return [...this.records.values()].map(record => structuredClone(record)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }

    private async runTurn(record: ContinuableSubagentRecord, prompt: string): Promise<ContinuableSubagentRecord> {
        if (this.active.has(record.id)) throw new Error(`Subagent ${record.id} already has a turn in flight`)
        const provider = this.providers.get(record.provider)
        if (!provider) throw new Error(`Subagent provider unavailable: ${record.provider}`)
        const controller = new AbortController()
        this.active.set(record.id, controller)
        record.phase = 'running'
        record.updatedAt = new Date().toISOString()
        this.persist()
        try {
            const stopped = new Promise<never>((_, reject) => {
                controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
            })
            stopped.catch(() => undefined)
            const result = await Promise.race([
                provider.run({ conversationId: record.id, task: record.task, prompt, signal: controller.signal, history: structuredClone(record.turns) }),
                stopped,
            ])
            if (controller.signal.aborted) throw controller.signal.reason
            const turn: ContinuableTurn = {
                id: result.id,
                prompt: prompt.slice(0, 4_000),
                output: result.output.slice(0, 20_000),
                status: result.status,
                toolsUsed: [...new Set(result.toolsUsed)],
                outputHash: hash(result.output),
                at: new Date().toISOString(),
            }
            record.turns.push(turn)
            record.phase = result.status === 'completed' ? 'complete'
                : result.status === 'cancelled' || result.status === 'timeout' ? 'interrupted'
                    : 'failed'
            record.lastError = result.error
        } catch (error) {
            record.phase = controller.signal.aborted ? 'interrupted' : 'failed'
            record.lastError = error instanceof Error ? error.message : String(error)
        } finally {
            this.active.delete(record.id)
            record.updatedAt = new Date().toISOString()
            this.persist()
        }
        return structuredClone(record)
    }

    private load(): void {
        if (!existsSync(this.path)) return
        try {
            const records = JSON.parse(readFileSync(this.path, 'utf8')) as ContinuableSubagentRecord[]
            for (const record of records) {
                if (!record?.id || !record.provider || !record.task) continue
                if (record.phase === 'running') record.phase = 'interrupted'
                this.records.set(record.id, record)
            }
        } catch { /* invalid state never authorizes execution */ }
    }

    private persist(): void { atomicWriteJsonSync(this.path, this.list()) }
}

let runtime: ContinuableSubagentRuntime | null = null
export function getContinuableSubagentRuntime(): ContinuableSubagentRuntime {
    if (!runtime) {
        runtime = new ContinuableSubagentRuntime()
        const run = async ({ task, prompt, signal, history }: { task: SubagentTask; prompt: string; signal?: AbortSignal; history?: readonly ContinuableTurn[] }) => {
            const { spawnSubagent } = await import('./subagent-orchestrator.js')
            if (signal?.aborted) throw signal.reason
            return spawnSubagent({ ...task, task: continuationPrompt(history || [], prompt) }, { signal })
        }
        runtime.registerProvider({ name: 'nova-local', capabilities: Object.freeze({ coldResume: true, mesh: false, toolFilter: true }), run })
        runtime.registerProvider({ name: 'nova-mesh', capabilities: Object.freeze({ coldResume: true, mesh: true, toolFilter: true }), run })
    }
    return runtime
}
