import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const minimaxComplete = vi.hoisted(() => vi.fn(async () => ({ content: 'from minimax cloud' })))
const sdkComplete = vi.hoisted(() => vi.fn(async () => ({
    content: 'from switched model',
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }],
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
})))
vi.mock('../llm/nova-llm-sdk.js', () => ({
    createNovaLLMClient: vi.fn(async config => ({ getCurrentConfig: () => config, configure: vi.fn(), complete: sdkComplete })),
}))
vi.mock('../llm/providers/minimax.js', () => ({
    createMiniMaxLLM: () => ({ complete: minimaxComplete, getModel: () => 'MiniMax-M3', setModel: () => { } }),
}))
vi.mock('../llm/openai.js', () => ({
    createOpenAILLM: () => ({ complete: async () => ({ content: 'legacy adapter without tools', model: 'gpt-5.5' }) }),
}))
import { availableLLMs, createLLM, invalidateConfigCache, configuredCloudFallbacks } from './llm-factory.js'
import { setNovaConfig } from './config.js'
import * as fallback from '../llm/model-fallback.js'
import { createNovaLLMClient } from '../llm/nova-llm-sdk.js'

const configFile = () => join(process.cwd(), 'xaventra.config.json')
let originalConfig = ''

beforeEach(() => {
    availableLLMs.length = 0
    setNovaConfig({})
    vi.clearAllMocks()
    originalConfig = readFileSync(configFile(), 'utf8')
    availableLLMs.push({ provider: 'local', model: 'local-model', local: true, endpoint: 'http://127.0.0.1:19992/v1' })
})
afterEach(() => {
    writeFileSync(configFile(), originalConfig)
    invalidateConfigCache()
    availableLLMs.length = 0
    vi.restoreAllMocks()
})

