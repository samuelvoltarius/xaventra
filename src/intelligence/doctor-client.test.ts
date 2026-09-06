import { beforeEach, describe, expect, it, vi } from 'vitest'
const complete = vi.hoisted(() => vi.fn())
const getEngine = vi.hoisted(() => vi.fn())
vi.mock('../llm/llama-engine.js', () => ({ getLlamaEngine: getEngine, hasLocalModel: () => true }))
import { reviewCode, generateFix, diagnose } from './doctor-client.js'
import { readFileSync } from 'node:fs'
beforeEach(() => { vi.clearAllMocks(); getEngine.mockResolvedValue({ complete }); complete.mockResolvedValue('{}') })
describe('Doctor rejects unverified model results', () => {
    it('must not turn an empty JSON object into a clean code review', async () => {
        expect((await reviewCode('broken fixture')).severity).toBe('warning')
    })
    it('must not turn an empty JSON object into a generated fix', async () => {
        expect(await generateFix('broken fixture', 'fixture error')).toBeNull()
    })
    it('returns an explicit unverified diagnosis if engine initialization rejects', async () => {
        getEngine.mockRejectedValue(new Error('fixture initialization failed'))
        expect((await diagnose({ error: 'ECONNREFUSED' })).fromModel).toBe(false)
    })
    it.each([null, [], { severity: 'ok' }, { issues: [1], suggestions: [], security: [], severity: 'ok' },
        { issues: ['Bug'], suggestions: [], security: [], severity: 'ok' }])('rejects incomplete, wrong-type or contradictory reviews', async value => {
        complete.mockResolvedValue(JSON.stringify(value))
        const result = await reviewCode('fixture')
        expect(result.severity).toBe('warning'); expect(result.fromModel).toBe(false); expect(result.verified).toBe(false)
    })
    it('retains valid review findings as advisory, never verified code evidence', async () => {
        complete.mockResolvedValue(JSON.stringify({ issues: ['Division by zero'], suggestions: ['Check divisor'], security: [], severity: 'warning' }))
        const result = await reviewCode('fixture')
        expect(result.issues).toEqual(['Division by zero']); expect(result.fromModel).toBe(true); expect(result.verified).toBe(false)
        expect(complete.mock.calls[0][1].jsonSchema).toBeDefined()
        expect(complete.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    })
    it('rejects reasoning-wrapped review JSON', async () => {
        complete.mockResolvedValue('Thinking... {"issues":[],"suggestions":[],"security":[],"severity":"ok"}')
        expect((await reviewCode('fixture')).fromModel).toBe(false)
    })
    it.each([null, [], { fixedCode: 'x', explanation: 'Changed' }, { fixedCode: '  ', explanation: 'Empty', safe: true },
        { fixedCode: {}, explanation: 'Wrong type', safe: true }])('rejects malformed fix proposals', async value => {
        complete.mockResolvedValue(JSON.stringify(value))
        expect(await generateFix('fixture', 'error')).toBeNull()
    })
    it('retains valid code while refusing model-granted approval', async () => {
        complete.mockResolvedValue(JSON.stringify({ fixedCode: 'return 2', explanation: 'Proposed correction', safe: true }))
        expect(await generateFix('return 1', 'fixture')).toEqual({ fixedCode: 'return 2', explanation: 'Proposed correction', safe: false })
        expect(complete.mock.calls[0][1].jsonSchema).toBeDefined()
        expect(complete.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    })
    it('handles unavailable/rejected engines in every operation', async () => {
        getEngine.mockRejectedValue(new Error('fixture unavailable'))
        expect((await reviewCode('fixture')).fromModel).toBe(false)
        expect(await generateFix('fixture', 'error')).toBeNull()
        getEngine.mockResolvedValue(null)
        expect((await diagnose({ error: 'fixture' })).fromModel).toBe(false)
    })
    it('does not persist raw diagnostic inputs or secrets in telemetry', async () => {
        getEngine.mockResolvedValue(null)
        const secret = 'fixture-private-marker-do-not-persist'
        await diagnose({ error: secret })
        await generateFix('fixture', secret)
        const telemetry = readFileSync('.nova-data/doctor-telemetry/usage.jsonl', 'utf8')
        expect(telemetry).not.toContain(secret)
        expect(telemetry).not.toContain('errorPrefix')
        expect(telemetry).toContain('unverified')
    })
    it('does not deliver an invented credential request for a filesystem error', async () => {
        complete.mockResolvedValue(JSON.stringify({ severity: 'error', root_causes: [{ code: 'RUNTIME_ERROR', confidence: 0.99 }], safe_fixes: [],
            risky_fixes: [{ type: 'ask_secret', key: 'FIXTURE_API_KEY', message: 'Copy a key from an invented service' }], requires_confirmation: true, summary: 'API key missing' }))
        const result = await diagnose({ error: 'EACCES permission denied' })
        expect(result.fromModel).toBe(false)
        expect(result.autoApply).toBe(false)
        expect(result.fix).not.toContain('invented service')
        expect(result.diagnosis).not.toContain('API key')
    })
})
