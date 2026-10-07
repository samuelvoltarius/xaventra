import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearAgentDesktopInputHolds } from '../desktop-direct/pause.js'
import { _resetBildschirme } from './bildschirm.js'
import { registerSehenApi } from './sehen-api.js'

// 2.88: Ihr Computer, Aktivität, Regeln — nur Owner, an der bestehenden Desktop-API.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 3)])
let dir = ''
let stopped: string[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sehen-api-')); stopped = []; _resetBildschirme(); clearAgentDesktopInputHolds() })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); _resetBildschirme(); clearAgentDesktopInputHolds() })

function appWith(owner: boolean) {
    const app = express()
    app.use(express.json())
    registerSehenApi(app, {
        ownerOnly: (_req, res) => { if (!owner) res.status(403).json({ error: 'Owner authorization required' }); return owner },
        principal: () => 'desktop-owner', takt: false,
        regeln: { dataDir: dir, isMain: () => true },
        aktivitaet: {
            dataDir: dir, aufgaben: async () => [], aktuelleAufgabe: async () => null, arbeit: async () => ({ missions: [], responsibilities: [] }),
            subagenten: async () => [{ id: 'sub_1', task: 'Preise vergleichen', status: 'running', durationMs: 1000 }], delegationen: async () => [], jobs: async () => [],
            auftrag: async () => null, subagentStopp: async id => { stopped.push(id); return true },
        },
        bildschirm: {
            env: {}, lokalerNode: () => 'main-a', nodes: async () => ['main-a', 'spark-a'], direkt: async () => ({ enabled: false, desktops: [] }), aktivitaet: async () => [],
            aufnahme: async () => ({ base64: PNG.toString('base64'), bytes: PNG.length, sha256: createHash('sha256').update(PNG).digest('hex'), capturedAt: new Date().toISOString(), mimeType: 'image/png' }),
        },
    })
    return app
}

async function call(app: express.Express, method: string, path: string, body?: unknown) {
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const port = (server.address() as any).port
    try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: response.status, data: await response.json() as any }
    } finally { server.close() }
}

describe('Sehen und lenken – Owner-API', () => {
    it('nur der Owner sieht und steuert', async () => {
        const app = appWith(false)
        for (const [method, path] of [['GET', '/api/desktop/aktivitaet'], ['POST', '/api/desktop/aktivitaet/subagent:sub_1'], ['GET', '/api/desktop/bildschirme'],
            ['GET', '/api/desktop/bildschirme/node:spark-a/bild'], ['POST', '/api/desktop/bildschirme/node:spark-a'], ['POST', '/api/desktop/bildschirme/node:spark-a/eingabe'],
            ['GET', '/api/desktop/regeln'], ['POST', '/api/desktop/regeln'], ['DELETE', '/api/desktop/regeln/d-0123456789']]) {
            expect((await call(app, method, path, method === 'GET' ? undefined : {})).status).toBe(403)
        }
        expect(stopped).toEqual([])
    })

    it('Aktivität: Liste und Stopp', async () => {
        const app = appWith(true)
        const list = await call(app, 'GET', '/api/desktop/aktivitaet')
        expect(list.data.eintraege[0]).toMatchObject({ id: 'subagent:sub_1', tut: 'Helfer: Preise vergleichen' })
        const stop = await call(app, 'POST', '/api/desktop/aktivitaet/subagent%3Asub_1', { aktion: 'stopp' })
        expect(stop).toMatchObject({ status: 200, data: { ok: true } })
        expect(stopped).toEqual(['sub_1'])
        expect((await call(app, 'POST', '/api/desktop/aktivitaet/subagent%3Asub_1', { aktion: 'sprengen' })).status).toBe(409)
    })

    it('Ihr Computer: Liste, Bild als data-taugliches PNG, Übernehmen', async () => {
        const app = appWith(true)
        const list = await call(app, 'GET', '/api/desktop/bildschirme')
        expect(list.data.bildschirme.map((item: any) => item.id)).toEqual(['node:spark-a'])
        const bild = await call(app, 'GET', '/api/desktop/bildschirme/node%3Aspark-a/bild')
        expect(bild.data).toMatchObject({ ok: true, bild: { mimeType: 'image/png', base64: PNG.toString('base64') } })
        const take = await call(app, 'POST', '/api/desktop/bildschirme/node%3Aspark-a', { aktion: 'uebernehmen' })
        expect(take.data.ok).toBe(true)
        expect((await call(app, 'GET', '/api/desktop/bildschirme')).data.agentPausiert).toMatch(/pausiert/)
    })

    it('Regeln: hinzufügen, ändern, entfernen', async () => {
        const app = appWith(true)
        const created = await call(app, 'POST', '/api/desktop/regeln', { text: 'Bei Mails immer fragen' })
        expect(created.data).toMatchObject({ ok: true, regel: { wirkung: 'fragen', quelle: 'app' } })
        const fest = await call(app, 'POST', '/api/desktop/regeln', { text: 'Bezahlen darfst du ohne Frage' })
        expect(fest.data.regel).toMatchObject({ fest: true, wirksam: false })
        const list = await call(app, 'GET', '/api/desktop/regeln')
        expect(list.data.regeln).toHaveLength(2)
        const id = created.data.regel.id
        expect((await call(app, 'POST', `/api/desktop/regeln/${id}`, { wirkung: 'blockieren' })).data.regel.wirkung).toBe('blockieren')
        const current = (await call(app, 'GET', '/api/desktop/regeln')).data.regeln.find((item: any) => item.wirkung === 'blockieren')
        expect((await call(app, 'DELETE', `/api/desktop/regeln/${current.id}`)).data.ok).toBe(true)
        expect((await call(app, 'GET', '/api/desktop/regeln')).data.regeln).toHaveLength(1)
    })
})
