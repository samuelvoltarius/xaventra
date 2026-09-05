import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import type { SubagentResult, SubagentTask } from './subagent-orchestrator.js'

export interface ContinuableSubagentProvider {
    name: string
    capabilities: Readonly<{ coldResume: boolean; mesh: boolean; toolFilter: boolean }>
    run(request: { conversationId: string; task: SubagentTask; prompt: string; signal?: AbortSignal }): Promise<SubagentResult>
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
        const record: ContinuableSubagentRecord = {
            id,
            provider,
            task: { ...task, userId: `subagent:${id}` },
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
        return this.runTurn(record, prompt)
    }

    interrupt(id: string): boolean {
        const controller = this.active.get(id)
        if (!controller) return false
        controller.abort(new Error('Subagent interrupted'))
        return true
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
            const result = await provider.run({ conversationId: record.id, task: record.task, prompt, signal: controller.signal })
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
        const run = async ({ task, prompt, signal }: { task: SubagentTask; prompt: string; signal?: AbortSignal }) => {
            const { spawnSubagent } = await import('./subagent-orchestrator.js')
            if (signal?.aborted) throw signal.reason
            return spawnSubagent({ ...task, task: prompt })
        }
        runtime.registerProvider({ name: 'nova-local', capabilities: Object.freeze({ coldResume: true, mesh: false, toolFilter: true }), run })
        runtime.registerProvider({ name: 'nova-mesh', capabilities: Object.freeze({ coldResume: true, mesh: true, toolFilter: true }), run })
    }
    return runtime
}
