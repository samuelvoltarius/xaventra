import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    EVEN_G2_DEFAULT_PORT, answerCardFromG2, buildHudSnapshot, formatForG2, resolveEvenG2Settings,
    startEvenG2Channel, startEvenG2Server, tokenMatches, type EvenG2Deps, type EvenG2Server,
} from './even-g2.js'
import { createApprovalCard, listApprovalCards, registerCardExecutor, unregisterCardExecutor } from '../core/approval-cards.js'

// Test values only: generated at runtime, never a real secret.
const TOKEN = `g2-test-${'x'.repeat(32)}`
const OWNER = '100200300'

let dataDir = ''
let servers: EvenG2Server[] = []

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'even-g2-')) })
afterEach(async () => {
    for (const server of servers) await server.close()
    servers = []
    unregisterCardExecutor('g2-test')
    unregisterCardExecutor('drucken-test')
    rmSync(dataDir, { recursive: true, force: true })
})

function deps(overrides: Partial<EvenG2Deps> = {}): EvenG2Deps {
    return {
        token: TOKEN,
        ask: vi.fn(async (question: string) => `Antwort auf ${question}`),
        overflow: vi.fn(async () => undefined),
        fence: vi.fn(async () => undefined),
        hudSnapshot: async () => buildHudSnapshot({ status: 'Bereit', openCards: listApprovalCards({ dataDir, status: ['offen'] }) }),
        answerCard: (cardId, answer) => answerCardFromG2(cardId, answer, { ownerIds: [OWNER], dataDir, ledger: null }),
        budgetMs: 2_000,
        ...overrides,
    }
}

async function start(d: EvenG2Deps): Promise<{ url: string; server: EvenG2Server }> {
    const server = await startEvenG2Server({ port: 0 }, d)
    servers.push(server)
    const address = server.server.address() as AddressInfo
    return { url: `http://127.0.0.1:${address.port}`, server }
}

const ask = (url: string, content: string, token: string | null = TOKEN, path = '/') => fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ model: 'openclaw', messages: [{ role: 'user', content }] }),
})

describe('Even G2 settings', () => {
    it('is off by default', () => {
        expect(resolveEvenG2Settings({}, { NOVA_EVEN_G2_TOKEN: TOKEN }).start).toBe(false)
        expect(resolveEvenG2Settings({ channels: { evenG2: {} } }, { NOVA_EVEN_G2_TOKEN: TOKEN }).start).toBe(false)
        expect(resolveEvenG2Settings({ channels: { evenG2: { enabled: 'true' } } }, { NOVA_EVEN_G2_TOKEN: TOKEN }).start).toBe(false)
    })

    it('needs a token from the environment', () => {
        const config = { channels: { evenG2: { enabled: true } } }
        expect(resolveEvenG2Settings(config, {}).start).toBe(false)
        expect(resolveEvenG2Settings(config, { NOVA_EVEN_G2_TOKEN: 'kurz' }).start).toBe(false)
        const ok = resolveEvenG2Settings(config, { NOVA_EVEN_G2_TOKEN: TOKEN })
        expect(ok.start).toBe(true)
        expect(ok.settings?.port).toBe(EVEN_G2_DEFAULT_PORT)
        // the token never appears in the reason text
        expect(ok.token).toBe(TOKEN)
        expect(JSON.stringify({ reason: ok.reason, settings: ok.settings })).not.toContain(TOKEN)
    })

    it('never starts on a worker', () => {
        const config = { channels: { evenG2: { enabled: true } } }
        const result = resolveEvenG2Settings(config, { NOVA_EVEN_G2_TOKEN: TOKEN, NOVA_NODE_ONLY: 'true' })
        expect(result.start).toBe(false)
        expect(result.reason).toMatch(/Worker/)
    })

    it('ignores a configured host: loopback only', () => {
        const result = resolveEvenG2Settings({ channels: { evenG2: { enabled: true, host: '0.0.0.0', port: 19999 } } }, { NOVA_EVEN_G2_TOKEN: TOKEN })
        expect(result.settings).toMatchObject({ port: 19999 })
        expect(result.settings).not.toHaveProperty('host')
    })

    it('a worker never opens the endpoint', async () => {
        const factory = vi.fn(() => deps())
        const server = await startEvenG2Channel({ channels: { evenG2: { enabled: true, port: 0 } } }, { NOVA_EVEN_G2_TOKEN: TOKEN, NOVA_NODE_ONLY: 'true' }, factory)
        expect(server).toBeNull()
        expect(factory).not.toHaveBeenCalled()
    })
})

