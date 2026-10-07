import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerApprovalCard, createApprovalCard, registerCardExecutor, unregisterCardExecutor } from '../core/approval-cards.js'
import { paginate } from '../core/owner-text.js'
import { BUILTIN_CONNECTORS, loadConnectorCatalog } from './connector-catalog.js'
import { completeLoginAndConnect, connectAndTest, connectFromApproval, currentRedirectBase, noteDashboardAddress, type ConnectDeps } from './connect-flow.js'
import { handlePastedLoginReturn, loginReturnInMessage } from './login-paste.js'

// 2.86 Paket N, Live-Befund 06.10. 16:29–16:31 (HA-Anmeldung über Telegram gescheitert):
// Rückkehradresse, leeres state, abgeschnittene URL, eingefügter Rückkehrlink, roher SSRF-Text.
const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-login-dau-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); noteDashboardAddress(''); unregisterCardExecutor('test-link') })

const catalog = loadConnectorCatalog(BUILTIN_CONNECTORS)
const gateway = () => ({ connected: [] as string[], async connect(r: any) { this.connected.push(r.id); return { ok: true, at: '2026-10-06T00:00:00.000Z', werkzeuge: 2, lesend: 2, fragend: 0, gesperrt: 0 } }, disconnect() {} })
const depsFor = (dir: string, extra: Partial<ConnectDeps> = {}): ConnectDeps => ({
    dataDir: dir, cardOpts: { dataDir: dir, ledger: null }, catalog, redirectBase: 'http://127.0.0.1:3011', env: {},
    gateway: gateway(), askLogin: vi.fn(), foundHomeAssistant: () => ['http://ha.example.com:8123'], ...extra,
} as any)

describe('Anmeldelink: ein Satz + URL-Knopf, state immer gesetzt', () => {
    it('die Anmeldung kommt als Knopf „Bei Home Assistant anmelden“, nicht als Text-URL', async () => {
        const result = await connectFromApproval('home-assistant', 'telegram:42', depsFor(tmp()))
        expect(result.ok).toBe(true)
        expect(result.link?.label).toBe('Bei Home Assistant anmelden')
        expect(result.message).not.toMatch(/https?:\/\//)
        expect(result.message).toContain('Der Knopf gilt eine Viertelstunde.')
        const url = new URL(result.link!.url)
        expect(url.searchParams.get('state')).toMatch(/^[a-f0-9]{48}$/)
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    })

    it('erreicht der Browser die Rückkehr nicht (nur dieser Rechner), sagt EIN Satz, was zu tun ist', async () => {
        const local = await connectFromApproval('home-assistant', 'telegram:42', depsFor(tmp()))
        expect(local.message).toContain('Wenn danach eine leere Seite kommt: kopier die Adresse oben aus dem Browser und schick sie mir hier.')
        const reachable = await connectFromApproval('home-assistant', 'telegram:42', depsFor(tmp(), { redirectBase: 'https://main.example.com' }))
        expect(reachable.message).not.toContain('leere Seite')
        expect(new URL(reachable.link!.url).searchParams.get('redirect_uri')).toBe('https://main.example.com/verbindungen/rueckkehr')
        expect(new URL(reachable.link!.url).searchParams.get('client_id')).toBe('https://main.example.com/')
    })

    it('Rückkehradresse: Einstellung, sonst die tatsächlich erreichbare Desktop-Adresse, sonst nur dieser Rechner', () => {
        expect(currentRedirectBase()).toBe('http://127.0.0.1:3011')
        noteDashboardAddress('http://127.0.0.1:3011')
        expect(currentRedirectBase()).toBe('http://127.0.0.1:3011')
        noteDashboardAddress('http://192.0.2.5:3011')
        expect(currentRedirectBase()).toBe('http://192.0.2.5:3011')
    })

    it('ein Knopf-Link wird weitergereicht, aber nie gespeichert oder ins Protokoll geschrieben', async () => {
        const dir = tmp()
        const secretish = 'https://ha.example.com/auth/authorize?state=' + 'a'.repeat(48)
        registerCardExecutor({ isStillOpen: () => true, kind: 'test-link', async execute() { return { ok: true, message: 'Ein Schritt noch.', link: { label: 'Bei Home Assistant anmelden', url: secretish } } } })
        const card = createApprovalCard({ art: 'test-link', titel: 't', beleg: 'b', vorschlag: 'v', aktion: { kind: 'test-link', ref: 'x1' } }, { dataDir: dir })
        if (!card.ok) throw new Error('card')
        const result = await answerApprovalCard(`ac:${card.card.buttons.find(b => b.answer === 'ja')!.token}`, { userId: '42', ownerIds: ['42'] }, { dataDir: dir })
        expect(result.link).toEqual({ label: 'Bei Home Assistant anmelden', url: secretish })
        const files = (d: string): string[] => readdirSync(d).flatMap(name => statSync(join(d, name)).isDirectory() ? files(join(d, name)) : [join(d, name)])
        for (const file of files(dir)) expect(readFileSync(file, 'utf8')).not.toContain('a'.repeat(48))
    })

    it('Telegram-Seiten teilen nie innerhalb einer Adresse oder eines Worts', () => {
        const url = `http://ha.example.com:8123/auth/authorize?response_type=code&client_id=x&state=${'b'.repeat(48)}&code_challenge=${'c'.repeat(43)}&code_challenge_method=S256`
        const text = `${'Wort '.repeat(100)}${url} ende`
        const pages = paginate(text)
        expect(pages.some(page => page.includes(url))).toBe(true)
        for (const page of pages) expect(page.length <= 600 || page.trim() === url).toBe(true)
        expect(pages.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' ').trim())
        const longUrl = `https://ha.example.com/${'p'.repeat(700)}`
        expect(paginate(`Bitte: ${longUrl}`)).toEqual(['Bitte:', longUrl])
    })
})

