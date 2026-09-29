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
import { availableLLMs, createLLM, invalidateConfigCache } from './llm-factory.js'
import { setNovaConfig } from './config.js'
import * as fallback from '../llm/model-fallback.js'

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
