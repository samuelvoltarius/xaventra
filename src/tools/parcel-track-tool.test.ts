import { afterEach, describe, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ role: 'owner' }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => ({ authUserId: 'owner', channel: 'Desktop' }) }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => auth.role }))
import { parcelTrackTool, parseParcelResult } from './parcel-track-tool.js'
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); auth.role = 'owner' })
describe('belegbare Paketverfolgung', () => {
    it('asks for private setup without network access', async () => {
        vi.stubEnv('XAVENTRA_DHL_TRACKING_API_KEY', '')
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
        const result = await parcelTrackTool.handler({ number: '12345678', provider: 'dhl', requestText: 'Verfolge DHL 12345678' })
        expect(result.needsSetup).toBe(true); expect(result.question).toContain('nicht im Chat'); expect(fetch).not.toHaveBeenCalled()
    })
    it('rejects URL numbers and implicit cloud/provider choice', async () => {
        expect((await parcelTrackTool.handler({ number: 'https://host', provider: 'dhl' })).success).toBe(false)
        expect((await parcelTrackTool.handler({ number: '12345678', provider: 'dhl', requestText: 'Paket 12345678' })).error).toContain('ausdrücklich')
        expect((await parcelTrackTool.handler({ number: '12345678', provider: 'dhl', requestText: 'DHL 9123456789' })).error).toContain('ausdrücklich')
    })
    it('rejects other principals', async () => { auth.role = 'user'; await expect(parcelTrackTool.handler({})).rejects.toThrow('Owner') })
    it('only accepts the matching DHL shipment and excludes recipient data', () => {
        const body = { shipments: [{ id: '12345678', status: { statusCode: 'delivered', description: 'Zugestellt', timestamp: '2026-10-05T10:00:00Z' }, recipient: 'PRIVATE' }] }
        expect(parseParcelResult('dhl', '12345678', body).status).toBe('delivered')
        expect(JSON.stringify(parseParcelResult('dhl', '12345678', body))).not.toContain('PRIVATE')
        expect(parseParcelResult('dhl', '99999999', body).success).toBe(false)
    })
    it('preserves 17TRACK event age/cache and does not fabricate unregistered status', () => {
        expect(parseParcelResult('17track', '12345678', { code: 0, data: { accepted: [{ number: '12345678', carrier: 100001, track_info: { latest_status: { status: 'InTransit' }, latest_event: { description: 'Unterwegs', time_iso: '2026-10-04T10:00:00Z' } } }] } }).cachedProviderResult).toBe(true)
        expect(parseParcelResult('17track', '12345678', { code: 0, data: { rejected: [{ number: '12345678' }] } }).success).toBe(false)
        expect(parseParcelResult('17track', '12345678', { code: 0, data: { accepted: [{ number: '12345678' }, { number: '12345678' }] } }).error).toContain('Mehrere Paketdienste')
    })
    it('uses only the fixed authenticated read endpoint without registering', async () => {
        vi.stubEnv('XAVENTRA_DHL_TRACKING_API_KEY', 'test-private-key')
        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ shipments: [{ id: '12345678', status: { statusCode: 'transit' } }] })))
        vi.stubGlobal('fetch', fetch)
        const result = await parcelTrackTool.handler({ number: '12345678', provider: 'dhl', requestText: 'DHL 12345678 verfolgen' })
        expect(result.success).toBe(true); expect(JSON.stringify(result)).not.toContain('test-private-key')
        expect(fetch.mock.calls[0][0]).toBe('https://api-eu.dhl.com/track/shipments?trackingNumber=12345678')
        expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' })
    })
})
