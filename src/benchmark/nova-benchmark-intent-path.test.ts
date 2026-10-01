import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentBackend } from '../agents/agent-backend.js'
import { OutcomeLedger, withOutcomeLedger } from '../core/outcome-ledger.js'
import { getBenchmarkScenarios } from './benchmark-lab.js'
import { executeNovaBenchmarkScenario } from './nova-benchmark-runner.js'

// 01.10.2026: the tools-6 probe failed only in a worktree whose path contained
// "screenshot"; the fixture path inside the prompt was read as the user intent.
describe('benchmark intent ignores the fixture path', () => {
    it('a workspace path containing "screenshot" does not turn a tools scenario into a screenshot task', async () => {
        const root = mkdtempSync(join(tmpdir(), 'nbr-screenshot-'))
        const ledger = new OutcomeLedger(join(root, 'ledger'), false)
        const backend: AgentBackend = {
            name: 'fixture-planner',
            run: async input => ({ runId: input.contract.id, backend: 'fixture-planner', status: 'completed', output: 'x\nBENCHMARK_RESULT: READY', toolsUsed: [] }),
        }
        const scenario = getBenchmarkScenarios().find(item => item.id === 'tools-6')!
        const observation = await withOutcomeLedger(ledger,
            () => executeNovaBenchmarkScenario(backend, scenario, join(root, 'screenshot-workspace')))
        expect(observation.success).toBe(true)
    })
})
