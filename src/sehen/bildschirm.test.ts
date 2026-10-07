import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentDesktopInputPauseReason, clearAgentDesktopInputHolds } from '../desktop-direct/pause.js'
import { _resetBildschirme, BILD_MIN_ABSTAND_MS, bildschirmBild, bildschirmEingabe, bildschirmeText, listeBildschirme, steuereBildschirm, type BildschirmDeps } from './bildschirm.js'
import type { Aktivitaet } from './aktivitaet.js'

// 2.88 „Ihr Computer“: Computer-Session über die vorhandene Mesh-Aufnahme und
// Desktop-Direkt. Nur Testdaten; keine echte Aufnahme, kein Netz.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 7)])
let t = 0
let captures: Array<{ node: string; principal: string }> = []
let inputs: unknown[] = []
let stops: string[] = []
let thoughts: any[] = []
let failFor: Record<string, string> = {}
let env: NodeJS.ProcessEnv = {}

const lauf = (node: string, extra: Partial<Aktivitaet> = {}): Aktivitaet => ({
    id: `auftrag:${node}`, art: 'auftrag', artText: 'Projekt', titel: 'Website', tut: 'Projekt Website 4/7: Browser: suche Doku zu ESPHome', status: 'laeuft', statusText: 'läuft',
    node, grund: 'Dein Auftrag', seit: null, naechster: null, jetzt: true, aktionen: ['stopp', 'spaeter', 'anders'], ...extra,
})

const deps = (): BildschirmDeps => ({
    now: () => t, env, lokalerNode: () => 'main-a',
    nodes: async () => ['main-a', 'spark-a', 'worker-a'],
    aufnahme: async (node, principal) => {
        captures.push({ node, principal })
        if (failFor[node]) throw new Error(failFor[node])
        return { base64: PNG.toString('base64'), bytes: PNG.length, sha256: createHash('sha256').update(PNG).digest('hex'), capturedAt: new Date(t).toISOString(), mimeType: 'image/png' }
    },
    direkt: async () => ({ enabled: true, desktops: [{ id: 'labor-vm', label: 'Labor-VM', allowControl: true, agentInput: true, active: [] }] }),
    aktivitaet: async () => [lauf('spark-a')],
    stoppeAktivitaet: async (id, by) => { stops.push(`${id}:${by}`); return { ok: true, message: 'ok' } },
    gedanke: async input => { thoughts.push(input); return true },
    eingabe: async action => { inputs.push(action); return { status: 'completed' } },
})
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
    t = Date.parse('2026-10-07T09:00:00.000Z')
    captures = []; inputs = []; stops = []; thoughts = []
    failFor = { 'worker-a': 'Node capture not enrolled; headless nodes have no desktop image' }
    env = {}
    _resetBildschirme(); clearAgentDesktopInputHolds()
})
afterEach(() => { _resetBildschirme(); clearAgentDesktopInputHolds() })

describe('Bildschirme: Nodes mit grafischer Sitzung und virtuelle Desktops', () => {
    it('ohne Einrichtung kein lokaler Bildschirm; entfernte werden geprüft, kopflose fallen heraus', async () => {
        let liste = await listeBildschirme(deps())
        await flush(); await flush()
        expect(liste.bildschirme.map(item => item.id)).toEqual(['node:spark-a', 'node:worker-a', 'direkt:labor-vm'])
        expect(liste.ohneBildschirm).toEqual(['main-a'])
        liste = await listeBildschirme(deps())
        expect(liste.bildschirme.map(item => [item.id, item.zustand])).toEqual([['node:spark-a', 'bereit'], ['direkt:labor-vm', 'bereit']])
        expect(liste.ohneBildschirm).toEqual(['main-a', 'worker-a'])
        expect(liste.bildschirme[0]).toMatchObject({ tut: 'Projekt: Projekt Website 4/7: Browser: suche Doku zu ESPHome', zuschauen: 'bild', eingabeErlaubt: false })
        expect(liste.bildschirme[1]).toMatchObject({ art: 'virtuell', zuschauen: 'link', linkSteuern: true })
    })

    it('lokal eingerichtet → bereit; Eingabe nur mit NOVA_DESKTOP_INPUT_ENABLED', async () => {
        env = { NOVA_MESH_CAPTURE_ENABLED: '1', NOVA_CAPTURE_SOCKET: '/run/example/capture.sock', NOVA_CAPTURE_TOKEN_FILE: '/run/example/token' }
        let lokal = (await listeBildschirme(deps())).bildschirme.find(item => item.id === 'node:main-a')!
        expect(lokal).toMatchObject({ zustand: 'bereit', lokal: true, eingabeErlaubt: false })
        env = { ...env, NOVA_DESKTOP_INPUT_ENABLED: '1' }
        lokal = (await listeBildschirme(deps())).bildschirme.find(item => item.id === 'node:main-a')!
        expect(lokal.eingabeErlaubt).toBe(true)
    })
})

