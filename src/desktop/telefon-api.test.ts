import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerTelefonApi } from './telefon-api.js'

// 2.87 Paket P: Verbindungen → Telefon. Nur Owner; Passwort geht rein, nie raus.
// Kein Netz: Login-Prüfung und Neustart sind Fakes.

const PASSWORT = 'Beispiel-Passwort-123'
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'telefon-api-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function appWith(owner: boolean) {
    const app = express()
    app.use(express.json())
    const check = vi.fn(async (_target: any, password: string, anbieter?: string) => password === PASSWORT
        ? { ok: true, text: `Telefon angemeldet: der Zugang bei ${anbieter} stimmt.` }
        : { ok: false, text: `Anmeldung bei ${anbieter} hat nicht geklappt — Passwort prüfen.` })
    const apply = vi.fn(async () => false)
    registerTelefonApi(app, {
        ownerOnly: (_req, res) => { if (!owner) res.status(403).json({ error: 'Nur der Besitzer.' }); return owner },
        store: { dataDir: dir }, check, apply,
    })
    return { app, check, apply }
}

async function call(app: express.Express, method: string, path: string, body?: unknown) {
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const port = (server.address() as any).port
    try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
        const text = await response.text()
        return { status: response.status, text, data: JSON.parse(text) }
    } finally { server.close() }
}

describe('/api/desktop/telefon', () => {
    it('nur der Owner', async () => {
        const { app } = appWith(false)
        expect((await call(app, 'GET', '/api/desktop/telefon')).status).toBe(403)
        expect((await call(app, 'PATCH', '/api/desktop/telefon', { server: 'sip.zadarma.com' })).status).toBe(403)
    })

    it('Zadarma mit drei Feldern; Passwort nie in einer Antwort; Telefon wird neu geladen', async () => {
        const { app, apply } = appWith(true)
        const saved = await call(app, 'PATCH', '/api/desktop/telefon', { server: 'sip.zadarma.com', login: '100100', passwort: PASSWORT })
        expect(saved.status).toBe(200)
        expect(saved.text).not.toContain(PASSWORT)
        expect(saved.data.telefon.sip).toMatchObject({ server: 'sip.zadarma.com', transport: 'tls', port: 5061, anbieter: 'Zadarma' })
        expect(saved.data.telefon.passwortGespeichert).toBe(true)
        expect(saved.data.telefon.lauscht).toBe(false)
        expect(saved.data.telefon.hinweise.join(' ')).toContain('Für Anrufe von außen fehlt noch eine Telefonnummer im Zadarma-Konto')
        expect(apply).toHaveBeenCalled()
        const read = await call(app, 'GET', '/api/desktop/telefon')
        expect(read.text).not.toContain(PASSWORT)
    })

    it('Login prüfen: Alltagssatz, Ergebnis gemerkt', async () => {
        const { app, check } = appWith(true)
        await call(app, 'PATCH', '/api/desktop/telefon', { server: 'sip.zadarma.com', login: '100100', passwort: 'falsch-aber-beispiel' })
        const wrong = await call(app, 'POST', '/api/desktop/telefon/pruefen')
        expect(wrong.data).toEqual({ ok: false, text: 'Anmeldung bei Zadarma hat nicht geklappt — Passwort prüfen.' })
        await call(app, 'PATCH', '/api/desktop/telefon', { passwort: PASSWORT })
        const right = await call(app, 'POST', '/api/desktop/telefon/pruefen')
        expect(right.data.text).toBe('Telefon angemeldet: der Zugang bei Zadarma stimmt.')
        expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ server: 'sip.zadarma.com', login: '100100' }), PASSWORT, 'Zadarma')
        expect((await call(app, 'GET', '/api/desktop/telefon')).data.pruefung).toMatchObject({ ok: true })
    })

    it('kaputte Eingabe: 400 mit Feld, nichts gespeichert', async () => {
        const { app } = appWith(true)
        const bad = await call(app, 'PATCH', '/api/desktop/telefon', { server: 'http://sip.example.com' })
        expect(bad.status).toBe(400)
        expect(bad.data.feld).toBe('server')
    })

    it('Asterisk-Weg zeigt die Vorlage für die Anlage; Löschen entfernt alles', async () => {
        const { app } = appWith(true)
        const saved = await call(app, 'PATCH', '/api/desktop/telefon', { weg: 'asterisk', aktiv: true, ownerNummern: ['+43 1 2345678'] })
        expect(saved.data.telefon.vorlage).toContain('AudioSocket(${XAVENTRA_ID},127.0.0.1:18796)')
        const gone = await call(app, 'DELETE', '/api/desktop/telefon')
        expect(gone.data.telefon.aktiv).toBe(false)
        expect(gone.data.telefon.passwortGespeichert).toBe(false)
    })
})
