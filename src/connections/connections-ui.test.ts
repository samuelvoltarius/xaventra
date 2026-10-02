import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_UI_FILES } from '../dev/copy-dashboard-assets.js'

const file = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

describe('Desktop-Ansicht „Verbindungen“ (2.85 Paket A, Punkt 6)', () => {
    it('is part of the one UI: own file, served and copied, loaded before app.js, one navigation entry', () => {
        expect(DASHBOARD_UI_FILES).toContain('connections.js')
        expect(file('src/dashboard/server.ts')).toContain(`'connections.js': 'text/javascript; charset=utf-8'`)
        const html = file('desktop/renderer/index.html')
        expect(html.indexOf('connections.js')).toBeGreaterThan(0)
        expect(html.indexOf('connections.js')).toBeLessThan(html.indexOf('app.js'))
        const app = file('desktop/renderer/app.js')
        expect(app).toContain(`['verbindungen', 'Verbindungen', 'plug']`)
        expect(app).toContain('window.XaventraConnections')
    })

    it('renders the three areas from the API data and escapes everything it shows', () => {
        const sandbox: any = { window: {}, document: {}, Date, Number, String, Object, Promise, encodeURIComponent, URLSearchParams }
        runInNewContext(file('desktop/renderer/connections.js'), sandbox)
        const ui = sandbox.window.XaventraConnections
        const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' } as any)[char])
        const h = { esc, attr: esc, icon: () => '', toast: () => undefined, fail: () => undefined, rerender: () => undefined, api: {} }
        expect(ui.view(h)).toContain('aria-busy')
        // Feed data through the module's own state by mounting with a fake API.
        const data = {
            gefunden: [{ id: 'g1', title: '<b>Home Assistant</b>', fund: 'im Netz 192.168.1.10:8123', wirkung: 'kann dann Lichter schalten', connectorId: 'home-assistant', datenklasse: 'lokal', verbunden: false, icon: null }],
            moeglich: { gruppen: [{ kategorie: 'kalender', label: 'Kalender', eintraege: [{ connectorId: 'google-calendar', title: 'Google Kalender', wirkung: 'Termine lesen', datenklasse: 'cloud', status: 'moeglich', icon: null, hinweis: 'Vorher einmal einen Google-OAuth-Client anlegen' }] }], verzeichnis: { anzahl: 1234 } },
            verbunden: [{ id: 'c-gmail', title: 'Gmail', status: 'abgelaufen', trust: 'geprueft', datenklasse: 'cloud', darf: { lesen: ['get_message'], fragt: ['create_draft'], nie: [], sonst: 'Privates geht nie in die Cloud.' }, aktion: 'anmelden', icon: null }],
        }
        let rendered = ''
        const page = { querySelector: () => null, querySelectorAll: () => [] }
        sandbox.document.querySelector = () => page
        const api = { get: async () => data }
        return new Promise<void>(resolve => {
            ui.mount({ ...h, api, rerender: () => { rendered = ui.view(h); resolve() } })
        }).then(() => {
            expect(rendered).toContain('Gefunden')
            expect(rendered).toContain('Möglich')
            expect(rendered).toContain('Verbunden')
            expect(rendered).toContain('&lt;b&gt;Home Assistant&lt;/b&gt;')
            expect(rendered).not.toContain('<b>Home Assistant</b>')
            expect(rendered).toContain('data-conn-connect="home-assistant"')
            expect(rendered).toContain('Cloud · nichts Privates')
            expect(rendered).toContain('1234 Einträge, nicht geprüft')
            expect(rendered).toContain('data-conn-login="c-gmail"')
            expect(rendered).toContain('Trennen')
            expect(rendered).toContain('Fragt dich: create_draft')
        })
    })
})
