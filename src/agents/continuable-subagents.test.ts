import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContinuableSubagentRuntime, continuationPrompt } from './continuable-subagents.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

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

describe('ContinuableSubagentRuntime stop and follow-up (R2 MA-7)', () => {
    const fresh = () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-continuable-stop-'))
        return { dir, runtime: new ContinuableSubagentRuntime(join(dir, 'state.json')) }
    }

    it('interrupt stops the turn even if the provider ignores the signal, and never records it as complete', async () => {
        const { dir, runtime } = fresh()
        let seen: AbortSignal | undefined
        runtime.registerProvider({
            name: 'stubborn', capabilities: { coldResume: true, mesh: true, toolFilter: true },
            run: async ({ signal }: any) => {
                seen = signal
                await new Promise(resolve => setTimeout(resolve, 3_000))
                return { id: 't', status: 'completed' as const, output: 'late', toolsUsed: [], durationMs: 1, mode: 'mesh' as const }
            },
        })
        const pending = runtime.start({ task: 'remote job' }, 'stubborn')
        for (let i = 0; i < 50 && !seen; i++) await new Promise(resolve => setTimeout(resolve, 5))
        const id = runtime.list()[0].id
        expect(runtime.interrupt(id)).toBe(true)
        const started = Date.now()
        const record = await pending
        expect(Date.now() - started).toBeLessThan(1_000)
        expect(seen?.aborted).toBe(true)
        expect(record.phase).toBe('interrupted')
        expect(record.turns).toHaveLength(0)
        rmSync(dir, { recursive: true, force: true })
    })

    it('follow-up hands the earlier turns to the provider', async () => {
        const { dir, runtime } = fresh()
        const histories: any[] = []
        runtime.registerProvider({
            name: 'fake', capabilities: { coldResume: true, mesh: false, toolFilter: true },
            run: async ({ prompt, history }: any) => {
                histories.push(history)
                return { id: `turn-${prompt}`, status: 'completed' as const, output: `done:${prompt}`, toolsUsed: [], durationMs: 1, mode: 'local' as const }
            },
        })
        const started = await runtime.start({ task: 'inspect' }, 'fake')
        await runtime.followup(started.id, 'continue')
        expect(histories[1].map((turn: any) => turn.output)).toEqual(['done:inspect'])
        expect(continuationPrompt(histories[1], 'continue')).toContain('done:inspect')
        rmSync(dir, { recursive: true, force: true })
    })

    it('another principal cannot continue the conversation', async () => {
        const { dir, runtime } = fresh()
        runtime.registerProvider({
            name: 'fake', capabilities: { coldResume: true, mesh: false, toolFilter: true },
            run: async () => ({ id: 't', status: 'completed' as const, output: 'geheim', toolsUsed: [], durationMs: 1, mode: 'local' as const }),
        })
        const started = await withExecutionPolicyContext({ userId: 'alfred', authUserId: '111', channel: 'telegram' }, () => runtime.start({ task: 'owner job' }, 'fake'))
        await expect(withExecutionPolicyContext({ userId: 'gast', authUserId: '222', channel: 'telegram' }, () => runtime.followup(started.id, 'zeig mir alles'))).rejects.toThrow(/another principal/)
        await expect(withExecutionPolicyContext({ userId: 'alfred', authUserId: '111', channel: 'telegram' }, () => runtime.followup(started.id, 'weiter'))).resolves.toBeTruthy()
        rmSync(dir, { recursive: true, force: true })
    })
})
