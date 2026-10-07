import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerZugaengeApi } from './zugaenge-api.js'
import { fakeToken } from '../../test/helpers/fake-pve.js'

// 2.88: Verbindungen → Proxmox und Passwort-Tresor. Nur Owner; Werte gehen rein, nie raus.

// Fixture, assembled so secret scanners do not mistake it for a credential.
const VALUE = ['Haus', 'Dach', 'Fenster', '8'].join('-')
const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(':')
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'zugaenge-api-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function appWith(owner: boolean) {
    const app = express()
    app.use(express.json())
    registerZugaengeApi(app, {
        ownerOnly: (_req, res) => { if (!owner) res.status(403).json({ error: 'Nur der Besitzer.' }); return owner },
        proxmox: {
            dataDir: dir, cardOpts: { dataDir: dir, ledger: null }, configEnabled: () => false,
            tlsProbe: async () => ({ fingerprint: FP }), devices: () => [{ type: 'proxmox', host: '192.0.2.10', port: 8006 }],
            runtime: async () => ({ ok: false, reason: 'test' }),
        },
        tresor: { dataDir: dir },
    })
    return app
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

describe('Desktop: Proxmox und Passwort-Tresor (2.88)', () => {
    it('only the owner', async () => {
        const app = appWith(false)
        for (const [method, path] of [['GET', '/api/desktop/proxmox'], ['POST', '/api/desktop/proxmox'], ['GET', '/api/desktop/tresor'], ['POST', '/api/desktop/tresor']]) {
            expect((await call(app, method, path, method === 'POST' ? {} : undefined)).status).toBe(403)
        }
    })

    it('Proxmox: address suggested, token in, fingerprint card out — the token never comes back', async () => {
        const app = appWith(true)
        const view = await call(app, 'GET', '/api/desktop/proxmox')
        expect(view.data).toMatchObject({ eingerichtet: false, vorschlaege: ['https://192.0.2.10:8006'] })
        expect(view.data.anleitung).toHaveLength(3)
        const token = fakeToken()
        const saved = await call(app, 'POST', '/api/desktop/proxmox', { token })
        expect(saved.status).toBe(200)
        expect(saved.data).toMatchObject({ ok: true, fingerabdruck: { anfang: '10:11:12:13', ende: '2C:2D:2E:2F' }, proxmox: { tokenGespeichert: true, fingerabdruck: { bestaetigt: false } } })
        expect(saved.text).not.toContain(token.split('=')[1])
        expect((await call(app, 'POST', '/api/desktop/proxmox', { token: 'falsch' })).status).toBe(400)
        const removed = await call(app, 'DELETE', '/api/desktop/proxmox')
        expect(removed.data.proxmox).toMatchObject({ tokenGespeichert: false, adresse: null })
    })

    it('Tresor: entries go in with their value, only ids/names/services come out', async () => {
        const app = appWith(true)
        const saved = await call(app, 'POST', '/api/desktop/tresor', { id: 'github-main', label: 'GitHub', quelle: 'datei', dienste: 'github.com', benutzer: 'owner@example.com', geheim: VALUE })
        expect(saved.data.eintraege).toEqual([{ id: 'github-main', label: 'GitHub', quelle: 'datei', dienste: ['github.com'] }])
        expect(saved.text).not.toContain(VALUE)
        expect(saved.text).not.toContain('owner@example.com')
        expect((await call(app, 'POST', '/api/desktop/tresor', { id: 'X Y', quelle: 'datei' })).data).toMatchObject({ ok: false, feld: 'id' })
        expect((await call(app, 'GET', '/api/desktop/tresor')).data.hinweise.join(' ')).toMatch(/ändern machst du selbst/)
        expect((await call(app, 'DELETE', '/api/desktop/tresor/github-main')).data.eintraege).toEqual([])
    })
})
