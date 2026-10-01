import { describe, expect, it } from 'vitest'
import { doctorEvents } from './adapters/system.js'

// 2.82.0 (DOPPELUNGEN Gruppe 1): Platte/RAM (L0) und Knoten offline (L21)
// melden schon über den governed Weg A. Der Sensing-system-Adapter darf
// dieselben Self-Doctor-Befunde nicht noch einmal als Gedanken melden.

const finding = (id: string, source: string, severity = 'critical') => ({ id, status: 'open', severity, source, title: `Befund ${id}`, category: 'health' })

describe('sensing system adapter: one fact, one message', () => {
    it('drops self-doctor findings whose source already reports over Weg A', () => {
        const events = doctorEvents([
            finding('d-l0', 'L0-health-monitor'),
            finding('d-mesh', 'mesh-registry', 'warning'),
            finding('d-llm', 'capability-probe'),
        ], new Set())
        expect(events.map(event => event.evidence?.befund)).toEqual(['d-llm'])
    })

    it('still forwards other critical findings exactly as before', () => {
        const [event] = doctorEvents([finding('d-trace', 'trace-analyzer')], new Set())
        expect(event).toMatchObject({ kind: 'system.doctor', severity: 'warning', dedupeKey: 'doctor:d-trace' })
    })
})
