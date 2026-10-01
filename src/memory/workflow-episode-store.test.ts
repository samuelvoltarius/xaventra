import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { WorkflowEpisodeStore } from './workflow-episode-store.js'

describe('validated workflow learning', () => {
    it('stores parameter shapes but no values and retracts rejected runs', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-episodes-'))
        const store = new WorkflowEpisodeStore(join(dir, 'episodes.json'))
        for (let index = 0; index < 3; index++) {
            const episode = store.record({
                runId: `run-${index}`, userId: 'user:a', requestSummary: 'deploy app', taskType: 'device-action',
                steps: [{ toolName: 'mesh_deploy', parameterKeys: ['host', 'token'] }], success: true,
                durationMs: 10, costUsd: 0,
            })!
            expect(JSON.stringify(episode)).not.toContain('secret-value')
        }
        expect(store.findRelevant('user:a', 'deploy')).toHaveLength(3)

        expect(store.retractRun('run-2', 'user:a', 'user rejected outcome')).toBe(true)
        expect(store.findRelevant('user:a', 'deploy')).toHaveLength(2)
        expect(store.record({
            runId: 'run-2', userId: 'user:a', requestSummary: 'deploy app', taskType: 'device-action',
            steps: [{ toolName: 'mesh_deploy', parameterKeys: ['host'] }], success: true,
            durationMs: 10, costUsd: 0,
        })).toBeNull()
    })
})
