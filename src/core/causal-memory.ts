import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'

export interface CausalEvent { id: string; userId: string; kind: string; summary: string; sourceRunId: string; verifiedAt: string }
export interface CausalLink { id: string; userId: string; causeId: string; effectId: string; relation: 'caused' | 'enabled' | 'prevented' | 'followed-by'; confidence: number; evidenceRef: string }
interface CausalFile { version: 1; updatedAt: string; events: CausalEvent[]; links: CausalLink[] }

export class CausalMemory {
    private events: CausalEvent[] = []
    private links: CausalLink[] = []
    constructor(private readonly path = getNovaDataDir('causal-memory.json')) {
        try {
            if (existsSync(path)) {
                const parsed = JSON.parse(readFileSync(path, 'utf8')) as CausalFile
                this.events = parsed.events || []; this.links = parsed.links || []
            }
        } catch { this.events = []; this.links = [] }
    }

    recordChain(input: { userId: string; runId: string; events: Array<{ kind: string; summary: string }>; confidence?: number }): CausalEvent[] {
        const created: CausalEvent[] = input.events.map((event, index) => ({
            id: createHash('sha256').update(`${input.userId}\0${input.runId}\0${index}\0${event.kind}`).digest('hex').slice(0, 24),
            userId: input.userId, kind: event.kind, summary: event.summary.slice(0, 500), sourceRunId: input.runId, verifiedAt: new Date().toISOString(),
        }))
        for (const event of created) if (!this.events.some(item => item.id === event.id)) this.events.push(event)
        for (let index = 1; index < created.length; index++) {
            const cause = created[index - 1], effect = created[index]
            const id = createHash('sha256').update(`${cause.id}\0${effect.id}`).digest('hex').slice(0, 24)
            if (!this.links.some(item => item.id === id)) this.links.push({
                id, userId: input.userId, causeId: cause.id, effectId: effect.id, relation: 'followed-by',
                confidence: Math.max(0, Math.min(1, input.confidence ?? 1)), evidenceRef: `outcome:${input.runId}`,
            })
        }
        this.persist()
        return structuredClone(created)
    }

    trace(eventId: string): { event: CausalEvent | null; causes: CausalEvent[]; effects: CausalEvent[] } {
        const event = this.events.find(item => item.id === eventId) || null
        const byId = new Map(this.events.map(item => [item.id, item]))
        return {
            event: event ? structuredClone(event) : null,
            causes: this.links.filter(link => link.effectId === eventId).map(link => byId.get(link.causeId)).filter(Boolean).map(item => structuredClone(item!)),
            effects: this.links.filter(link => link.causeId === eventId).map(link => byId.get(link.effectId)).filter(Boolean).map(item => structuredClone(item!)),
        }
    }

    getStats(userId?: string) {
        const events = this.events.filter(item => !userId || item.userId === userId)
        const ids = new Set(events.map(item => item.id))
        return { events: events.length, links: this.links.filter(link => ids.has(link.causeId) && ids.has(link.effectId)).length }
    }

    retractRun(runId: string): number {
        const removedIds = new Set(this.events.filter(event => event.sourceRunId === runId).map(event => event.id))
        if (removedIds.size === 0) return 0
        this.events = this.events.filter(event => !removedIds.has(event.id))
        this.links = this.links.filter(link => !removedIds.has(link.causeId) && !removedIds.has(link.effectId) && link.evidenceRef !== `outcome:${runId}`)
        this.persist()
        return removedIds.size
    }

    private persist(): void {
        this.events = this.events.slice(-5_000); this.links = this.links.slice(-10_000)
        atomicWriteJsonSync(this.path, { version: 1, updatedAt: new Date().toISOString(), events: this.events, links: this.links } satisfies CausalFile)
    }
}

let singleton: CausalMemory | null = null
export function getCausalMemory(): CausalMemory { return singleton ||= new CausalMemory() }
export function setCausalMemory(value: CausalMemory): void { singleton = value }
