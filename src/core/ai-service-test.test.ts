import { describe, expect, it, vi } from 'vitest'
import { bindAiTestTargets, handleAiServiceTestTurn, isAiServiceTestRequest, testAiTarget, type AiTestTarget } from './ai-service-test.js'
import { aiTestAudio } from './ai-test-audio.js'

const target = (type = 'llm', name = 'vllm', models = ['chat-fixture']): AiTestTarget => ({ node: 'worker-fixture', address: '192.0.2.5', runtime: { id: 'runtime-fixture', name, type: type as any, models, endpoint: 'http://192.0.2.5:8000', status: 'running', capabilities: [], verifiedAt: new Date().toISOString(), verificationSource: 'probe' } })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('bounded AI service function tests', () => {
    it('matches the exact owner request, but never mixed write requests', () => {
        expect(isAiServiceTestRequest('Mach mir einen Check von allen ai Diensten die auf den nodes laufen')).toBe(true)
        expect(isAiServiceTestRequest('Teste alle KI-Dienste')).toBe(true)
        expect(isAiServiceTestRequest('Teste alle KI-Dienste und installiere etwas')).toBe(false)
    })
    it('offers, binds Ja to the same principal/channel, consumes once', async () => {
        const collect = vi.fn(async () => [target()]); const run = vi.fn(async () => 'tested')
        expect(await handleAiServiceTestTurn('Telegram', 'fixture-a', 'Teste alle KI-Dienste', true, collect, run)).toContain('Antworte mit Ja')
        expect(await handleAiServiceTestTurn('Telegram', 'fixture-b', 'Ja', true, collect, run)).toBeNull()
        expect(await handleAiServiceTestTurn('CLI', 'fixture-a', 'Ja', true, collect, run)).toBeNull()
        expect(run).not.toHaveBeenCalled()
        expect(await handleAiServiceTestTurn('Telegram', 'fixture-a', 'Ja', true, collect, run)).toBe('tested')
        expect(await handleAiServiceTestTurn('Telegram', 'fixture-a', 'Ja', true, collect, run)).toBeNull()
        expect(run).toHaveBeenCalledTimes(1)
    })
    it('denies non-owner/group, and cancels after unrelated turns or clear', async () => {
        const collect = vi.fn(async () => [target()]); const run = vi.fn(async () => 'tested')
        expect(await handleAiServiceTestTurn('Telegram', 'fixture-c', 'Teste alle KI-Dienste', false, collect, run)).toContain('Owner')
        expect(collect).not.toHaveBeenCalled()
        await handleAiServiceTestTurn('Telegram', 'fixture-c', 'Teste alle KI-Dienste', true, collect, run)
        await handleAiServiceTestTurn('Telegram', 'fixture-c', '/clear', true, collect, run)
        expect(await handleAiServiceTestTurn('Telegram', 'fixture-c', 'Ja', true, collect, run)).toBeNull()
        expect(run).not.toHaveBeenCalled()
    })
    it('expires confirmations rather than silently testing old targets', async () => {
        vi.useFakeTimers()
        try {
            const run = vi.fn(async () => 'tested')
            await handleAiServiceTestTurn('CLI', 'expiry-fixture', 'Teste alle KI-Dienste', true, async () => [target()], run)
            vi.advanceTimersByTime(600001)
            expect(await handleAiServiceTestTurn('CLI', 'expiry-fixture', 'Ja', true, async () => [target()], run)).toContain('abgelaufen')
            expect(run).not.toHaveBeenCalled()
        } finally { vi.useRealTimers() }
    })
    it('requires exact live node/IP/port, never peers advertising loopback or credentials', () => {
        const runtime = target().runtime
        const node: any = { id: 'worker-fixture', status: 'online', lastHeartbeat: new Date().toISOString(), runtimes: [runtime] }
        const ips = new Map([['worker-fixture', ['192.0.2.5', '127.0.0.1']]])
        expect(bindAiTestTargets([node], 'local-fixture', ips)).toHaveLength(1)
        for (const endpoint of ['http://127.0.0.1:8000', 'http://192.0.2.6:8000', 'http://192.0.2.5:22', 'http://user:pass@192.0.2.5:8000', 'http://192.0.2.5:8000/?key=fixture']) {
            expect(bindAiTestTargets([{ ...node, runtimes: [{ ...runtime, endpoint }] }], 'local-fixture', ips)).toHaveLength(0)
        }
        expect(bindAiTestTargets([{ ...node, status: 'offline' }], 'local-fixture', ips)).toHaveLength(0)
    })
    it('uses a real chat completion, not models or health as inference proof', async () => {
        const fetch = vi.fn(async () => json({ choices: [{ message: { content: 'OK' } }] }))
        expect((await testAiTarget(target(), fetch as any))[0].state).toBe('passed')
        expect(fetch.mock.calls[0][0]).toContain('/v1/chat/completions')
        const opts: any = fetch.mock.calls[0][1]
        expect(opts.headers.Authorization).toBeUndefined(); expect(opts.redirect).toBe('error')
        expect(JSON.parse(opts.body).max_tokens).toBe(16)
        expect((await testAiTarget(target(), async () => json({ data: [{ id: 'chat-fixture' }] })))[0].state).toBe('failed')
    })
    it('validates embeddings and exposes HTTP failures without response secrets', async () => {
        expect((await testAiTarget(target('embedding', 'ollama', ['embed-fixture']), async () => json({ embeddings: [[1, 2, 3]] })))[0].state).toBe('passed')
        expect((await testAiTarget(target('embedding', 'ollama'), async () => json({ embeddings: [[]] })))[0].state).toBe('failed')
        expect((await testAiTarget(target(), async () => json({ token: 'do-not-display' }, 401)))[0].detail).toBe('HTTP 401')
    })
    it('posts synthetic speech and requires the expected transcript, not empty 200', async () => {
        const fetch = vi.fn(async () => json({ text: 'This is a speech recognition test.' }))
        expect((await testAiTarget(target('stt', 'whisper', ['whisper-fixture']), fetch as any))[0].state).toBe('passed')
        const opts: any = fetch.mock.calls[0][1]
        expect(opts.body).toBeInstanceOf(Uint8Array)
        expect(Buffer.from(opts.body).toString('latin1')).toContain('synthetic-speech-test.wav')
        expect((await testAiTarget(target('stt'), async () => json({ text: '' })))[0].state).toBe('failed')
        expect(aiTestAudio().toString('ascii', 0, 4)).toBe('RIFF')
    })
    it('does not count unsupported transports as success', async () => {
        const fetch = vi.fn()
        expect((await testAiTarget(target('codex'), fetch))[0].state).toBe('not-tested')
        expect(fetch).not.toHaveBeenCalled()
    })
})
