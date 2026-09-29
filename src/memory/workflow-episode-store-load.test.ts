import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const remote = vi.hoisted(() => ({ rows: [] as any[] }))
vi.mock('./shared-memory.js', () => ({
    pullSharedMemory: async () => remote.rows,
    pushSharedMemory: async () => true,
    readNodeId: () => 'test-node',
}))
vi.mock('../core/side-effects.js', () => ({ sideEffectsDisabled: () => false }))

const { getNovaDataDir } = await import('../core/data-root.js')
const { WorkflowEpisodeStore } = await import('./workflow-episode-store.js')

describe('workflow episodes after an unreadable local file (R2 MA-18)', () => {
    it('keeps the file and does not re-import shared episodes whose retraction may be lost', async () => {
        const path = getNovaDataDir('memory', 'workflow-episodes.json')
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, '{ kaputt')
        const episode = {
            id: createHash('sha256').update('user:a\0run-retracted').digest('hex').slice(0, 24),
            runId: 'run-retracted', userId: 'user:a', requestSummary: 'deploy app', taskType: 'device-action',
            steps: [{ toolName: 'mesh_deploy', parameterKeys: ['host'] }], success: true, durationMs: 1, costUsd: 0,
            evidenceRef: 'outcome:run-retracted', createdAt: new Date().toISOString(),
        }
        remote.rows = [{ id: 'e', userId: 'user:a', role: 'system', content: JSON.stringify(episode), timestamp: 1, metadata: { format: 'nova-workflow-episode-v1' } }]

        const store = new WorkflowEpisodeStore()
        expect(await store.hydrateShared()).toBe(0)
        expect(store.findRelevant('user:a', 'deploy')).toHaveLength(0)
        const aside = readdirSync(dirname(path)).filter(name => name.startsWith('workflow-episodes.json.corrupt-'))
        expect(aside).toHaveLength(1)
        expect(readFileSync(`${dirname(path)}/${aside[0]}`, 'utf8')).toBe('{ kaputt')
        expect(existsSync(path)).toBe(false)
    })
})
