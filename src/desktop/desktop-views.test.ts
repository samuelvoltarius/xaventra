import express from 'express'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopApi } from './desktop-api.js'
import { answerCardFromDesktop, collectHeute, previewReport, publicCard } from './desktop-views.js'
import { createApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor, type CardStoreOptions } from '../core/approval-cards.js'
import { issueDesktopAppLink, listDirectDesktops, startDesktopDirect, stopDesktopDirect } from '../desktop-direct/runtime.js'

vi.mock('../synthesis/self-evolution.js', () => ({ getPatchProposals: () => [], approveEvolutionProposal: vi.fn() }))

// Redesign: the Desktop app is a window to watch and press buttons in.
// New views are owner-only, carry no secrets, and a card answer uses the
// existing single-use card mechanism (no second approval logic).

const TOKEN = ['desktop-views-', 'test-token-24680'].join('')
const OWNER = '424242'
const FAKE_SECRET = ['sk-', 'proj-', 'abcdefghijklmnopqrstuvwx123456'].join('')

afterEach(async () => { vi.unstubAllEnvs(); await stopDesktopDirect() })

async function withServer(run: (base: string) => Promise<void>) {
    const app = express(); app.use(express.json()); registerDesktopApi(app, () => null)
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/desktop`) } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
}

const NEW_ENDPOINTS: Array<[string, string]> = [
    ['GET', '/heute'], ['GET', '/arbeit'], ['GET', '/system'], ['GET', '/system/vms'], ['GET', '/gedaechtnis'],
    ['POST', '/karten/k0123456789ab/antwort'], ['POST', '/direct/lab/link'],
]

describe('new Desktop views are owner-only', () => {
    it('tokenless loopback (non-owner) gets 403 on every new endpoint', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        await withServer(async base => {
            for (const [method, path] of NEW_ENDPOINTS) {
                const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-nova-principal': 'local-user' }, body: method === 'POST' ? JSON.stringify({ answer: 'ja', mode: 'view' }) : undefined })
                expect(res.status, `${method} ${path}`).toBe(403)
            }
        })
    })

    it('a wrong token gets 401, the owner token reaches the views', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', TOKEN)
        await withServer(async base => {
            for (const [method, path] of NEW_ENDPOINTS) {
                const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', authorization: 'Bearer wrong-token-wrong-token-1' }, body: method === 'POST' ? '{}' : undefined })
                expect(res.status, `${method} ${path}`).toBe(401)
            }
            const owner = { authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
            const gedaechtnis = await fetch(`${base}/gedaechtnis`, { headers: owner })
            expect(gedaechtnis.status).toBe(200)
            expect(gedaechtnis.headers.get('cache-control')).toBe('no-store')
            expect(Object.keys(await gedaechtnis.json())).toEqual(expect.arrayContaining(['entscheidungen', 'werkzeuge', 'probleme']))
            // Desktop-Direkt off: a link request is refused, nothing issued.
            const link = await fetch(`${base}/direct/lab/link`, { method: 'POST', headers: owner, body: JSON.stringify({ mode: 'view' }) })
            expect(link.status).toBe(409)
            expect(await link.json()).toMatchObject({ code: 'aus' })
        })
    })
})

describe('Knopf-Karten in the Desktop app', () => {
    let opts: CardStoreOptions
    let executed: string[]
    beforeEach(() => {
        opts = { dataDir: mkdtempSync(join(tmpdir(), 'desktop-views-cards-')), ledger: { recordApproval: vi.fn() } }
        executed = []
        unregisterCardExecutor('desktop-test')
        registerCardExecutor({ isStillOpen: () => true,
            kind: 'desktop-test',
            async execute(card, answer) { executed.push(`${card.id}:${answer}`); return { ok: true, message: 'ausgeführt' } },
            async reject(card) { executed.push(`${card.id}:nein`); return { ok: true, message: 'abgelehnt' } },
        })
    })
    const newCard = () => {
        const result = createApprovalCard({ art: 'desktop-test', titel: 'Dienst neu starten', beleg: `Log enthält ${FAKE_SECRET}`, vorschlag: 'Neustart', aktion: { kind: 'desktop-test', ref: 'svc-1' } }, opts)
        if (result.ok === false) throw new Error(result.reason)
        return result.card
    }

    it('the public card shows the possible answers but never a button token, chat id or secret', async () => {
        const card = newCard()
        const view = await collectHeute(opts)
        const shown = view.karten.find(item => item.id === card.id)!
        expect(shown.antworten).toEqual(expect.arrayContaining(['ja', 'nein', 'spaeter']))
        const json = JSON.stringify(view)
        for (const button of card.buttons) expect(json).not.toContain(button.token)
        expect(json).not.toContain(FAKE_SECRET)
        expect(Object.keys(publicCard(card))).not.toEqual(expect.arrayContaining(['buttons', 'usedTokens', 'messages', 'decidedBy']))
    })

    it('answers through the single-use card mechanism: owner required, first answer consumes all buttons', async () => {
        const card = newCard()
        expect((await answerCardFromDesktop(card.id, 'ja', { ...opts, ownerIds: [] })).status).toBe(403)
        expect((await answerCardFromDesktop(card.id, 'vielleicht', { ...opts, ownerIds: [OWNER] })).status).toBe(400)
        expect((await answerCardFromDesktop('k000000000000', 'ja', { ...opts, ownerIds: [OWNER] })).status).toBe(404)
        expect(executed).toEqual([])

        const first = await answerCardFromDesktop(card.id, 'ja', { ...opts, ownerIds: [OWNER] })
        expect(first.status).toBe(200)
        expect(executed).toEqual([`${card.id}:ja`])
        const stored = listApprovalCards(opts).find(item => item.id === card.id)!
        expect(stored.status).toBe('ja')
        expect(stored.decidedBy).toBe(`desktop:${OWNER}`)
        expect(stored.buttons).toEqual([])
        for (const button of card.buttons) expect(stored.usedTokens).toContain(button.token)
        expect(JSON.stringify(first.body)).not.toContain(OWNER)

        const replay = await answerCardFromDesktop(card.id, 'nein', { ...opts, ownerIds: [OWNER] })
        expect(replay.status).toBe(409)
        expect(executed).toEqual([`${card.id}:ja`])
    })
})

describe('Desktop-Direkt from the app uses the existing one-time link', () => {
    it('issues the same link as Telegram, audited as desktop, and lists desktops without target or password file', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'desktop-views-direct-'))
        expect(issueDesktopAppLink('lab', 'view', 'owner').ok).toBe(false)
        const started = await startDesktopDirect({ desktop: { direct: { enabled: true, publicBaseUrl: 'https://desktop.example.com', desktops: [
            { id: 'lab', label: 'Labor-VM', target: 'tcp://127.0.0.1:5901' },
            { id: 'kiosk', label: 'Kiosk', target: 'tcp://127.0.0.1:5902', allowControl: false },
        ] } } }, { dataDir, nodeOnly: false, listen: false })
        expect(started.started).toBe(true)

        const listed = JSON.stringify(listDirectDesktops())
        expect(listed).not.toContain('tcp://')
        expect(listed).toContain('Labor-VM')

        const link = issueDesktopAppLink('lab', 'control', 'owner')
        expect(link.ok).toBe(true)
        if (link.ok === true) expect(link.url).toMatch(/^https:\/\/desktop\.example\.com\/desktop\/s\/[A-Za-z0-9_-]{43}$/)
        expect(issueDesktopAppLink('kiosk', 'control', 'owner')).toMatchObject({ ok: false, code: 'nicht-erlaubt' })
        expect(issueDesktopAppLink('nope', 'view', 'owner')).toMatchObject({ ok: false, code: 'unbekannt' })
        expect(issueDesktopAppLink('lab', 'admin', 'owner')).toMatchObject({ ok: false, code: 'nicht-erlaubt' })

        const audit = readFileSync(join(dataDir, 'desktop-sessions.jsonl'), 'utf8')
        expect(audit).toContain('"by":"desktop:owner"')
        if (link.ok === true) expect(audit).not.toContain(link.url.split('/').pop())
    })
})

// 2.86 (Fremd-Fehler aus Paket M): Intl de-AT formatiert die Stunde als „08 Uhr“ — keine Zahl,
// die Vorschau war deshalb immer „Abendbericht“.
describe('Berichtsvorschau: Morgen oder Abend nach der Ortszeit', () => {
    it('vormittags Morgenbericht, abends Abendbericht (Europe/Vienna)', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'desktop-report-'))
        expect((await previewReport({ dataDir, now: () => Date.parse('2026-10-06T06:00:00.000Z') /* 08:00 Wien */ })).art).toBe('morgen')
        expect((await previewReport({ dataDir, now: () => Date.parse('2026-10-06T11:30:00.000Z') /* 13:30 Wien */ })).art).toBe('morgen')
        expect((await previewReport({ dataDir, now: () => Date.parse('2026-10-06T16:00:00.000Z') /* 18:00 Wien */ })).art).toBe('abend')
        expect((await previewReport({ dataDir, now: () => Date.parse('2026-10-06T22:30:00.000Z') /* 00:30 Wien */ })).art).toBe('morgen')
    })
})
