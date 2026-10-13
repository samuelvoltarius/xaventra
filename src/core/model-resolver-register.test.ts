import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listExternalProviders, migratePlaintextExternalProviderKeys, registerExternalProvider, resolverCacheForDisk } from './model-resolver.js'

const configFile = () => join(process.cwd(), 'xaventra.config.json')
const providersFile = () => join(process.cwd(), '.nova-data', 'external-providers.json')
let originalConfig = ''

beforeEach(() => { originalConfig = readFileSync(configFile(), 'utf8') })
afterEach(() => {
    writeFileSync(configFile(), originalConfig)
    rmSync(providersFile(), { force: true })
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

describe('2.89.5: provider keys never stay in clear text on disk', () => {
    const FAKE = 'x'.repeat(40)

    it('registration moves the key into the vault; config and provider list carry only the reference', async () => {
        rmSync(providersFile(), { force: true })
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { status: 200 }))
        const result = await registerExternalProvider({ name: 'fixturevault', apiKey: FAKE, baseUrl: 'https://api.fixturevault.example/v1', enabled: true })
        expect(result.success).toBe(true)
        expect(readFileSync(configFile(), 'utf8')).not.toContain(FAKE)
        const list = JSON.parse(readFileSync(providersFile(), 'utf8'))
        expect(JSON.stringify(list)).not.toContain(FAKE)
        expect(list.find((entry: any) => entry.name === 'fixturevault').apiKeyRef).toBe('auth:llm-provider:fixturevault')
        // The provider keeps working — the key is resolved from the vault on load.
        expect(listExternalProviders().find(entry => entry.name === 'fixturevault')?.apiKey).toBe(FAKE)
    })

    it('a legacy provider list with plaintext keys migrates on the first read and stays idempotent', () => {
        writeFileSync(providersFile(), JSON.stringify([{ name: 'legacycloud', apiKey: FAKE, baseUrl: 'https://api.legacycloud.example/v1', enabled: true, addedAt: 1 }]))
        expect(listExternalProviders().find(entry => entry.name === 'legacycloud')?.apiKey).toBe(FAKE)
        const disk = readFileSync(providersFile(), 'utf8')
        expect(disk).not.toContain(FAKE)
        expect(JSON.parse(disk).find((entry: any) => entry.name === 'legacycloud').apiKeyRef).toBe('auth:llm-provider:legacycloud')
        // Nothing left to move on the next read.
        expect(migratePlaintextExternalProviderKeys()).toEqual([])
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
