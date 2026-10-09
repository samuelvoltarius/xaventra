import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DASHBOARD_UI_FILES } from '../dev/copy-dashboard-assets.js'
import { registerDesktopApi } from '../desktop/desktop-api.js'
import { collectHeute } from '../desktop/desktop-views.js'
import { createApprovalCard, recordCardDelivery } from '../core/approval-cards.js'
import { registerGuidedApi } from './guided-api.js'

// 2.86 Paket M: „Heute“ als Cockpit in der App, Einrichtung/Beispiele/Tipp/Hilfe über /api/desktop/gefuehrt.

const file = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guided-ui-')) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

async function withServer(app: express.Express, run: (base: string) => Promise<void>) {
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/desktop`) } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
}
const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' } as any)[char])

describe('Cockpit „Heute“ in der App', () => {
    it('is part of the one UI: own file, served and copied, loaded before app.js', () => {
        expect(DASHBOARD_UI_FILES).toContain('cockpit.js')
        expect(file('src/dashboard/server.ts')).toContain(`'cockpit.js': 'text/javascript; charset=utf-8'`)
        const html = file('desktop/renderer/index.html')
        expect(html.indexOf('cockpit.js')).toBeGreaterThan(0)
        expect(html.indexOf('cockpit.js')).toBeLessThan(html.indexOf('app.js'))
        expect(file('desktop/renderer/app.js')).toContain('window.XaventraCockpit')
    })

    it('renders four traffic-light tiles, the open setup items with one button each and the help button', () => {
        const sandbox: any = { window: {}, document: {}, Date, Number, String, Object, Promise, Array, Set }
        runInNewContext(file('desktop/renderer/cockpit.js'), sandbox)
        const ui = sandbox.window.XaventraCockpit
        ui._local.data = {
            einrichtung: { fertig: false, kopf: '2 von 3 erledigt', punkte: [
                { key: 'ki', titel: 'KI-Modell läuft', erledigt: true, satz: 'x' },
                { key: 'geraet:dev-00000000aa', titel: '<b>Home Assistant</b> verbinden', erledigt: false, satz: 'Ich habe Home Assistant gefunden.', knopf: { label: 'Verbinden', aktion: { art: 'verbinden', key: 'geraet:dev-00000000aa' } } },
            ] },
            beispiele: [{ key: 'c:home-assistant', titel: 'Home Assistant', saetze: ['Welche Lichter sind gerade an?', 'Mach das Wohnzimmerlicht aus', 'Wie warm ist es drinnen?'] }],
            tipp: { id: 'ha-abends-aus', text: 'Wusstest du? …', knopf: { label: 'Ausprobieren', satz: 'Jeden Abend um 23 Uhr alle Lichter aus' } },
        }
        const h = { esc, attr: esc, icon: () => '', api: {}, rerender: () => undefined }
        const cockpit = [
            { id: 'laeuft', titel: 'Läuft alles?', ampel: 'gruen', satz: 'Alles läuft.', zeilen: [] },
            { id: 'braucht', titel: 'Braucht dich', ampel: 'gelb', satz: '„Hue Bridge koppeln?“', zeilen: ['Danach wartet noch 1 Frage – sie kommen einzeln.'], karteId: 'k000000000001' },
            { id: 'getan', titel: 'Was sie heute getan hat', ampel: 'gruen', satz: '1 Sache erledigt.', zeilen: ['ffmpeg installiert'] },
            { id: 'gelernt', titel: 'Was sie gelernt hat', ampel: 'gruen', satz: 'Heute nichts Neues gemerkt.', zeilen: [] },
        ]
        const html = ui.view(h, { cockpit })
        expect(html.match(/class="cockpit-tile /g)).toHaveLength(4)
        expect(html).toContain('ampel-gelb')
        expect(html).toContain('2 von 3 erledigt')
        expect(html.match(/data-guided-item=/g)).toHaveLength(1)
        expect(html).not.toContain('<b>Home')
        expect(html.match(/data-guided-ask=/g)).toHaveLength(4) // three sentences + the tip button
        expect(html).toContain('data-guided-tip-no="ha-abends-aus"')
        expect(html).toContain('Ich komm nicht weiter')
        // a finished checklist disappears
        ui._local.data = { einrichtung: { fertig: true, kopf: '3 von 3 erledigt', punkte: [] }, beispiele: [], tipp: null }
        expect(ui.view(h, { cockpit })).not.toContain('Einrichtung')
    })

    it('collectHeute: open questions in queue order, the cockpit and the waiting count', async () => {
        const opts = { dataDir: dir, ledger: null }
        const make = (titel: string, ref: string, extra: Record<string, unknown> = {}) => {
            const created = createApprovalCard({ art: 'install', titel, beleg: 'Katalog', vorschlag: 'x', aktion: { kind: 'install', ref }, ...extra } as any, opts)
            if (!created.ok) throw new Error('card')
            return created.card
        }
        make('Kamera einrichten?', 'iq-1')
        const shown = make('ffmpeg installieren?', 'iq-2')
        recordCardDelivery(shown.id, [{ chatId: '111', messageId: 5 }], opts)
        make('Drucker prüfen?', 'iq-3', { wirkung: 'physisch' })
        const view = await collectHeute(opts)
        expect(view.karten.map(card => card.titel)).toEqual(['ffmpeg installieren?', 'Drucker prüfen?', 'Kamera einrichten?'])
        expect(view.wartend).toBe(2)
        expect(view.cockpit!.map(tile => tile.id)).toEqual(['laeuft', 'braucht', 'getan', 'gelernt'])
        expect(view.cockpit![1]).toMatchObject({ ampel: 'gelb', satz: '„ffmpeg installieren?“', karteId: shown.id })
    }, 20_000)
})

describe('/api/desktop/gefuehrt', () => {
    it('is owner-only (tokenless loopback gets 403)', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        const app = express(); app.use(express.json()); registerDesktopApi(app, () => null)
        await withServer(app, async base => {
            for (const [method, path] of [['GET', '/gefuehrt'], ['POST', '/gefuehrt/aktion'], ['POST', '/gefuehrt/hilfe']]) {
                const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-nova-principal': 'local-user' }, body: method === 'POST' ? '{}' : undefined })
                expect(res.status, `${method} ${path}`).toBe(403)
            }
        })
    })

    it('returns the checklist, example sentences and today\'s tip; actions only open questions or store „Nein danke“', async () => {
        const offerDevice = vi.fn(async () => ({ ok: true, message: 'Karte' }))
        const overview = async () => ({
            gefunden: [{ id: 'geraet:hue:192.0.2.11:80', title: 'Hue Bridge', kategorie: 'zuhause', wirkung: '', fund: '', verbunden: false, geraet: { id: 'dev-00000000bb', verbinden: 'hue', dienste: 1 } }],
            verbunden: [],
        }) as any
        let entries: any[] = []
        const deps = () => ({ dataDir: dir, inventory: null, verbunden: async () => entries, ruhezeit: () => false, isMain: () => true, checklist: { overview, telegramGekoppelt: () => true, offerDevice }, hilfe: { quellen: async () => ({ frage: { id: 'k000000000001', titel: 'Hue Bridge koppeln?' } }) } })
        const app = express(); app.use(express.json())
        registerGuidedApi(app, { ownerOnly: () => true, deps })
        await withServer(app, async base => {
            const first = await (await fetch(`${base}/gefuehrt`)).json()
            expect(first.einrichtung.kopf).toBe('1 von 3 erledigt')
            expect(first.beispiele).toEqual([])
            entries = [{ id: 'geraet:hue:192.0.2.11:80', title: 'Hue Bridge', kategorie: 'zuhause' }]
            const second = await (await fetch(`${base}/gefuehrt`)).json()
            expect(second.beispiele[0]).toMatchObject({ titel: 'Hue Bridge', saetze: ['Welche Lampen sind gerade an?', 'Mach alle Lampen aus', 'Dimm das Licht im Wohnzimmer auf die Hälfte'] })
            expect(second.tipp).toMatchObject({ id: 'hue-gemuetlich' })
            const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            expect((await post('/gefuehrt/aktion', { art: 'einrichten', key: 'geraet:dev-00000000bb' })).status).toBe(200)
            expect(offerDevice).toHaveBeenCalledWith('dev-00000000bb')
            expect((await post('/gefuehrt/aktion', { art: 'einrichten', key: '../../etc' })).status).toBe(400)
            expect((await post('/gefuehrt/aktion', { art: 'schalten', key: 'ki' })).status).toBe(400)
            expect((await post('/gefuehrt/aktion', { art: 'tipp-nein', id: 'hue-gemuetlich' })).status).toBe(200)
            expect((await (await fetch(`${base}/gefuehrt`)).json()).tipp).toBeNull()
            const help = await (await post('/gefuehrt/hilfe', {})).json()
            expect(help).toMatchObject({ quelle: 'frage', knopf: { label: 'Frage zeigen' } })
        })
    })
})
