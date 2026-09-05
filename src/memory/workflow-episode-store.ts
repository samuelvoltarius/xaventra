import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { memoryRelevance } from './memory-quality.js'
import { pullSharedMemory, pushSharedMemory, readNodeId } from './shared-memory.js'
import { sideEffectsDisabled } from '../core/side-effects.js'

export interface WorkflowStep {
    toolName: string
    parameterKeys: string[]
}

export interface WorkflowEpisode {
    id: string
    runId: string
    userId: string
    requestSummary: string
    taskType: string
    steps: WorkflowStep[]
    model?: string
    node?: string
    success: boolean
    durationMs: number
    costUsd: number
    evidenceRef: string
    createdAt: string
}

interface EpisodeTombstone { runId: string; userId: string; retractedAt: string; reason: string }
interface EpisodeFile { version: 1; updatedAt: string; episodes: WorkflowEpisode[]; tombstones?: EpisodeTombstone[] }
const DEFAULT_EPISODE_FILE = getNovaDataDir('memory', 'workflow-episodes.json')
const SHARED_SCOPE = 'workflow-episodes'

function clean(value: unknown, limit: number): string {
    const result = redactSecrets(String(value || '')).replace(/\s+/g, ' ').trim()
    return result.includes('[REDACTED') ? '' : result.slice(0, limit)
}

export function workflowSignature(episode: Pick<WorkflowEpisode, 'steps'>): string {
    return episode.steps.map(step => `${step.toolName}(${step.parameterKeys.join(',')})`).join('>')
}

export class WorkflowEpisodeStore {
    private episodes: WorkflowEpisode[] = []
    private tombstones: EpisodeTombstone[] = []

    constructor(private readonly path = DEFAULT_EPISODE_FILE) {
        try {
            if (existsSync(path)) {
                const parsed = JSON.parse(readFileSync(path, 'utf8')) as EpisodeFile
                this.episodes = parsed.episodes || []
                this.tombstones = parsed.tombstones || []
            }
        } catch { this.episodes = []; this.tombstones = [] }
    }

    record(input: Omit<WorkflowEpisode, 'id' | 'createdAt' | 'evidenceRef'>): WorkflowEpisode | null {
        if (!input.runId || !input.userId || input.steps.length === 0) return null
        if (this.tombstones.some(item => item.runId === input.runId)) return null
        if (this.episodes.some(item => item.runId === input.runId)) return null
        const episode: WorkflowEpisode = {
            ...input,
            id: createHash('sha256').update(`${input.userId}\0${input.runId}`).digest('hex').slice(0, 24),
            requestSummary: clean(input.requestSummary, 300),
            taskType: clean(input.taskType, 60) || 'unknown',
            steps: input.steps.slice(0, 24).map(step => ({
                toolName: clean(step.toolName, 80),
                parameterKeys: [...new Set(step.parameterKeys.map(key => clean(key, 60)).filter(Boolean))].sort(),
            })).filter(step => step.toolName),
            evidenceRef: `outcome:${input.runId}`,
            createdAt: new Date().toISOString(),
        }
        if (!episode.requestSummary || episode.steps.length === 0) return null
        this.episodes.push(episode)
        this.episodes = this.episodes.slice(-500)
        this.persist()
        if (this.path === DEFAULT_EPISODE_FILE && !sideEffectsDisabled()) void this.publishShared(episode)
        return episode
    }

    retractRun(runId: string, userId: string, reason: string): boolean {
        if (!runId || !userId) return false
        const before = this.episodes.length
        this.episodes = this.episodes.filter(item => item.runId !== runId || item.userId !== userId)
        if (!this.tombstones.some(item => item.runId === runId && item.userId === userId)) {
            const tombstone = { runId, userId, retractedAt: new Date().toISOString(), reason: clean(reason, 300) }
            this.tombstones.push(tombstone)
            this.tombstones = this.tombstones.slice(-1_000)
            if (this.path === DEFAULT_EPISODE_FILE && !sideEffectsDisabled()) void this.publishTombstone(tombstone)
        }
        this.persist()
        return before !== this.episodes.length
    }

