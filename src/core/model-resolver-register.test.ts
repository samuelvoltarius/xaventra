import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerExternalProvider, resolverCacheForDisk } from './model-resolver.js'

const configFile = () => join(process.cwd(), 'xaventra.config.json')
let originalConfig = ''

beforeEach(() => { originalConfig = readFileSync(configFile(), 'utf8') })
afterEach(() => {
    writeFileSync(configFile(), originalConfig)
    vi.restoreAllMocks()
})

describe('external LLM provider registration (R2 A8)', () => {
    it('refuses to re-point a built-in provider and never contacts the given URL', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'))
        const result = await registerExternalProvider({ name: 'minimax', apiKey: 'k', baseUrl: 'https://attacker.example/v1', enabled: true })
        expect(result.success).toBe(false)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(readFileSync(configFile(), 'utf8')).toBe(originalConfig)
    })

    it('refuses local, internal or plain-http endpoints before sending the key', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'))
        for (const baseUrl of ['http://api.example.com/v1', 'https://127.0.0.1:8443/v1', 'https://localhost/v1', 'https://nas/v1', 'https://[::1]/v1', 'https://169.254.169.254/latest']) {
            const result = await registerExternalProvider({ name: 'fixturecloud', apiKey: 'k', baseUrl, enabled: true })
            expect(result.success, baseUrl).toBe(false)
        }
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('refuses to overwrite a provider section the owner configured by hand', async () => {
        const cfg = JSON.parse(originalConfig)
        writeFileSync(configFile(), JSON.stringify({ ...cfg, providers: { ...(cfg.providers || {}), kimi: { apiKey: 'owner-key', baseUrl: 'https://api.moonshot.example/v1' } } }))
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'))
        const result = await registerExternalProvider({ name: 'kimi', apiKey: 'other', baseUrl: 'https://evil.example/v1', enabled: true })
        expect(result.success).toBe(false)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(JSON.parse(readFileSync(configFile(), 'utf8')).providers.kimi.apiKey).toBe('owner-key')
    })

    it('still registers a new named https provider', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { status: 200 }))
        const result = await registerExternalProvider({ name: 'fixturecloud', apiKey: 'k', baseUrl: 'https://api.fixturecloud.example/v1', enabled: true })
        expect(result.success).toBe(true)
        expect(JSON.parse(readFileSync(configFile(), 'utf8')).providers.fixturecloud.baseUrl).toBe('https://api.fixturecloud.example/v1')
    })
})

describe('resolver cache on disk (R2 A21)', () => {
    it('never persists provider API keys', () => {
        const disk = resolverCacheForDisk({
            version: 2, timestamp: 1,
            resolved: { chat: { id: 'm', provider: 'kimi', role: 'chat', capabilities: ['chat'], endpoint: 'https://x.example/v1', apiKey: 'secret-key' } },
        })
        expect(JSON.stringify(disk)).not.toContain('secret-key')
        expect(disk.resolved.chat?.endpoint).toBe('https://x.example/v1')
    })
})
