import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { ProviderManifestCatalog, validateProviderManifest } from './provider-manifest.js'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('provider manifest discovery', () => {
    it.each([
        ['openai', 'OPENAI_API_KEY', 'https://api.openai.com/v1/models'],
        ['anthropic', 'ANTHROPIC_API_KEY', 'https://api.anthropic.com/v1/models'],
        ['groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1/models'],
        ['openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/models'],
    ])('keeps the API base path for %s', async (id, env, url) => {
        vi.stubEnv(env, 'synthetic-test-credential')
        const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [null, { id: 'model-a' }] }) })
        vi.stubGlobal('fetch', fetch)
        const catalog = new ProviderManifestCatalog()
        expect(await catalog.refresh(id)).toMatchObject({ status: 'verified', models: [{ id: 'model-a' }] })
        expect(String(fetch.mock.calls[0][0])).toBe(url)
        expect(fetch.mock.calls[0][1].redirect).toBe('error')
        expect(JSON.stringify(catalog.list())).not.toContain('synthetic-test-credential')
    })

    it('rejects remote model URLs and malformed manifests before probing', () => {
        const base = { id: 'example', name: 'Example', protocol: 'openai-chat' as const, discovery: 'refreshable' as const, baseUrl: 'https://example.invalid/v1' }
        for (const modelsEndpoint of ['https://untrusted.invalid/models', '//untrusted.invalid/models', '../models', '/models?key=x']) {
            expect(validateProviderManifest({ ...base, modelsEndpoint })).not.toEqual([])
        }
        expect(validateProviderManifest(null as any)).not.toEqual([])
        expect(validateProviderManifest({ ...base, modelsEndpoint: '/models', models: [null] } as any)).not.toEqual([])
        expect(validateProviderManifest({ ...base, baseUrl: 'http://[::1]:8000/v1', modelsEndpoint: '/models' })).toEqual([])
    })

    it('does not treat template values as credentials', () => {
        vi.stubEnv('OPENAI_API_KEY', 'replace-me')
        const entry = new ProviderManifestCatalog().list().find(item => item.id === 'openai')
        expect(entry?.authenticated).toBe(false)
    })

    it('respects disabled providers and invalidates a failed refresh', async () => {
        vi.stubEnv('GROQ_API_KEY', 'synthetic-test-credential')
        const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'model-a' }] }) })
        vi.stubGlobal('fetch', fetch)
        const catalog = new ProviderManifestCatalog()
        await catalog.refresh('groq')
        fetch.mockRejectedValueOnce(new Error('offline'))
        await expect(catalog.refresh('groq')).rejects.toThrow('offline')
        expect(catalog.list().find(item => item.id === 'groq')?.status).not.toBe('verified')
        writeFileSync('nova.config.json', JSON.stringify({ providers: { groq: { enabled: false } } }))
        fetch.mockClear()
        expect(await catalog.refresh('groq')).toMatchObject({ status: 'installed', configured: false })
        expect(fetch).not.toHaveBeenCalled()
    })
})
