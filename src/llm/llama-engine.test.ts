import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
const bytes = Buffer.from('GGUF-synthetic-engine-contract-fixture')
const loadModel = vi.fn(), modelDispose = vi.fn(), llamaDispose = vi.fn(), contextDispose = vi.fn(), prompt = vi.fn()
let engine: typeof import('./llama-engine.js')
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks()
    rmSync('models', { recursive: true, force: true }); mkdirSync('models')
    writeFileSync('xaventra.config.json', JSON.stringify({ doctorModel: 'fixture.gguf', doctorModelSizeBytes: bytes.length, doctorModelSha256: createHash('sha256').update(bytes).digest('hex') }))
    vi.doMock('node:child_process', () => ({ spawnSync: () => ({ status: 1, stdout: '' }) }))
    loadModel.mockResolvedValue({ dispose: modelDispose, createContext: async () => ({ getSequence: () => ({}), dispose: contextDispose }) })
    prompt.mockResolvedValue('{}')
    vi.doMock('node-llama-cpp', () => ({ getLlamaGpuTypes: async () => [], LlamaLogLevel: { warn: 1 },
        getLlama: async () => ({ loadModel, dispose: llamaDispose }),
        LlamaChatSession: class { prompt = prompt },
    }))
    engine = await import('./llama-engine.js')
})
afterEach(async () => { await engine.disposeLlamaEngine(); vi.doUnmock('node-llama-cpp'); vi.doUnmock('node:child_process'); vi.resetModules() })
describe('Doctor engine lifecycle with stubbed native backend (not inference evidence)', () => {
    it('retries in the same process after the initially missing artifact is installed', async () => {
        expect(await engine.getLlamaEngine()).toBeNull()
        writeFileSync('models/fixture.gguf', bytes)
        expect((await engine.getLlamaEngine())?.isReady).toBe(true)
        expect(loadModel).toHaveBeenCalledTimes(1)
        expect(engine.getDoctorInfo().integrity).toBe('verified')
    })
    it('never passes corrupt bytes to the native parser and can retry after repair', async () => {
        writeFileSync('models/fixture.gguf', Buffer.alloc(bytes.length))
        expect(await engine.getLlamaEngine()).toBeNull()
        expect(loadModel).not.toHaveBeenCalled()
        expect(llamaDispose).toHaveBeenCalled()
        writeFileSync('models/fixture.gguf', bytes)
        expect(await engine.getLlamaEngine()).not.toBeNull()
    })
    it('disables a loaded engine and disposes failed inference contexts', async () => {
        writeFileSync('models/fixture.gguf', bytes)
        const loaded = await engine.getLlamaEngine()
        prompt.mockRejectedValue(new Error('fixture inference failed'))
        await expect(loaded!.complete('fixture')).rejects.toThrow()
        expect(contextDispose).toHaveBeenCalledTimes(1)
        writeFileSync('xaventra.config.json', '{"doctorModel":"off"}')
        expect(await engine.getLlamaEngine()).toBeNull()
        expect(modelDispose).toHaveBeenCalledTimes(1)
        expect(engine.getDoctorInfo().loaded).toBe(false)
    })
})
