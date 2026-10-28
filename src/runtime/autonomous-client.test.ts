import { describe, expect, it, vi } from 'vitest'
import { createAutonomousClient } from './autonomous-client.js'

// Live VM 130, 28.10.2026 21:47 after B5 (providers.local off, no vLLM/Ollama):
// "[Nova] ⚠ Learning Runtime offline — kein eigenes lokales Modell erreichbar", Repair likewise.
const nothingLocal = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
const liveConfig = { provider: 'minimax', model: 'MiniMax-M3.1-Flash', providers: { local: { enabled: false, baseUrl: 'http://100.64.0.10:8000/v1' }, minimax: { apiKeyRef: 'auth:minimax' } } }
const key = () => 'mm-test-key'

describe('background runtime client', () => {
    it('without the owner switch stays offline (no silent cloud)', async () => {
        expect(await createAutonomousClient(liveConfig, 'auto', 45_000, { fetchImpl: nothingLocal, keyOf: key, timeoutMs: 10 })).toBeNull()
    })

    it('with the owner switch the learning runtime runs on MiniMax', async () => {
        const runtime = await createAutonomousClient({ ...liveConfig, autonomy: { cloudServiceModel: { enabled: true } } }, 'auto', 45_000, { fetchImpl: nothingLocal, keyOf: key, timeoutMs: 10 })
        expect(runtime).toMatchObject({ provider: 'minimax', model: 'MiniMax-M3.1-Flash', localOnly: false })
        expect(typeof runtime!.client.complete).toBe('function')
    })

    it('a reachable local model still wins over the approved cloud model', async () => {
        const local = vi.fn(async () => Response.json({ data: [{ id: 'qwen3-8b' }] })) as unknown as typeof fetch
        const runtime = await createAutonomousClient({ provider: 'minimax', providers: { vllm: { baseUrl: 'http://127.0.0.1:8000' } }, autonomy: { cloudServiceModel: { enabled: true } } }, 'auto', 45_000, { fetchImpl: local, keyOf: key, timeoutMs: 10 })
        expect(runtime).toMatchObject({ provider: 'vllm', model: 'qwen3-8b', localOnly: true })
    })
})