describe('eingefügter Rückkehrlink schließt die Anmeldung ab', () => {
    it('erkennt nur echte Rückkehradressen', () => {
        const state = 'd'.repeat(48)
        expect(loginReturnInMessage(`hier: http://127.0.0.1:3011/verbindungen/rueckkehr?state=${state}&code=abc123.`)).toBe(`http://127.0.0.1:3011/verbindungen/rueckkehr?state=${state}&code=abc123`)
        expect(loginReturnInMessage('http://127.0.0.1:3011/verbindungen/rueckkehr?state=&code=abc')).toBeNull()
        expect(loginReturnInMessage('http://example.com/andere?state=' + state + '&code=x')).toBeNull()
        expect(loginReturnInMessage('Wie geht die Rückkehr?')).toBeNull()
    })

    it('mit passendem state verbunden; die Antwort enthält weder Code noch Adresse', async () => {
        const dir = tmp()
        const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: 'fixture', refresh_token: 'fixture', token_type: 'Bearer', expires_in: 3600 }), { status: 200 }))
        const deps = depsFor(dir, { fetchFn } as any)
        const started = await connectFromApproval('home-assistant', 'telegram:42', deps)
        const state = new URL(started.link!.url).searchParams.get('state')!
        const pasted = `http://127.0.0.1:3011/verbindungen/rueckkehr?state=${state}&code=geheimer-code-123`
        const reply = await handlePastedLoginReturn(loginReturnInMessage(pasted)!, { complete: address => completeLoginAndConnect({ address }, deps) })
        expect(reply).toMatch(/^✅ Angemeldet\./)
        expect(reply).not.toContain('geheimer-code-123')
        expect(reply).not.toMatch(/https?:\/\//)
        const again = await handlePastedLoginReturn(loginReturnInMessage(pasted)!, { complete: address => completeLoginAndConnect({ address }, deps) })
        expect(again).toContain('Diese Anmeldung konnte ich nicht abschließen')
    })

    it('die Pipeline fängt den Link vor Protokoll, Sitzung und Modell ab', () => {
        const source = readFileSync(fileURLToPath(new URL('../core/message-pipeline.ts', import.meta.url)), 'utf8')
        const intercept = source.indexOf('loginReturnInMessage(content)')
        expect(intercept).toBeGreaterThan(0)
        expect(intercept).toBeLessThan(source.indexOf("logSession(canonicalUser, channel, 'user', content)"))
        expect(intercept).toBeLessThan(source.indexOf('Nachricht von ${canonicalUser}'))
    })
})

describe('roher Sicherheitstext landet nie beim Owner', () => {
    it('SSRF-Sperre → Alltagssatz', async () => {
        const dir = tmp()
        const deps = depsFor(dir, { gateway: { async connect() { throw new Error('SSRF Request blocked: 127.0.0.1 is a private address') }, disconnect() {} } } as any)
        const started = await connectFromApproval('home-assistant', 'telegram:42', deps)
        expect(started.ok).toBe(true)
        const result = await connectAndTest('c-home-assistant', deps)
        expect(result.message).toBe('Home Assistant ist von hier aus gerade nicht erreichbar. Ich habe nichts verändert.')
        expect(result.message).not.toMatch(/SSRF|127\.0\.0\.1/)
    })
})
