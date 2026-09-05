import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { WorkflowEpisodeStore } from './workflow-episode-store.js'
import { PersonalSkillCompiler } from '../learning/personal-skill-compiler.js'

describe('validated workflow learning', () => {
    it('stores parameter shapes but no values and proposes only after three successes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-episodes-'))
        const store = new WorkflowEpisodeStore(join(dir, 'episodes.json'))
        const compiler = new PersonalSkillCompiler(join(dir, 'skills.json'))
        for (let index = 0; index < 3; index++) {
            const episode = store.record({
                runId: `run-${index}`, userId: 'user:a', requestSummary: 'deploy app', taskType: 'device-action',
                steps: [{ toolName: 'mesh_deploy', parameterKeys: ['host', 'token'] }], success: true,
                durationMs: 10, costUsd: 0,
            })!
            compiler.observe(episode)
        }
        const proposal = compiler.list('user:a')[0]
        expect(proposal.status).toBe('proposed')
        expect(JSON.stringify(proposal)).not.toContain('secret-value')
        expect(store.findRelevant('user:a', 'deploy')).toHaveLength(3)

        expect(store.retractRun('run-2', 'user:a', 'user rejected outcome')).toBe(true)
        expect(store.findRelevant('user:a', 'deploy')).toHaveLength(2)
        expect(store.record({
            runId: 'run-2', userId: 'user:a', requestSummary: 'deploy app', taskType: 'device-action',
            steps: [{ toolName: 'mesh_deploy', parameterKeys: ['host'] }], success: true,
            durationMs: 10, costUsd: 0,
        })).toBeNull()
        expect(compiler.retractRun('run-2')).toBe(1)
        expect(compiler.list('user:a')[0].status).toBe('degraded')
    })
})