    async hydrateShared(): Promise<number> {
        if (this.path !== DEFAULT_EPISODE_FILE || sideEffectsDisabled()) return 0
        const entries = await pullSharedMemory({ scope: SHARED_SCOPE, limit: 500 })
        let imported = 0
        let tombstonesChanged = false
        const importedEpisodes: WorkflowEpisode[] = []
        for (const entry of entries) {
            if (entry.metadata?.format !== 'nova-workflow-episode-tombstone-v1') continue
            try {
                const tombstone = JSON.parse(entry.content) as EpisodeTombstone
                if (!tombstone.runId || tombstone.userId !== entry.userId) continue
                if (!this.tombstones.some(item => item.runId === tombstone.runId && item.userId === tombstone.userId)) {
                    this.tombstones.push(tombstone)
                    tombstonesChanged = true
                }
                const before = this.episodes.length
                this.episodes = this.episodes.filter(item => item.runId !== tombstone.runId || item.userId !== tombstone.userId)
                if (before !== this.episodes.length) tombstonesChanged = true
            } catch { /* malformed shared tombstone is ignored */ }
        }
        for (const entry of entries) {
            if (entry.metadata?.format !== 'nova-workflow-episode-v1') continue
            try {
                const episode = JSON.parse(entry.content) as WorkflowEpisode
                if (!episode.id || episode.userId !== entry.userId || this.episodes.some(item => item.id === episode.id || item.runId === episode.runId)) continue
                if (this.tombstones.some(item => item.runId === episode.runId && item.userId === episode.userId)) continue
                const expected = createHash('sha256').update(`${episode.userId}\0${episode.runId}`).digest('hex').slice(0, 24)
                if (episode.id !== expected || episode.evidenceRef !== `outcome:${episode.runId}`) continue
                this.episodes.push(episode)
                importedEpisodes.push(episode)
                imported++
            } catch { /* malformed shared episode is ignored */ }
        }
        if (imported > 0) {
            this.episodes = this.episodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-500)
            this.persist()
            try {
                const { getPersonalSkillCompiler } = await import('../learning/personal-skill-compiler.js')
                for (const episode of importedEpisodes) getPersonalSkillCompiler().observe(episode)
            } catch { /* proposals are a derived projection and can rebuild later */ }
        }
        if (tombstonesChanged && imported === 0) this.persist()
        return imported
    }

    private async publishShared(episode: WorkflowEpisode): Promise<void> {
        await pushSharedMemory({
            id: `workflow_episode_${episode.id}`, userId: episode.userId, role: 'system',
            content: JSON.stringify(episode), timestamp: Date.parse(episode.createdAt),
            sourceNode: readNodeId(), scope: SHARED_SCOPE,
            keywords: ['workflow-episode', episode.taskType, ...episode.steps.map(step => step.toolName)].slice(0, 20),
            metadata: { format: 'nova-workflow-episode-v1', evidenceRef: episode.evidenceRef },
        })
    }

    private async publishTombstone(tombstone: EpisodeTombstone): Promise<void> {
        await pushSharedMemory({
            id: `workflow_tombstone_${createHash('sha256').update(`${tombstone.userId}\0${tombstone.runId}`).digest('hex').slice(0, 24)}`,
            userId: tombstone.userId, role: 'system', content: JSON.stringify(tombstone),
            timestamp: Date.parse(tombstone.retractedAt), sourceNode: readNodeId(), scope: SHARED_SCOPE,
            keywords: ['workflow-episode', 'tombstone'],
            metadata: { format: 'nova-workflow-episode-tombstone-v1', runId: tombstone.runId },
        })
    }

    private persist(): void {
        atomicWriteJsonSync(this.path, {
            version: 1, updatedAt: new Date().toISOString(), episodes: this.episodes,
            tombstones: this.tombstones,
        } satisfies EpisodeFile)
    }

    findRelevant(userId: string, query: string, limit = 3): WorkflowEpisode[] {
        return this.episodes
            .filter(item => item.userId === userId && item.success)
            .map(item => ({ item, score: memoryRelevance(query, `${item.requestSummary} ${item.steps.map(step => step.toolName).join(' ')}`) }))
            .filter(row => row.score > 0)
            .sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt))
            .slice(0, limit)
            .map(row => JSON.parse(JSON.stringify(row.item)))
    }

    getPrompt(userId: string, query: string): string {
        const relevant = this.findRelevant(userId, query)
        if (relevant.length === 0) return ''
        return [
            'Verifizierte frühere Arbeitsabläufe (nur als Planungshilfe, erneut ausführen und verifizieren):',
            ...relevant.map(item => `- ${item.requestSummary}: ${item.steps.map(step => step.toolName).join(' → ')} [${item.evidenceRef}]`),
        ].join('\n')
    }

    getStats(userId?: string): { total: number; successful: number; users: number } {
        const values = userId ? this.episodes.filter(item => item.userId === userId) : this.episodes
        return { total: values.length, successful: values.filter(item => item.success).length, users: new Set(values.map(item => item.userId)).size }
    }
}

let singleton: WorkflowEpisodeStore | null = null
export function getWorkflowEpisodeStore(): WorkflowEpisodeStore { return singleton ||= new WorkflowEpisodeStore() }
export function setWorkflowEpisodeStore(store: WorkflowEpisodeStore): void { singleton = store }
