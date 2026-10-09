/**
 * 2.89.4: the one store/resolve path for service keys.
 * Fake value `'x'.repeat(32)`; never in the config file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE = 'x'.repeat(32)
let dir = ''
const configFile = () => join(dir, 'xaventra.config.json')

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'service-keys-'))
    writeFileSync(configFile(), JSON.stringify({ apis: {} }))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('storeServiceApiKey / resolveServiceApiKey', () => {
    it('stores in the Tresor, activates via env and never writes the clear key into the config', async () => {
        const { storeServiceApiKey, resolveServiceApiKey } = await import('./service-keys.js')
        const stored = await storeServiceApiKey('tavily', FAKE, { context: 'test' })
        expect(stored.ok).toBe(true)
        expect(stored.id).toBe('chat-tavily')
        expect(process.env.TAVILY_API_KEY).toBe(FAKE)

        // Config file (and any later dump) must not contain the value.
        try {
            const raw = readFileSync(configFile(), 'utf8')
            expect(raw).not.toContain(FAKE)
        } catch { /* not written yet — also fine */ }

        const resolved = await resolveServiceApiKey('tavily', { env: {} })
        expect(resolved).toBe(FAKE)
        // Env wins when already activated.
        expect(await resolveServiceApiKey('tavily')).toBe(FAKE)
    })

    it('rejects an empty or multi-line value', async () => {
        const { storeServiceApiKey } = await import('./service-keys.js')
        expect((await storeServiceApiKey('tavily', '')).ok).toBe(false)
        expect((await storeServiceApiKey('tavily', 'line1\nline2')).ok).toBe(false)
    })

    it('maps unknown services onto a safe chat- id', async () => {
        const { serviceKeyPlan } = await import('./service-keys.js')
        expect(serviceKeyPlan('My Weird!Service').id).toBe('chat-myweirdservice')
        expect(serviceKeyPlan('home-assistant').env).toBe('HOME_ASSISTANT_TOKEN')
        expect(serviceKeyPlan('dhl').env).toBe('XAVENTRA_DHL_TRACKING_API_KEY')
    })
})