describe('Zuschauen: Bild über die Owner-API, gedrosselt', () => {
    it('liefert ein geprüftes PNG und holt höchstens alle 1,5 s ein neues', async () => {
        const first = await bildschirmBild('node:spark-a', 'desktop-owner', deps())
        expect(first).toMatchObject({ ok: true, bild: { mimeType: 'image/png', bytes: PNG.length } })
        expect(captures).toEqual([{ node: 'spark-a', principal: 'desktop-owner' }])
        await bildschirmBild('node:spark-a', 'desktop-owner', deps())
        expect(captures).toHaveLength(1)
        t += BILD_MIN_ABSTAND_MS
        await bildschirmBild('node:spark-a', 'desktop-owner', deps())
        expect(captures).toHaveLength(2)
    })

    it('gesperrte Sitzung: ehrlich gesagt, nie entsperrt', async () => {
        failFor['spark-a'] = 'Desktop session is locked; unlock locally before capture'
        const r = await bildschirmBild('node:spark-a', 'desktop-owner', deps())
        expect(r).toMatchObject({ ok: false, zustand: 'gesperrt' })
        expect((r as any).message).toMatch(/entsperre nie selbst/)
    })

    it('falsches Bild (Hash passt nicht) wird nie gezeigt', async () => {
        const bad: BildschirmDeps = { ...deps(), aufnahme: async () => ({ base64: PNG.toString('base64'), bytes: PNG.length, sha256: 'a'.repeat(64), capturedAt: new Date(t).toISOString(), mimeType: 'image/png' }) }
        expect((await bildschirmBild('node:spark-a', 'o', bad)).ok).toBe(false)
    })

    it('virtuelle Bildschirme und Unbekanntes liefern kein Bild', async () => {
        expect((await bildschirmBild('direkt:labor-vm', 'o', deps())).ok).toBe(false)
        expect((await bildschirmBild('node:../x', 'o', deps())).ok).toBe(false)
        expect(captures).toEqual([])
    })
})

describe('Übernehmen / Zurückgeben / Stoppen / Anderes Ziel', () => {
    it('Übernehmen pausiert Xaventras Maus/Tastatur sofort; Zurückgeben hebt es auf', async () => {
        await listeBildschirme(deps()); await flush(); await flush()
        expect(agentDesktopInputPauseReason()).toBeNull()
        const r = await steuereBildschirm('node:spark-a', 'uebernehmen', { by: 'owner' }, deps())
        expect(r.ok).toBe(true)
        expect(r.message).toMatch(/schaue nur zu/)
        expect(agentDesktopInputPauseReason()).toMatch(/pausiert/)
        expect((await listeBildschirme(deps())).bildschirme.find(item => item.id === 'node:spark-a')?.uebernommen).toBe(true)
        expect((await steuereBildschirm('node:spark-a', 'zurueckgeben', { by: 'owner' }, deps())).ok).toBe(true)
        expect(agentDesktopInputPauseReason()).toBeNull()
    })

    it('Stoppen: Hände weg und die laufende Arbeit auf diesem Node anhalten (vorhandener Stopp-Weg)', async () => {
        await listeBildschirme(deps()); await flush(); await flush()
        const r = await steuereBildschirm('node:spark-a', 'stoppen', { by: 'owner:1' }, deps())
        expect(r.ok).toBe(true)
        expect(stops).toEqual(['auftrag:spark-a:owner:1'])
        expect(agentDesktopInputPauseReason()).toMatch(/pausiert/)
    })

    it('Anderes Ziel geht als Gedanke an den Planer', async () => {
        await listeBildschirme(deps()); await flush(); await flush()
        expect((await steuereBildschirm('node:spark-a', 'ziel', { by: 'owner', text: 'Erst die Mails sortieren' }, deps())).ok).toBe(true)
        expect(thoughts[0]).toMatchObject({ proposal: 'Erst die Mails sortieren', node: 'spark-a' })
    })

    it('Eingaben des Owners nur nach Übernehmen und nur wo erlaubt', async () => {
        env = { NOVA_MESH_CAPTURE_ENABLED: '1', NOVA_CAPTURE_SOCKET: '/run/example/capture.sock', NOVA_CAPTURE_TOKEN_FILE: '/run/example/token' }
        const click = { action: 'click', x: 10, y: 20, button: 'left' }
        expect((await bildschirmEingabe('node:main-a', click, deps())).message).toMatch(/Übernehmen/)
        await steuereBildschirm('node:main-a', 'uebernehmen', { by: 'owner' }, deps())
        expect((await bildschirmEingabe('node:main-a', click, deps())).message).toMatch(/nicht freigegeben/)
        env = { ...env, NOVA_DESKTOP_INPUT_ENABLED: '1' }
        expect((await bildschirmEingabe('node:main-a', click, deps())).ok).toBe(true)
        expect((await bildschirmEingabe('node:main-a', { action: 'key', key: 'ctrl+alt+Delete' }, deps())).ok).toBe(false)
        expect((await bildschirmEingabe('node:main-a', { action: 'exec', cmd: 'rm' }, deps())).ok).toBe(false)
        expect(inputs).toEqual([click])
    })

    it('Telegram-Kurztext nennt den Zustand', async () => {
        await listeBildschirme(deps()); await flush(); await flush()
        await steuereBildschirm('node:spark-a', 'uebernehmen', { by: 'owner' }, deps())
        const text = bildschirmeText(await listeBildschirme(deps()))
        expect(text).toMatch(/spark-a – du hast übernommen/)
        expect(text).toMatch(/pausiert/)
    })
})
