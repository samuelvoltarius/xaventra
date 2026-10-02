import express from 'express'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 2.85 Paket D: Werkzeugkasten in the Desktop app. Owner only; the buttons go
// through the toolbox actions (install queue + card); nothing installs here.

const toolbox = vi.hoisted(() => ({
    collect: vi.fn(async () => ({ generatedAt: '2026-10-02T10:00:00.000Z', knoten: [], gruppen: [], hinweis: 'x', probleme: [] })),
    install: vi.fn(async () => ({ ok: true, message: 'Karte geschickt', card: undefined })),
    remove: vi.fn(async () => ({ ok: false, message: 'Keine abgeschlossene Installation für diesen Rückweg.' })),
}))
vi.mock('../synthesis/self-evolution.js', () => ({ getPatchProposals: () => [], approveEvolutionProposal: vi.fn() }))
vi.mock('./werkzeugkasten-view.js', () => ({
    collectWerkzeugkasten: toolbox.collect, werkzeugkastenInstallieren: toolbox.install, werkzeugkastenEntfernen: toolbox.remove,
}))

import { registerDesktopApi } from './desktop-api.js'

const TOKEN = ['werkzeugkasten-', 'test-token-13579'].join('')
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

async function withServer(run: (base: string) => Promise<void>) {
    const app = express(); app.use(express.json()); registerDesktopApi(app, () => null)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/desktop`) } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
}

const ENDPOINTS: Array<[string, string, unknown?]> = [
    ['GET', '/werkzeugkasten'],
    ['POST', '/werkzeugkasten/installieren', { katalogId: 'tesseract-ocr' }],
    ['POST', '/werkzeugkasten/entfernen', { queueId: 'iq-0123456789ab' }],
]

describe('Werkzeugkasten-Endpunkte', () => {
    it('non-owner (tokenless loopback) gets 403 and nothing is called', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        await withServer(async base => {
            for (const [method, path, body] of ENDPOINTS) {
                const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
                expect(res.status, `${method} ${path}`).toBe(403)
            }
        })
        expect(toolbox.collect).not.toHaveBeenCalled()
        expect(toolbox.install).not.toHaveBeenCalled()
        expect(toolbox.remove).not.toHaveBeenCalled()
    })

    it('the owner reads the list (no-store) and the buttons pass only the id', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', TOKEN)
        const owner = { authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
        await withServer(async base => {
            const list = await fetch(`${base}/werkzeugkasten`, { headers: owner })
            expect(list.status).toBe(200)
            expect(list.headers.get('cache-control')).toBe('no-store')
            expect(Object.keys(await list.json())).toEqual(expect.arrayContaining(['gruppen', 'knoten']))
            const install = await fetch(`${base}/werkzeugkasten/installieren`, { method: 'POST', headers: owner, body: JSON.stringify({ katalogId: 'tesseract-ocr', befehl: 'rm -rf /' }) })
            expect(install.status).toBe(200)
            expect(toolbox.install).toHaveBeenCalledWith('tesseract-ocr')
            const remove = await fetch(`${base}/werkzeugkasten/entfernen`, { method: 'POST', headers: owner, body: JSON.stringify({ queueId: 'iq-0123456789ab' }) })
            expect(remove.status).toBe(409)
            expect(toolbox.remove).toHaveBeenCalledWith('iq-0123456789ab')
        })
    })
})
