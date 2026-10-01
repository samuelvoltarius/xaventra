import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Switching in Home Assistant is a physical action: the model may only do it
// with the owner's approval (same gate as printer_print). Reading stays free.
const refusal = vi.fn()
vi.mock('./owner-approval.js', () => ({ ownerApprovalRefusal: (...args: unknown[]) => refusal(...args) }))

const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }))

describe('Home Assistant: Schalten nur mit Owner-Freigabe', () => {
    beforeEach(() => {
        process.env.HASS_URL = 'https://ha.example.com'
        process.env.HASS_TOKEN = 'test-placeholder'
        vi.stubGlobal('fetch', fetchMock)
        fetchMock.mockClear(); refusal.mockReset()
    })
    afterEach(() => { delete process.env.HASS_URL; delete process.env.HASS_TOKEN; vi.unstubAllGlobals() })

    const tools = async () => {
        const mod: any = await import('./homeassistant.js')
        const list: any[] = Object.values(mod).find((value: any) => Array.isArray(value) && value.some((tool: any) => tool?.name === 'hass_turn_on')) as any[]
        return Object.fromEntries(list.map(tool => [tool.name, tool]))
    }

    it.each([
        ['hass_turn_on', { entity_id: 'light.example' }],
        ['hass_turn_off', { entity_id: 'light.example' }],
        ['hass_toggle', { entity_id: 'switch.example' }],
        ['hass_service', { domain: 'climate', service: 'set_temperature', entity_id: 'climate.example', data: { temperature: 21 } }],
    ])('%s ohne Freigabe: nichts an Home Assistant gesendet', async (name, params) => {
        refusal.mockResolvedValue('❌ braucht Freigabe')
        const result = await (await tools())[name].handler({ ...params })
        expect(JSON.stringify(result)).toContain('Freigabe')
        expect(fetchMock).not.toHaveBeenCalled()
        expect(refusal).toHaveBeenCalledWith(expect.any(Object), name, expect.any(String))
    })

    it('mit Freigabe wird geschaltet', async () => {
        refusal.mockResolvedValue(null)
        await (await tools()).hass_turn_on.handler({ entity_id: 'light.example' })
        expect(fetchMock).toHaveBeenCalled()
    })

    it('Lesen braucht keine Freigabe', async () => {
        await (await tools()).hass_get.handler({ entity_id: 'light.example' }).catch(() => undefined)
        expect(refusal).not.toHaveBeenCalled()
    })
})