describe('runtime model switch', () => {
    it('stops routing prompts to MiniMax after switching to a local model (R2 A6)', async () => {
        vi.spyOn(fallback, 'runWithModelFallback').mockResolvedValue({ result: { content: 'local answer' }, attempts: [], model: 'local-model' } as any)
        const llm: any = await createLLM({ provider: 'minimax', model: 'MiniMax-M3', providers: { minimax: { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:19990/v1' } } })
        expect(await llm.switchModel('local-model', 'local')).toBe(true)
        const result = await llm.complete('Hallo')
        expect(minimaxComplete).not.toHaveBeenCalled()
        expect(result.content).toBe('local answer')
    })

    it('keeps tools, tool turns, options and usage after switching to an OpenAI model (R2 A7)', async () => {
        const cfg = JSON.parse(originalConfig)
        writeFileSync(configFile(), JSON.stringify({ ...cfg, providers: { ...(cfg.providers || {}), openai: { apiKey: 'fixture-openai-key' } } }))
        invalidateConfigCache()
        const llm: any = await createLLM({ provider: 'local', model: 'local-model' })
        expect(await llm.switchModel('gpt-5.5')).toBe(true)
        const messages = [
            { role: 'user', content: 'lies a.txt' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'read_file', arguments: { path: 'b.txt' } }] },
            { role: 'tool', toolCallId: 'c0', content: 'b' },
        ]
        const tools = [{ name: 'read_file', description: 'read', parameters: {} }]
        const result = await llm.complete(messages, tools, { maxTokens: 64 })
        expect(result.toolCalls?.[0]?.name).toBe('read_file')
        expect(result.usage?.totalTokens).toBe(12)
        expect(sdkComplete).toHaveBeenLastCalledWith(messages, tools, { maxTokens: 64 })
    })
})

describe('cloud failover (R2 UEB-22)', () => {
    async function localPrimaryFallingBackTo(model: string) {
        vi.spyOn(fallback, 'runWithModelFallback').mockImplementationOnce(async (options: any) =>
            ({ result: await options.run('openai', model), attempts: [], model } as any))
        const llm: any = await createLLM({ provider: 'local', model: 'local-model' })
        vi.mocked(createNovaLLMClient).mockClear()
        return llm
    }

    it('never routes a prompt silently to a cloud model that was not approved', async () => {
        const llm = await localPrimaryFallingBackTo('gpt-unapproved')
        await expect(llm.complete('Hallo')).rejects.toThrow(/nicht freigegeben/)
        expect(createNovaLLMClient).not.toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai' }))
    })

    it('uses a cloud fallback the owner listed in fallbackModels', async () => {
        const cfg = JSON.parse(originalConfig)
        writeFileSync(configFile(), JSON.stringify({ ...cfg, fallbackModels: ['gpt-approved'] }))
        invalidateConfigCache()
        const llm = await localPrimaryFallingBackTo('gpt-approved')
        await expect(llm.complete('Hallo')).resolves.toMatchObject({ content: 'from switched model' })
        expect(createNovaLLMClient).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', model: 'gpt-approved' }))
    })
})

describe('cloud failover on a worker without the Main GPU (2.89.6)', () => {
    function writeStandbyConfig(fallbackModels: string[], providers: Record<string, unknown>) {
        const cfg = JSON.parse(originalConfig)
        writeFileSync(configFile(), JSON.stringify({
            ...cfg, provider: 'local', model: 'local-model', fallbackModels,
            // The standby has no Main GPU: its own provider sections decide
            // which cloud may be used, so they replace the fixture config.
            providers,
        }))
        invalidateConfigCache()
    }

    it('lists only owner-approved cloud models, never a locally served one', () => {
        writeStandbyConfig(['gpt-approved', 'local-model'], { openai: { apiKey: 'fixture-openai-key' } })
        expect(configuredCloudFallbacks()).toEqual([{ provider: 'openai', model: 'gpt-approved' }])
    })

    it('routes an unlisted-name fallback model to the one cloud provider that has a key', () => {
        writeStandbyConfig(['owner-cloud-model'], { anthropic: { apiKey: 'fixture-claude-key' } })
        expect(configuredCloudFallbacks()).toEqual([{ provider: 'anthropic', model: 'owner-cloud-model' }])
    })

    it('never routes an openrouter or groq key through the OpenAI client (2.89.7)', () => {
        writeStandbyConfig(['owner-cloud-model'], {
            openrouter: { apiKey: 'fixture-openrouter-key', baseUrl: 'https://openrouter.example.com/api/v1' },
            groq: { apiKey: 'fixture-groq-key', baseUrl: 'https://groq.example.com/openai/v1' },
        })
        expect(configuredCloudFallbacks()).toEqual([])
    })

    it('invents no cloud route without a configured provider key', () => {
        writeStandbyConfig(['gpt-approved'], {})
        expect(configuredCloudFallbacks()).toEqual([])
    })

    it('appends the approved cloud models after the local chain', async () => {
        writeStandbyConfig(['gpt-approved'], { openai: { apiKey: 'fixture-openai-key' } })
        const captured = vi.spyOn(fallback, 'runWithModelFallback').mockResolvedValue({ result: { content: 'ok' }, attempts: [], model: 'local-model' } as any)
        const llm: any = await createLLM({ provider: 'local', model: 'local-model' })
        await llm.complete('Hallo')
        const candidates = captured.mock.calls[0][0].fallbacks as Array<{ provider: string; model: string }>
        expect(candidates[0]).toEqual({ provider: 'local', model: 'auto' })
        expect(candidates[candidates.length - 1]).toEqual({ provider: 'openai', model: 'gpt-approved' })
    })

    it('falls over to the configured cloud (vault key) instead of hanging when no local runtime is running', async () => {
        writeStandbyConfig(['gpt-approved'], { openai: { apiKey: 'fixture-openai-key' } })
        // No running local runtime: the configured local model refuses the
        // connection and the fallback chain must reach the approved cloud.
        vi.spyOn(fallback, 'localFallbackCandidates').mockReturnValue([])
        const sdk = vi.mocked(createNovaLLMClient)
        sdk.mockImplementation(async (config: any) => ({
            getCurrentConfig: () => config,
            configure: vi.fn(),
            complete: async () => {
                if (String(config.provider) === 'local') throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:19992')
                return { content: 'from switched model' }
            },
        }))
        try {
            const llm: any = await createLLM({ provider: 'local', model: 'local-model' })
            sdk.mockClear()
            await expect(llm.complete('Hallo')).resolves.toMatchObject({ content: 'from switched model' })
            expect(sdk).toHaveBeenCalledWith(expect.objectContaining({
                provider: 'openai', model: 'gpt-approved', apiKey: 'fixture-openai-key',
            }))
        } finally {
            sdk.mockImplementation(async (config: any) => ({ getCurrentConfig: () => config, configure: vi.fn(), complete: sdkComplete }))
        }
    })
})
