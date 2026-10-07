import { describe, expect, it } from 'vitest'
import { limitStopNotice, runLimits, toolTimeoutClass, toolTimeoutMs } from './run-limits.js'
import { selectContextPolicy } from './context-policy.js'
import { runtimeProfile } from './runtime-profile.js'

// 2.89 Punkt 4: live NOVA_OS_MODE is not set, so the Main ran with 3 tool
// rounds, 30 s per tool and 300 s overall (context budget 4/12/24 calls).

describe('run limits for the normal Main', () => {
    it('normal defaults give multi-step room; NovaOS stays the upper bound', () => {
        const normal = runLimits({})
        const os = runLimits({ NOVA_OS_MODE: 'true' })
        expect(normal.maxToolRounds).toBeGreaterThanOrEqual(12)
        expect(normal.maxToolRounds).toBeLessThanOrEqual(20)
        expect(normal.totalTimeoutMs).toBeGreaterThanOrEqual(600_000)
        expect(normal.toolTimeoutMs.default).toBeGreaterThan(30_000)
        expect(os.maxToolRounds).toBeGreaterThanOrEqual(normal.maxToolRounds)
        expect(os.totalTimeoutMs).toBeGreaterThanOrEqual(normal.totalTimeoutMs)
        for (const kind of Object.keys(normal.toolTimeoutMs) as Array<keyof typeof normal.toolTimeoutMs>) {
            expect(os.toolTimeoutMs[kind]).toBeGreaterThanOrEqual(normal.toolTimeoutMs[kind])
        }
    })
    it('explicit environment values win', () => {
        expect(runLimits({ NOVA_MAX_TOOL_ROUNDS: '5', NOVA_AGENT_TIMEOUT_MS: '1000' })).toMatchObject({ maxToolRounds: 5, totalTimeoutMs: 1000 })
        expect(runLimits({ NOVA_MAX_TOOL_ROUNDS: 'abc' }).maxToolRounds).toBe(runLimits({}).maxToolRounds)
    })
    it('tool timeouts follow the tool kind', () => {
        const limits = runLimits({})
        expect(toolTimeoutClass('ssh_command')).toBe('slow')
        expect(toolTimeoutClass('spawn_subagents_parallel')).toBe('slow')
        expect(toolTimeoutClass('desktop_screenshot')).toBe('capture')
        expect(toolTimeoutClass('generate_image')).toBe('media')
        expect(toolTimeoutClass('browser_click')).toBe('browser')
        expect(toolTimeoutClass('hass_service')).toBe('default')
        expect(toolTimeoutMs('ssh_command', limits)).toBeGreaterThan(toolTimeoutMs('hass_service', limits))
    })
    it('the context budget of the normal Main allows a multi-step task', () => {
        const previous = process.env.NOVA_OS_MODE
        delete process.env.NOVA_OS_MODE
        try {
            const fast = selectContextPolicy('Stell die Heizung auf 21 Grad').executionBudget
            expect(fast.maxToolCalls).toBeGreaterThanOrEqual(8)
            expect(fast.timeoutMs).toBeGreaterThanOrEqual(180_000)
        } finally { if (previous !== undefined) process.env.NOVA_OS_MODE = previous }
    })
    it('stops are reported honestly by kind', () => {
        const limits = runLimits({})
        expect(limitStopNotice(Object.assign(new Error('Max turns (16) exceeded'), { name: 'MaxTurnsExceededError' }), limits)).toContain(`${limits.maxToolRounds} Arbeitsschritten`)
        expect(limitStopNotice(new Error('[Timeout] Tool: hass_service exceeded 60000ms'), limits)).toContain('hass_service hat länger als 60 s')
        expect(limitStopNotice(new Error('Task execution deadline exceeded'), limits)).toContain('Zeitgrenze')
        expect(limitStopNotice(new Error('Task tool-call budget exhausted'), limits)).toContain('Werkzeugaufrufe')
        expect(limitStopNotice(new Error('policy gate'), limits)).toBe('')
    })
})


describe('one runtime profile', () => {
    it('the Main is an owner assistant unless NovaOS or a worker node', () => {
        expect(runtimeProfile({})).toBe('owner-assistant')
        expect(runtimeProfile({ NOVA_OS_MODE: 'true' })).toBe('novaos')
        expect(runtimeProfile({ NOVA_NODE_ONLY: 'true' })).toBe('worker')
    })
    it('the owner assistant answers with more than 1024 tokens in fast mode', () => {
        const previous = process.env.NOVA_OS_MODE
        delete process.env.NOVA_OS_MODE
        try { expect(selectContextPolicy('Wie spät ist es?').executionBudget.maxOutputTokens).toBeGreaterThan(1024) }
        finally { if (previous !== undefined) process.env.NOVA_OS_MODE = previous }
    })
})
