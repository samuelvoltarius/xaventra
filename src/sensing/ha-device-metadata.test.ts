import { describe, expect, it } from 'vitest'
import { applyHaDeviceMetadata, boundedHaJson, haDeviceTemplate } from './ha-device-metadata.js'
import type { HaFunction } from './ha-inventory.js'
const f: HaFunction = { id: 'light.kitchen', name: 'Kitchen', kind: 'Lichtfunktion', state: 'on', available: true }
const row = { entity_id: f.id, device_id: 'a'.repeat(32), manufacturer: 'Tuya', model: 'Lamp' }
describe('bounded HA registry projection', () => {
    it('accepts arbitrary reported manufacturers only for the exact requested entity and valid device ID', () => {
        expect(applyHaDeviceMetadata([f], [row])[0].manufacturer).toBe('Tuya')
        for (const body of [[{ ...row, entity_id: 'light.other' }], [{ ...row, device_id: 'invalid' }], [row, row]])
            expect(applyHaDeviceMetadata([f], body)).toEqual([f])
    })
    it('does not interpolate untrusted code or project secrets and other attributes', () => {
        const template = haDeviceTemplate([{ ...f, id: "light.x'}}{{secrets}}" }, f])
        expect(template).not.toContain('secrets'); expect(template).toContain('light.kitchen')
        expect(template).not.toContain('access_token')
        const result = applyHaDeviceMetadata([f], [{ ...row, model: 'api_key=private-key', access_token: 'private-token' }])
        expect(JSON.stringify(result)).not.toContain('private-key'); expect(JSON.stringify(result)).not.toContain('private-token')
    })
    it('rejects failed, malformed and oversized reads before accepting metadata', async () => {
        await expect(boundedHaJson(new Response('', { status: 302 }))).rejects.toThrow()
        await expect(boundedHaJson(new Response('not json'))).rejects.toThrow()
        await expect(boundedHaJson(new Response('x'.repeat(512001)))).rejects.toThrow('too large')
        expect(await boundedHaJson(new Response(JSON.stringify([row])))).toEqual([row])
    })
})
