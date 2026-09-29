import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scan = vi.hoisted(() => ({ services: [] as any[] }))
vi.mock('../mesh/ai-scanner.js', () => ({ scanAllAIServices: async () => ({ services: scan.services }) }))
vi.mock('../llm/codex-cli-adapter.js', () => ({
    getCodexDiscoveryStatus: () => ({ available: true, authenticated: true, models: ['gpt-5.5'] }),
}))
import { getCapabilityCache, refreshModels } from './model-resolver.js'

const configFile = () => join(process.cwd(), 'xaventra.config.json')
let originalConfig = ''
const ollama = (status: string) => ({
    name: 'ollama', provider: 'ollama', type: 'llm', status, host: '127.0.0.1',
    endpoint: 'http://127.0.0.1:11434', models: ['qwen2.5:7b'],
})

beforeEach(() => {
    originalConfig = readFileSync(configFile(), 'utf8')
    writeFileSync(configFile(), JSON.stringify({ ...JSON.parse(originalConfig), provider: 'local', model: 'auto', models: {} }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [], models: [] }), { status: 200 }))
})
afterEach(() => {
    writeFileSync(configFile(), originalConfig)
    vi.restoreAllMocks()
})

describe('model resolver order (R2 UEB-23)', () => {
    it('prefers a running local model over the OpenAI/Codex subscription', async () => {
        scan.services = [ollama('running')]
        await refreshModels()
        expect(getCapabilityCache()?.resolved.chat).toMatchObject({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434' })
    })

    it('does not let an installed but stopped local model shadow the cloud fallback', async () => {
        scan.services = [ollama('installed')]
        await refreshModels()
        expect(getCapabilityCache()?.resolved.chat?.provider).toBe('openai-codex')
    })
})
