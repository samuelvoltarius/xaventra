import { describe, expect, it } from 'vitest'
import { parseDirectFunctions } from './direct-smart-devices.js'

// Paket L 2: after pairing, the inventory behind the bridge includes sensors (read only).
describe('Hue-Inventar: Sensoren', () => {
    it('reads motion, temperature and light-level sensors; skips daylight/virtual ones', () => {
        const functions = parseDirectFunctions('hue-sensors', {
            '1': { type: 'Daylight', name: 'Daylight', modelid: 'PHDL00', state: { daylight: true } },
            '5': { type: 'ZLLPresence', name: 'Flur Bewegung', modelid: 'SML001', manufacturername: 'Signify Netherlands B.V.', state: { presence: false }, config: { reachable: true } },
            '6': { type: 'ZLLTemperature', name: 'Flur Temperatur', modelid: 'SML001', state: { temperature: 2150 }, config: { reachable: true } },
            '7': { type: 'ZLLLightLevel', name: 'Flur Licht', modelid: 'SML001', state: { lightlevel: 12000 }, config: { reachable: false } },
            '8': { type: 'CLIPGenericStatus', name: 'virtuell', modelid: 'x', state: { status: 0 } },
        })
        expect(functions.map(f => [f.id, f.kind, f.available])).toEqual([['sensor:5', 'binary_sensor', true], ['sensor:6', 'sensor', true], ['sensor:7', 'sensor', false]])
    })
})
