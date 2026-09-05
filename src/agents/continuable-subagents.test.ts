import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContinuableSubagentRuntime } from './continuable-subagents.js'

describe('ContinuableSubagentRuntime', () => {
    it('cold-resumes a durable conversation through a provider seam', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-continuable-'))
        const path = join(dir, 'state.json')
        const provider = {
            name: 'fake', capabilities: { coldResume: true, mesh: false, toolFilter: true },
            run: async ({ prompt }: any) => ({ id: `turn-${prompt}`, status: 'completed' as const, output: `done:${prompt}`, toolsUsed: ['read_file'], durationMs: 1, mode: 'local' as const }),
        }
        const first = new ContinuableSubagentRuntime(path)
        first.registerProvider(provider)
        const started = await first.start({ task: 'inspect' }, 'fake')

        const resumed = new ContinuableSubagentRuntime(path)
        resumed.registerProvider(provider)
        const final = await resumed.followup(started.id, 'continue')
        expect(final.turns).toHaveLength(2)
        expect(final.turns[1].output).toBe('done:continue')
        expect(final.principalId).toBe(`subagent:${started.id}`)
        rmSync(dir, { recursive: true, force: true })
    })
})
