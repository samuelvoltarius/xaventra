import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Switching needs the owner's approval (homeassistant-approval.test.ts); this test is about
// the forwarded fields only, so the approval is granted here.
vi.mock('./owner-approval.js', () => ({ ownerApprovalRefusal: async () => null }))

let hass: typeof import('./homeassistant.js')
const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hass-'))
    writeFileSync(join(dir, 'xaventra.config.json'), JSON.stringify({ homeassistant: { url: 'http://192.0.2.9:8123', token: 'fixture-token' } }))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    vi.stubEnv('HASS_URL', 'http://192.0.2.9:8123')
    vi.stubEnv('HASS_TOKEN', 'fixture-token')
    vi.stubEnv('HA_URL', 'http://192.0.2.9:8123')
    vi.stubEnv('HA_TOKEN', 'fixture-token')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockClear()
    vi.resetModules()
    hass = await import('./homeassistant.js')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('R2 T19: hass_turn_on sends only declared service fields', () => {
    it('drops runner-injected identity and request text', async () => {
        const tool = hass.homeAssistantTools.find(entry => entry.name === 'hass_turn_on')!
        await tool.handler({
            entity_id: 'light.wohnzimmer', brightness: 128,
            userId: 'u1', channel: 'telegram', authorizationUserId: 'u1', requestText: 'mach das Licht an, geheim',
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toMatch(/\/api\/services\/light\/turn_on$/)
        expect(JSON.parse(String(init.body))).toEqual({ entity_id: 'light.wohnzimmer', brightness: 128 })
    })
})
