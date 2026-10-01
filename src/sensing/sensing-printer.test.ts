import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SensingBus } from './event-bus.js'
import { JsonlEventSink, JsonlThoughtSink, type SensingThought } from './ports.js'
import { createPrinterAdapter, parseMoonraker, parseOctoPrint, parsePrusaLink, printerTransitions } from './adapters/printer.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

function moonraker(state: string, progress: number, filename = 'benchy.gcode', message = '') {
    return { result: { status: { print_stats: { state, filename, message }, virtual_sdcard: { progress }, display_status: { progress } } } }
}

describe('Drucker-Adapter (Moonraker, gefakte Antworten)', () => {
    it('meldet „gleich fertig“ genau einmal je Auftrag, dann fertig', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'sense-printer-')); dirs.push(dataDir)
        const answers = [moonraker('printing', 0.5), moonraker('printing', 0.91), moonraker('printing', 0.93), moonraker('printing', 0.99), moonraker('complete', 1), moonraker('complete', 1)]
        const urls: string[] = []
        const methods: string[] = []
        let i = 0
        const adapter = createPrinterAdapter({
            targets: () => [{ id: 'voron', name: 'Voron', type: 'moonraker', url: 'http://192.168.1.40:7125' }],
            intervalMs: 60_000, timeoutMs: 1000,
            fetch: async (url, init) => { urls.push(url); methods.push(init.method); const body = answers[Math.min(i++, answers.length - 1)]; return { ok: true, status: 200, json: async () => body } },
        })
        // Bus dedupe window 0 so only the adapter's own latch can prevent repeats.
        const bus = new SensingBus({ dataDir, eventSink: new JsonlEventSink(dataDir), thoughtSink: new JsonlThoughtSink(dataDir), defaultDedupeWindowMs: 0, now: () => Date.parse('2026-10-01T12:00:00Z') })
        bus.register({ ...adapter, poll: ctx => adapter.poll(ctx) })
        const kinds: string[] = []
        for (let n = 0; n < answers.length; n++) kinds.push(...(await bus.runAdapter('printer')).map(event => event.kind))
        expect(kinds).toEqual(['printer.near-done', 'printer.done'])
        expect(methods.every(method => method === 'GET')).toBe(true)
        expect(urls.every(url => url.startsWith('http://192.168.1.40:7125/printer/objects/query'))).toBe(true)
        const thoughts: SensingThought[] = readFileSync(join(dataDir, 'sensing', 'thoughts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(thoughts[0].title).toContain('gleich fertig')
        expect(thoughts[0].level).toBe('fragen') // physische Folgeaktion → immer fragen
    })

    it('Übergangslogik: neuer Auftrag setzt den Riegel zurück, Fehler/Pause werden gemeldet', () => {
        let latch = printerTransitions('p', 'P', undefined, parseMoonraker(moonraker('printing', 0.95, 'a.gcode'))).latch
        expect(latch.nearDoneSent).toBe(true)
        expect(printerTransitions('p', 'P', latch, parseMoonraker(moonraker('printing', 0.97, 'a.gcode'))).events).toEqual([])
        const next = printerTransitions('p', 'P', latch, parseMoonraker(moonraker('printing', 0.92, 'b.gcode')))
        expect(next.events.map(e => e.kind)).toEqual(['printer.near-done'])
        latch = next.latch
        expect(printerTransitions('p', 'P', latch, parseMoonraker(moonraker('paused', 0.92, 'b.gcode', 'Filament leer'))).events.map(e => e.kind)).toEqual(['printer.paused'])
        expect(printerTransitions('p', 'P', latch, parseMoonraker(moonraker('error', 0.92, 'b.gcode', 'Thermal runaway'))).events.map(e => [e.kind, e.severity])).toEqual([['printer.error', 'urgent']])
        // Erste Beobachtung eines alten „complete“ ist keine Neuigkeit.
        expect(printerTransitions('p', 'P', undefined, parseMoonraker(moonraker('complete', 1))).events).toEqual([])
    })

    it('liest OctoPrint und PrusaLink', () => {
        expect(parseOctoPrint({ state: 'Printing', progress: { completion: 92.5 }, job: { file: { name: 'x.gcode' } } })).toMatchObject({ state: 'printing', job: 'x.gcode' })
        expect(parseOctoPrint({ state: 'Operational', progress: { completion: 100 }, job: { file: { name: 'x.gcode' } } }).state).toBe('complete')
        expect(parsePrusaLink({ printer: { state: 'FINISHED' }, job: { id: 7, progress: 100 } })).toMatchObject({ state: 'complete', job: '7', progress: 1 })
    })

    it('OctoPrint ohne Owner-Schlüssel wird nicht abgefragt', async () => {
        let calls = 0
        const adapter = createPrinterAdapter({ targets: () => [{ id: 'o', type: 'octoprint', url: 'http://192.168.1.41' }], intervalMs: 1, timeoutMs: 1, env: {}, fetch: async () => { calls++; throw new Error('x') } })
        expect(await adapter.poll({ signal: new AbortController().signal, now: 0, state: {} })).toEqual([])
        expect(calls).toBe(0)
    })
})
