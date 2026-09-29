import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runner = vi.hoisted(() => ({ runNovaAgent: vi.fn() }))
vi.mock('./nova-runner.js', () => runner)
vi.mock('../llm/nova-llm-sdk.js', () => ({ createNovaLLMClient: async () => ({}) }))
vi.mock('../tools/complete-registry.js', () => ({
    ALL_TOOLS: ['web_search', 'read_file', 'fetch_url', 'run_command'].map(name => ({ name })),
}))

// The orchestrator appends its audit log below process.cwd().
const sandbox = join(process.cwd(), '.nova-test-tmp', `subagents-${randomUUID()}`)
mkdirSync(sandbox, { recursive: true })
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

await import('./nova-runner.js')
const { withExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
const { listSubagents, spawnSubagent, spawnSubagentsParallel } = await import('./subagent-orchestrator.js')

const done = { content: 'ok', toolsUsed: [] }

beforeEach(() => {
    runner.runNovaAgent.mockReset()
    runner.runNovaAgent.mockResolvedValue(done)
})
afterEach(() => { vi.mocked(Date.now).mockRestore?.() })

describe('subagent orchestrator', () => {
    it('runs under the parent principal with a unique conversation per subagent', async () => {
        await withExecutionPolicyContext({ userId: 'alice', authUserId: 'tg-1', channel: 'Telegram' }, async () => {
            await spawnSubagent({ task: 'research A' })
            await spawnSubagent({ task: 'research B' })
        })
        const calls = runner.runNovaAgent.mock.calls.map(call => call[0] as any)
        expect(calls.map(call => call.userId)).toEqual(['alice', 'alice'])
        expect(calls.map(call => call.authUserId)).toEqual(['tg-1', 'tg-1'])
        expect(calls[0].conversationId).toMatch(/^subagent:/)
        expect(calls[0].conversationId).not.toBe(calls[1].conversationId)
    })

    it('keeps an explicit task principal', async () => {
        await spawnSubagent({ task: 'explicit', userId: 'bob' })
        expect((runner.runNovaAgent.mock.calls[0][0] as any).userId).toBe('bob')
    })

    it('accepts tools as a comma string in spawn_subagents_parallel', async () => {
        const summary = await spawnSubagentsParallel([{ task: 'look up', tools: 'web_search, read_file' as any }])
        expect(summary).toContain('COMPLETED')
        const tools = (runner.runNovaAgent.mock.calls[0][0] as any).tools.map((tool: any) => tool.name)
        expect(tools).toEqual(['web_search', 'read_file'])
    })

    it('keeps the concurrency slot until a timed-out run has actually settled', async () => {
        const releases: Array<() => void> = []
        runner.runNovaAgent.mockImplementation(() => new Promise(resolve => releases.push(() => resolve(done))))
        // Start the six runs one after another so each is inside runNovaAgent
        // (a hung agent that ignores the abort) before its deadline fires.
        const pending: Array<Promise<any>> = []
        for (let index = 0; index < 6; index++) {
            pending.push(spawnSubagent({ task: `slow ${index}`, timeoutMs: 250 }))
            await vi.waitFor(() => expect(releases.length).toBe(index + 1))
        }
        const timedOut = await Promise.all(pending)
        expect(timedOut.every(result => result.status === 'timeout')).toBe(true)

        const rejected = await spawnSubagent({ task: 'one too many', timeoutMs: 5 })
        expect(rejected.error).toMatch(/Concurrency limit/)

        runner.runNovaAgent.mockResolvedValue(done)
        releases.forEach(release => release())
        await vi.waitFor(async () => {
            const accepted = await spawnSubagent({ task: 'after settle' })
            expect(accepted.status).toBe('completed')
        })
    })

    it('prunes finished subagents after the retention period and caps the registry', async () => {
        for (let index = 0; index < 120; index++) await spawnSubagent({ task: `quick ${index}` })
        expect(listSubagents().length).toBeLessThanOrEqual(100)

        const now = Date.now()
        vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
        expect(listSubagents()).toEqual([])
    })
})