describe('Even G2 endpoint', () => {
    it('binds to loopback only', async () => {
        const { server } = await start(deps())
        expect((server.server.address() as AddressInfo).address).toBe('127.0.0.1')
    })

    it('constant-time token check accepts only the exact token', () => {
        expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
        expect(tokenMatches(` ${TOKEN}\n`, TOKEN)).toBe(true)
        expect(tokenMatches(TOKEN.slice(1), TOKEN)).toBe(false)
        expect(tokenMatches(`${TOKEN.slice(0, -1)}y`, TOKEN)).toBe(false)
        expect(tokenMatches('', TOKEN)).toBe(false)
        expect(tokenMatches(TOKEN, '')).toBe(false)
    })

    it('without or with a wrong token: 401 and no pipeline run', async () => {
        const d = deps()
        const { url } = await start(d)
        expect((await ask(url, 'Hallo', null)).status).toBe(401)
        expect((await ask(url, 'Hallo', 'falsch')).status).toBe(401)
        expect((await ask(url, 'Hallo', `${TOKEN.slice(0, -1)}y`)).status).toBe(401)
        const basic = await fetch(`${url}/`, { method: 'POST', headers: { Authorization: `Basic ${TOKEN}` }, body: '{}' })
        expect(basic.status).toBe(401)
        expect(d.ask).not.toHaveBeenCalled()
        expect(d.fence).not.toHaveBeenCalled()
    })

    it('answers in the OpenAI chat.completion format on the root route', async () => {
        const d = deps()
        const { url } = await start(d)
        const response = await ask(url, 'Wie spät ist es?')
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.object).toBe('chat.completion')
        expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'Antwort auf Wie spät ist es?' })
        expect(response.headers.get('access-control-allow-origin')).toBeNull()
        expect(d.ask).toHaveBeenCalledTimes(1)
    })

    it('a doubled question runs the pipeline once and both get the same answer', async () => {
        let release: (value: string) => void = () => undefined
        const d = deps({ ask: vi.fn(() => new Promise<string>(resolve => { release = resolve })) })
        const { url } = await start(d)
        const first = ask(url, 'Was steht heute an?')
        const second = ask(url, '  was steht heute an? ')
        await vi.waitFor(() => expect(d.ask).toHaveBeenCalledTimes(1))
        await new Promise(resolve => setTimeout(resolve, 50))
        release('Zwei Termine.')
        const [a, b] = await Promise.all([first, second])
        expect((await a.json()).choices[0].message.content).toBe('Zwei Termine.')
        expect((await b.json()).choices[0].message.content).toBe('Zwei Termine.')
        expect(d.ask).toHaveBeenCalledTimes(1)
    })

    it('the same question after the dedupe window runs again', async () => {
        let now = 1_000_000
        const d = deps({ now: () => now, dedupeMs: 30_000 })
        const { url } = await start(d)
        await ask(url, 'Wetter?')
        now += 31_000
        await ask(url, 'Wetter?')
        expect(d.ask).toHaveBeenCalledTimes(2)
    })

    it('answer is at most 400 characters and without Markdown', async () => {
        const long = `## Überschrift\n\n**Fett** und *kursiv* mit \`code\` und [Link](https://example.com).\n\n- Punkt eins\n- Punkt zwei\n\n\`\`\`ts\nconst x = 1\n\`\`\`\n\n${'Ein langer Satz über das Wetter. '.repeat(40)}`
        const d = deps({ ask: vi.fn(async () => long) })
        const { url } = await start(d)
        const content: string = (await (await ask(url, 'Lang bitte')).json()).choices[0].message.content
        expect(content.length).toBeLessThanOrEqual(400)
        expect(content).not.toMatch(/\*\*|`|^#|\]\(|^\s*[-*]\s/m)
        expect(content).toContain('Fett und kursiv mit code und Link.')
    })

    it('over the time budget: short interim answer, result later via overflow (once)', async () => {
        let release: (value: string) => void = () => undefined
        const d = deps({ budgetMs: 80, ask: vi.fn(() => new Promise<string>(resolve => { release = resolve })) })
        const { url } = await start(d)
        const started = Date.now()
        const [a, b] = await Promise.all([ask(url, 'Recherchiere lange'), ask(url, 'Recherchiere lange')])
        expect(Date.now() - started).toBeLessThan(1_500)
        const contentA = (await a.json()).choices[0].message.content
        expect(contentA).toMatch(/arbeite dran.*Telegram/i)
        expect((await b.json()).choices[0].message.content).toBe(contentA)
        expect(d.overflow).not.toHaveBeenCalled()
        release('Das ausführliche Ergebnis.')
        await vi.waitFor(() => expect(d.overflow).toHaveBeenCalledTimes(1))
        expect(d.overflow).toHaveBeenCalledWith('Recherchiere lange', 'Das ausführliche Ergebnis.')
        expect(d.ask).toHaveBeenCalledTimes(1)
    })

    it('default time budget stays below 26 s', async () => {
        const { DEFAULT_BUDGET_MS } = await import('./even-g2.js')
        expect(DEFAULT_BUDGET_MS).toBeLessThan(26_000)
    })

    it('not the fenced Main: 503 and no pipeline run', async () => {
        const d = deps({ fence: vi.fn(async () => { throw Object.assign(new Error('Fenced'), { code: 'FENCED' }) }) })
        const { url } = await start(d)
        expect((await ask(url, 'Hallo')).status).toBe(503)
        expect(d.ask).not.toHaveBeenCalled()
    })

    it('rejects bad bodies', async () => {
        const d = deps()
        const { url } = await start(d)
        const post = (body: string) => fetch(`${url}/`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body })
        expect((await post('kein json')).status).toBe(400)
        expect((await post(JSON.stringify({ messages: [] }))).status).toBe(400)
        expect((await post(JSON.stringify({ messages: [{ role: 'user', content: '   ' }] }))).status).toBe(400)
        expect((await post('x'.repeat(70_000))).status).toBe(413)
        expect(d.ask).not.toHaveBeenCalled()
    })
})

describe('formatForG2', () => {
    it('strips markdown, emoji and cuts at a sentence boundary', () => {
        expect(formatForG2('✅ **Fertig**: `npm test` grün.')).toBe('Fertig: npm test grün.')
        expect(formatForG2('# Titel\n\n> Zitat\n\n1. eins\n2. zwei')).toBe('Titel\n\nZitat\n\n1. eins\n2. zwei')
        const text = `${'Erster Satz ist hier. '.repeat(30)}`
        const out = formatForG2(text)
        expect(out.length).toBeLessThanOrEqual(400)
        expect(out.endsWith('.') || out.endsWith('…')).toBe(true)
        expect(formatForG2('')).toBe('Keine Antwort.')
    })
})

describe('Even G2 HUD feed', () => {
    function card(art = 'g2-test', kind = 'g2-test') {
        const result = createApprovalCard({ art, titel: 'Modell wechseln?', beleg: 'Test', vorschlag: 'Auf Modell B wechseln', aktion: { kind, ref: 'r1' } }, { dataDir })
        if (!result.ok) throw new Error(result.reason)
        return result.card
    }

    it('needs the token', async () => {
        const { url } = await start(deps())
        expect((await fetch(`${url}/hud`)).status).toBe(401)
        expect((await fetch(`${url}/hud/answer`, { method: 'POST', body: '{}' })).status).toBe(401)
    })

    it('shows the status line and open cards as short texts', async () => {
        const created = card()
        const { url } = await start(deps())
        const response = await fetch(`${url}/hud`, { headers: { Authorization: `Bearer ${TOKEN}` } })
        expect(response.status).toBe(200)
        expect(response.headers.get('access-control-allow-origin')).toBe('*')
        const body = await response.json()
        expect(body.status).toBe('Bereit')
        expect(body.cards).toHaveLength(1)
        expect(body.cards[0]).toMatchObject({ id: created.id, titel: 'Modell wechseln?', antworten: ['ja', 'nein'] })
        expect(JSON.stringify(body)).not.toContain(created.buttons[0].token)
        expect(typeof body.version).toBe('string')
    })

    it('long-poll returns when the version changes', async () => {
        const { url } = await start(deps({ pollIntervalMs: 20 }))
        const first = await (await fetch(`${url}/hud`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
        const waiting = fetch(`${url}/hud?since=${first.version}&wait=5`, { headers: { Authorization: `Bearer ${TOKEN}` } })
        await new Promise(resolve => setTimeout(resolve, 60))
        card()
        const next = await (await waiting).json()
        expect(next.version).not.toBe(first.version)
        expect(next.cards).toHaveLength(1)
    })

    it('answers preflight requests without token', async () => {
        const { url } = await start(deps())
        const response = await fetch(`${url}/hud`, { method: 'OPTIONS' })
        expect(response.status).toBe(204)
        expect(response.headers.get('access-control-allow-headers')).toMatch(/authorization/i)
    })

    it('tap = Ja: only with token, only once, through answerApprovalCard', async () => {
        const execute = vi.fn(async () => ({ ok: true, message: 'erledigt' }))
        registerCardExecutor({ kind: 'g2-test', execute })
        const created = card()
        const { url } = await start(deps())
        const answer = (body: unknown, token: string | null = TOKEN) => fetch(`${url}/hud/answer`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
        })
        expect((await answer({ cardId: created.id, answer: 'ja' }, null)).status).toBe(401)
        expect((await answer({ cardId: created.id, answer: 'ja' }, 'falsch')).status).toBe(401)
        expect(execute).not.toHaveBeenCalled()
        const ok = await answer({ cardId: created.id, answer: 'ja' })
        expect(ok.status).toBe(200)
        expect(execute).toHaveBeenCalledTimes(1)
        const again = await answer({ cardId: created.id, answer: 'ja' })
        expect(again.status).toBe(409)
        expect((await answer({ cardId: created.id, answer: 'nein' })).status).toBe(409)
        expect(execute).toHaveBeenCalledTimes(1)
        const stored = listApprovalCards({ dataDir }).find(item => item.id === created.id)!
        expect(stored.status).toBe('ja')
        expect(stored.decidedBy).toBe(`even-g2:${OWNER}`)
    })

    it('double tap = Nein rejects the card without running it', async () => {
        const execute = vi.fn(async () => ({ ok: true, message: 'erledigt' }))
        registerCardExecutor({ kind: 'g2-test', execute })
        const created = card()
        const result = await answerCardFromG2(created.id, 'nein', { ownerIds: [OWNER], dataDir, ledger: null })
        expect(result.status).toBe(200)
        expect(execute).not.toHaveBeenCalled()
        expect(listApprovalCards({ dataDir })[0].status).toBe('nein')
    })

    it('never "immer" from the glasses; physical cards offer only ja/nein', async () => {
        registerCardExecutor({ kind: 'drucken-test', impact: 'physisch', allowAlways: () => true, execute: async () => ({ ok: true, message: 'x' }) })
        const created = card('drucken-test', 'drucken-test')
        expect(created.wirkung).toBe('physisch')
        const hud = buildHudSnapshot({ status: 'x', openCards: [created] })
        expect(hud.cards[0].antworten).toEqual(['ja', 'nein'])
        expect((await answerCardFromG2(created.id, 'immer' as any, { ownerIds: [OWNER], dataDir, ledger: null })).status).toBe(400)
        expect(listApprovalCards({ dataDir })[0].status).toBe('offen')
    })

    it('without a configured owner nobody can answer', async () => {
        const created = card()
        expect((await answerCardFromG2(created.id, 'ja', { ownerIds: [], dataDir, ledger: null })).status).toBe(403)
        expect((await answerCardFromG2(created.id, 'ja', { ownerIds: ['@name'], dataDir, ledger: null })).status).toBe(403)
        expect(listApprovalCards({ dataDir })[0].status).toBe('offen')
    })

    it('a Nie-Liste action never becomes a card, so the HUD shows nothing', async () => {
        const refused = createApprovalCard({ art: 'daten-loeschen', titel: 'Backups löschen', beleg: '-', vorschlag: '-', aktion: { kind: 'daten-loeschen', ref: 'b1' } }, { dataDir })
        expect(refused.ok).toBe(false)
        const { url } = await start(deps())
        const body = await (await fetch(`${url}/hud`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
        expect(body.cards).toEqual([])
    })

    it('unknown card: 404', async () => {
        expect((await answerCardFromG2('kdeadbeef0000', 'ja', { ownerIds: [OWNER], dataDir, ledger: null })).status).toBe(404)
    })
})
