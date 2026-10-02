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

    it('Owner-Entscheidung 02.10.: Werkzeugkasten und Verbindungen stehen in der Hauptleiste, nicht unter „Mehr“', () => {
        const app = file('desktop/renderer/app.js')
        const block = (name: string) => {
            const start = app.indexOf(`const ${name} = `)
            const open = app.indexOf(name === 'MORE_PAGES' ? '{' : '[', start)
            let depth = 0
            for (let i = open; i < app.length; i++) {
                if ('[{'.includes(app[i])) depth++
                if (']}'.includes(app[i]) && --depth === 0) return runInNewContext(`(${app.slice(open, i + 1)})`)
            }
            throw new Error(`${name} fehlt`)
        }
        const main = block('NAV_MAIN').map((entry: string[]) => entry[0])
        expect(main).toEqual(expect.arrayContaining(['heute', 'verbindungen', 'werkzeugkasten']))
        expect(main.indexOf('werkzeugkasten')).toBe(main.indexOf('verbindungen') + 1)
        expect(Object.keys(block('MORE_PAGES'))).not.toContain('werkzeugkasten')
        // Its own page: no "zurück zu Mehr" link.
        expect(app).not.toMatch(/subPage\('werkzeugkasten'/)
    })

    it('KI-Modelle (Paket C) in „Verbindungen“: API-Key einmal einfügen, Konto-Anmeldung nur wo erlaubt, Trennen über den eigenen Weg', () => {
        const sandbox: any = { window: {}, document: {}, Date, Number, String, Object, Promise, encodeURIComponent, URLSearchParams }
        runInNewContext(file('desktop/renderer/connections.js'), sandbox)
        const ui = sandbox.window.XaventraConnections
        const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' } as any)[char])
        const h = { esc, attr: esc, icon: () => '', toast: () => undefined, fail: () => undefined, rerender: () => undefined, api: {} }
        const data = {
            gefunden: [{ id: 'ki-modelle:lokal:ollama', title: 'Ollama im eigenen Netz (192.168.1.30)', kategorie: 'ki-modelle', fund: 'im Netz 192.168.1.30:11434', wirkung: '2 lokale Modelle — privat, ohne Frage nutzbar', datenklasse: 'lokal', verbunden: true, icon: null }],
            moeglich: { gruppen: [{ kategorie: 'ki-modelle', label: 'KI-Modelle', eintraege: [
                { connectorId: 'llm:anthropic', title: 'Anthropic (Claude)', wirkung: 'Claude-Modelle', datenklasse: 'cloud', status: 'moeglich', icon: null, llm: { provider: 'anthropic', konto: null, kontoHinweis: 'nur API-Key', keyUrl: 'https://platform.claude.com/settings/keys' } },
                { connectorId: 'llm:openrouter', title: 'OpenRouter', wirkung: 'Viele Modelle', datenklasse: 'cloud', status: 'moeglich', icon: null, llm: { provider: 'openrouter', konto: 'openrouter-pkce', kontoHinweis: 'offizielle Anmeldung', keyUrl: 'https://openrouter.ai/settings/keys' } },
            ] }], verzeichnis: { anzahl: 0 } },
            verbunden: [{ id: 'ki-modelle:cloud:openai', connectorId: 'llm:openai', title: 'OpenAI (ChatGPT)', status: 'verbunden', trust: 'geprueft', datenklasse: 'cloud', darf: { lesen: [], fragt: [], nie: [], sonst: 'Privates geht nie in die Cloud.' }, aktion: 'keine', icon: null, llm: { provider: 'openai', trennbar: true, maske: '••••1234' } }],
        }
        let rendered = ''
        const page = { querySelector: () => null, querySelectorAll: () => [] }
        sandbox.document.querySelector = () => page
        return new Promise<void>(resolve => {
            ui.mount({ ...h, api: { get: async () => data }, rerender: () => { rendered = ui.view(h); resolve() } })
        }).then(() => {
            expect(rendered).toContain('KI-Modelle')
            expect(rendered).toContain('data-conn-llm-key="anthropic"')
            expect(rendered).not.toContain('data-conn-llm-login="anthropic"')
            expect(rendered).toContain('data-conn-llm-login="openrouter"')
            expect(rendered).not.toContain('data-conn-connect="llm:')
            expect(rendered).toContain('data-conn-llm-disconnect="openai"')
            expect(rendered).not.toContain('data-conn-disconnect="ki-modelle:cloud:openai"')
            expect(rendered).toContain('Key ••••1234')
            expect(rendered).toContain('in Nutzung')
        })
    })
})
