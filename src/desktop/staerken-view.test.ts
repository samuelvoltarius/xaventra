import express from 'express'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StrengthFacts, StrengthNodeFacts } from '../mesh/node-strengths.js'

// 2.86 Paket J Punkt 5: Desktop „System“ — Karte „wer kann was am besten“.
// Owner only über /api/desktop; eigene Renderer-Datei; minimale Navigation.
const NOW = Date.parse('2026-10-02T12:00:00.000Z')
const node = (id: string, patch: Partial<StrengthNodeFacts>, hw: Partial<StrengthNodeFacts['hardware']> = {}): StrengthNodeFacts => ({
    nodeId: id, local: false, lastSeen: NOW - 10_000, runtimes: [], tools: [], selfCheck: 'ok', ...patch,
    hardware: { cpus: 4, ramGB: 8, gpuName: null, gpuBackend: 'cpu', viaVllm: false, ...hw },
})
const facts: StrengthFacts = {
    now: NOW, measurements: [],
    nodes: [
        node('main-x', { local: true, role: 'main' }, { ramGB: 128, cpus: 20, viaVllm: true, gpuName: 'GB10', gpuBackend: 'cuda', diskTotalGB: 1000, diskFreeGB: 400 }),
        node('knoten-a', { runtimes: [{ name: 'comfyui', type: 'image', models: [], running: true }] }, { gpuName: '<img src=x onerror=alert(1)>', gpuBackend: 'cuda', gpuVramGB: 24 }),
        node('alt', { lastSeen: NOW - 3_600_000 }),
    ],
}
const strengths = vi.hoisted(() => ({ collect: vi.fn(), changes: vi.fn() }))
vi.mock('../mesh/node-strengths.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../mesh/node-strengths.js')>()),
    collectStrengthFacts: strengths.collect,
    listStrengthChanges: strengths.changes,
}))
vi.mock('../synthesis/self-evolution.js', () => ({ getPatchProposals: () => [], approveEvolutionProposal: vi.fn() }))

import { staerkenViewFrom } from './staerken-view.js'
import { registerDesktopApi } from './desktop-api.js'

const TOKEN = ['staerken-', 'test-token-24680'].join('')
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
const file = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

async function withServer(run: (base: string) => Promise<void>) {
    const app = express(); app.use(express.json()); registerDesktopApi(app, () => null)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/desktop`) } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
}

describe('Stärken-Karte: Daten', () => {
    it('je Fähigkeit die besten Plätze mit Begründung, Main-Rangliste, Ausschlüsse und Änderungen', () => {
        const view = staerkenViewFrom(facts, [{ at: '2026-10-02T11:00:00.000Z', nodeId: 'knoten-a', changes: ['neue GPU: RTX 4090 (cuda)'] }])
        const bilder = view.faehigkeiten.find(item => item.id === 'bilder')!
        expect(bilder.titel).toBe('Bilder erzeugen')
        expect(bilder.plaetze[0]).toMatchObject({ platz: 1, knoten: 'knoten-a' })
        expect(bilder.plaetze[0].begruendung.join(' ')).toContain('comfyui')
        expect(view.main.plaetze[0].knoten).toBe('main-x')
        expect(view.knoten).toEqual(expect.arrayContaining([{ id: 'alt', lokal: false, frisch: false }, { id: 'main-x', lokal: true, frisch: true }]))
        expect(view.aenderungen[0]).toMatchObject({ knoten: 'knoten-a', text: ['neue GPU: RTX 4090 (cuda)'] })
        expect(view.faehigkeiten.map(item => item.id)).toEqual(['bilder', 'grosse-modelle', 'llm', 'embedding', 'stt', 'tts', 'vision', 'medien', 'speicher', 'rechnen'])
    })
})

describe('/api/desktop/system/staerken', () => {
    it('ohne Owner-Token 403 und nichts wird gelesen', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        await withServer(async base => {
            expect((await fetch(`${base}/system/staerken`)).status).toBe(403)
        })
        expect(strengths.collect).not.toHaveBeenCalled()
    })

    it('der Owner liest die Karte (no-store)', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', TOKEN)
        strengths.collect.mockResolvedValue(facts)
        strengths.changes.mockResolvedValue([])
        await withServer(async base => {
            const res = await fetch(`${base}/system/staerken`, { headers: { authorization: `Bearer ${TOKEN}` } })
            expect(res.status).toBe(200)
            expect(res.headers.get('cache-control')).toBe('no-store')
            const body = await res.json()
            expect(body.main.plaetze[0].knoten).toBe('main-x')
        })
    })
})

describe('Renderer staerken.js', () => {
    it('ist eine eigene Datei der einen Oberfläche, vor app.js geladen, auf der Seite System eingebunden', () => {
        expect(file('src/dev/copy-dashboard-assets.ts')).toContain(`'staerken.js'`)
        expect(file('src/dashboard/server.ts')).toContain(`'staerken.js': 'text/javascript; charset=utf-8'`)
        const html = file('desktop/renderer/index.html')
        expect(html.indexOf('staerken.js')).toBeGreaterThan(0)
        expect(html.indexOf('staerken.js')).toBeLessThan(html.indexOf('app.js'))
        const app = file('desktop/renderer/app.js')
        expect(app).toContain(`staerken: '/api/desktop/system/staerken'`)
        expect(app).toContain('window.Knotenstaerken')
    })

    it('zeigt Plätze und Begründungen und maskiert alles', () => {
        const sandbox: any = { window: {}, document: {}, Date, Number, String, Object, Math }
        runInNewContext(file('desktop/renderer/staerken.js'), sandbox)
        const ui = sandbox.window.Knotenstaerken
        const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' } as any)[char])
        const data = staerkenViewFrom(facts, [{ at: '2026-10-02T11:00:00.000Z', nodeId: 'knoten-a', changes: ['neue GPU: <script>'] }])
        const h = { esc, attr: esc, icon: () => '', relTime: () => 'vor 1 Std.', viewState: () => ({ data, error: null }), viewErrorBlock: () => 'FEHLER', skeletonSection: () => 'LADEN' }
        const html = ui.section(h)
        expect(html).toContain('Wer kann was am besten')
        expect(html).toContain('Bilder erzeugen')
        expect(html).toContain('knoten-a')
        expect(html).toContain('Main (Nachfolge)')
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
        expect(html).not.toContain('<img src=x')
        expect(html).toContain('neue GPU: &lt;script&gt;')
        expect(html).toContain('veraltet')
        expect(ui.section({ ...h, viewState: () => ({ data: null, error: null }) })).toContain('LADEN')
    })
})
