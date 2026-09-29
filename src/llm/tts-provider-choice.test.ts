import { afterEach, describe, expect, it, vi } from 'vitest'

const fakeConfig = vi.hoisted(() => ({ json: {} as Record<string, any> }))
const CONFIG_PATH = 'Z:/fake/xaventra.config.json'

vi.mock('../config/config-path.js', () => ({ resolveConfigPath: () => CONFIG_PATH }))
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
        ...actual,
        existsSync: (p: any) => p === CONFIG_PATH || actual.existsSync(p),
        readFileSync: (p: any, ...rest: any[]) => p === CONFIG_PATH
            ? JSON.stringify(fakeConfig.json)
            : (actual.readFileSync as any)(p, ...rest),
    }
})

import { ProviderRegistry } from './provider-registry.js'

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('R2 L8: TTS is not switched to the cloud because a key exists', () => {
    it('keeps a local engine even with OPENAI_API_KEY and a MiniMax key present', () => {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test')
        fakeConfig.json = { voice: { enabled: true, ttsEngine: 'chatterbox' }, providers: { minimax: { apiKey: 'mm-test' } } }

        expect(new ProviderRegistry().getBestTTSProvider()).toBeNull()
    })

    it('returns the cloud TTS only when it is the configured engine', () => {
        fakeConfig.json = { voice: { enabled: true, ttsEngine: 'minimax' }, providers: { minimax: { apiKey: 'mm-test' } } }

        expect(new ProviderRegistry().getBestTTSProvider()?.provider.id).toBe('minimax')
    })
})
