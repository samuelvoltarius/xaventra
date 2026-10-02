import express from 'express'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopApi } from '../desktop/desktop-api.js'
import { registerConnectionsProvider } from './connections-port.js'
import { setEnvFileValues } from './env-file.js'
import { ensureFirstStartConfig, readOnboardingState, updateOnboardingState } from './first-start.js'
import { CLAIM_WINDOW_MS, registerOnboardingClaim, registerOnboardingRoutes, type OnboardingApiDeps } from './onboarding-api.js'
import { claimTelegramPairing } from './telegram-pairing.js'

vi.mock('../synthesis/self-evolution.js', () => ({ getPatchProposals: () => [], approveEvolutionProposal: vi.fn() }))

const OWNER = ['first-start-', 'owner-token-0123456789'].join('')
const BOT = ['123456789', ':', 'AAexampleexampleexampleexampleexample01'].join('')

afterEach(() => { vi.unstubAllEnvs(); registerConnectionsProvider(null) })

async function freshInstall(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'xaventra-onboarding-api-'))
    await ensureFirstStartConfig({ root, env: {} })
    return root
}

async function serve(app: express.Express, run: (port: number) => Promise<void>) {
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try { await run((server.address() as AddressInfo).port) } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; text: string; json: any }> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body)
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
            const chunks: Buffer[] = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json: any = null; try { json = JSON.parse(text) } catch { /* text */ } resolve({ status: res.statusCode || 0, text, json }) })
        })
        req.once('error', reject); if (payload) req.write(payload); req.end()
    })
}

/** Standalone app with the onboarding routes and a fake owner check (header). */
function onboardingApp(root: string, deps: Partial<OnboardingApiDeps> = {}) {
    const app = express(); app.use(express.json())
    const full: OnboardingApiDeps = { root: () => root, rememberName: () => undefined, qrDataUrl: async () => 'data:image/png;base64,AAAA', ...deps }
    registerOnboardingClaim(app, { isDirectLoopbackClient: req => String(req.headers.host || '').startsWith('127.0.0.1'), deps: full })
    registerOnboardingRoutes(app, { ownerOnly: (req, res) => req.headers['x-test-owner'] === '1' || (res.status(403).json({ error: 'Owner authorization required' }), false), deps: full })
    return app
}
const owner = { 'x-test-owner': '1' }

describe('Desktop-App übernimmt beim Ersten Start das Owner-Token einmal (2.85 Paket B, Punkt 3)', () => {
    it('hands the token once to a direct loopback client of a fresh install, through the real Desktop API', async () => {
        const root = await freshInstall()
        vi.stubEnv('NOVA_RUNTIME_ROOT', root)
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', OWNER)
        const app = express(); app.use(express.json()); registerDesktopApi(app, () => null)
        await serve(app, async port => {
            expect((await call(port, 'GET', '/api/desktop/onboarding')).status).toBe(401)
            const claimed = await call(port, 'POST', '/api/desktop/onboarding/claim')
            expect(claimed.status).toBe(200)
            expect(claimed.json.token).toBe(OWNER)
            expect((await call(port, 'POST', '/api/desktop/onboarding/claim')).status).toBe(403)
            const auth = { authorization: `Bearer ${claimed.json.token}` }
            const summary = await call(port, 'GET', '/api/desktop/onboarding', auth)
            expect(summary.status).toBe(200)
            expect(summary.json).toMatchObject({ firstStart: true, questions: [{ id: 'name' }, { id: 'telegram' }, { id: 'verbindungen' }] })
            expect(summary.json.questions).toHaveLength(3)
            const boot = await call(port, 'GET', '/api/desktop/bootstrap', auth)
            expect(boot.json.onboarding).toEqual({ pending: true })
        })
        expect(readOnboardingState(root)?.claimedAt).toBeTruthy()
    })

    it('refuses the claim for proxies/rebinding hosts, finished or old first starts and existing installations', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', OWNER)
        const root = await freshInstall()
        await serve(onboardingApp(root), async port => {
            expect((await call(port, 'POST', '/api/desktop/onboarding/claim', { host: 'example.com' })).status).toBe(403)
        })
        updateOnboardingState({ seededAt: new Date(Date.now() - CLAIM_WINDOW_MS - 1000).toISOString() }, root)
        await serve(onboardingApp(root), async port => { expect((await call(port, 'POST', '/api/desktop/onboarding/claim')).status).toBe(403) })
        const done = await freshInstall(); updateOnboardingState({ state: 'done' }, done)
        await serve(onboardingApp(done), async port => { expect((await call(port, 'POST', '/api/desktop/onboarding/claim')).status).toBe(403) })
        const existing = mkdtempSync(join(tmpdir(), 'xaventra-onboarding-existing-'))
        writeFileSync(join(existing, 'nova.config.json'), '{"provider":"openai"}')
        await serve(onboardingApp(existing), async port => { expect((await call(port, 'POST', '/api/desktop/onboarding/claim')).status).toBe(403) })
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        const noToken = await freshInstall()
        await serve(onboardingApp(noToken), async port => { expect((await call(port, 'POST', '/api/desktop/onboarding/claim')).status).toBe(403) })
    })
})

describe('Höchstens drei Fragen (2.85 Paket B, Punkt 3)', () => {
    it('every question route is owner-only', async () => {
        const root = await freshInstall()
        await serve(onboardingApp(root), async port => {
            for (const [method, path] of [['GET', '/api/desktop/onboarding'], ['POST', '/api/desktop/onboarding/name'], ['POST', '/api/desktop/onboarding/telegram/token'],
                ['POST', '/api/desktop/onboarding/telegram/pair'], ['POST', '/api/desktop/onboarding/doctor'], ['POST', '/api/desktop/onboarding/done']]) {
                expect((await call(port, method, path, {}, method === 'GET' ? undefined : {})).status).toBe(403)
            }
        })
    })

    it('1. remembers the name (validated) as an owner fact', async () => {
        const root = await freshInstall()
        const remembered: string[] = []
        await serve(onboardingApp(root, { rememberName: name => { remembered.push(name) } }), async port => {
            expect((await call(port, 'POST', '/api/desktop/onboarding/name', owner, { name: '<script>' })).status).toBe(400)
            expect((await call(port, 'POST', '/api/desktop/onboarding/name', owner, { name: '  Alex   Beispiel ' })).json).toEqual({ ownerName: 'Alex Beispiel' })
        })
        expect(remembered).toEqual(['Alex Beispiel'])
        expect(readOnboardingState(root)?.ownerName).toBe('Alex Beispiel')
    })

    it('2. Telegram: the pasted bot token is checked, stored only in .env and never shown again; pairing returns link + QR', async () => {
        const root = await freshInstall()
        const getMe = vi.fn(async (token: string) => { if (token !== BOT) throw new Error('unbekannt'); return { username: 'example_bot' } })
        await serve(onboardingApp(root, { telegramGetMe: getMe }), async port => {
            expect((await call(port, 'POST', '/api/desktop/onboarding/telegram/pair', owner)).status).toBe(409)
            expect((await call(port, 'POST', '/api/desktop/onboarding/telegram/token', owner, { token: 'nope' })).status).toBe(400)
            const saved = await call(port, 'POST', '/api/desktop/onboarding/telegram/token', owner, { token: BOT })
            expect(saved.json).toEqual({ ok: true, botUsername: 'example_bot', restartNeeded: true })
            expect(saved.text).not.toContain(BOT)
            const summary = await call(port, 'GET', '/api/desktop/onboarding', owner)
            expect(summary.text).not.toContain(BOT)
            expect(summary.json.telegram).toMatchObject({ botUsername: 'example_bot', paired: false, restartNeeded: true })
            const pair = await call(port, 'POST', '/api/desktop/onboarding/telegram/pair', owner)
            expect(pair.json.link).toMatch(/^https:\/\/t\.me\/example_bot\?start=[A-Za-z0-9_-]{24}$/)
            expect(pair.json.qr).toBe('data:image/png;base64,AAAA')
            const code = pair.json.link.split('start=')[1]
            expect(claimTelegramPairing(`/start ${code}`, { id: '424242', username: 'example' }, { root })).toMatchObject({ ok: true })
            const after = await call(port, 'GET', '/api/desktop/onboarding', owner)
            expect(after.json.telegram).toMatchObject({ paired: true, pairedWith: '@example' })
            expect(after.json.questions[1]).toEqual({ id: 'telegram', done: true })
        })
        const env = readFileSync(join(root, '.env'), 'utf8')
        expect(env).toContain(`TELEGRAM_BOT_TOKEN=${BOT}`)
        expect(env).toMatch(/^NOVA_NO_TELEGRAM=false$/m)
        expect(env).toMatch(/^NOVA_DESKTOP_API_TOKEN=[a-f0-9]{64}$/m)
        const config = readFileSync(join(root, 'xaventra.config.json'), 'utf8')
        expect(config).not.toContain(BOT)
        expect(JSON.parse(config).channels.telegram).toMatchObject({ enabled: true, allowFrom: ['424242'] })
    })

    it('3. found services only point to the "Verbindungen" view of Paket A (stub until it is merged)', async () => {
        const root = await freshInstall()
        await serve(onboardingApp(root), async port => {
            const before = await call(port, 'GET', '/api/desktop/onboarding', owner)
            expect(before.json.connections).toEqual({ available: false, gefunden: 0, verbunden: 0, beispiele: [], view: 'verbindungen' })
            registerConnectionsProvider(() => [
                { id: 'home-assistant', title: 'Home Assistant', status: 'gefunden' },
                { id: 'example-mail', title: 'Mail', status: 'moeglich' },
            ])
            const after = await call(port, 'GET', '/api/desktop/onboarding', owner)
            expect(after.json.connections).toEqual({ available: true, gefunden: 1, verbunden: 0, beispiele: ['Home Assistant'], view: 'verbindungen' })
        })
    })

    it('finishing ends first-start mode for good', async () => {
        const root = await freshInstall()
        await serve(onboardingApp(root), async port => {
            expect((await call(port, 'POST', '/api/desktop/onboarding/done', owner)).json).toEqual({ state: 'done' })
        })
        expect((await ensureFirstStartConfig({ root, env: {} })).firstStart).toBe(false)
    })
})

describe('.env updates stay line-safe', () => {
    it('replaces, de-duplicates and appends without touching other lines', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'xaventra-env-')), '.env')
        writeFileSync(path, '# comment\nA=1\nNOVA_NO_TELEGRAM=true\nB=2\nNOVA_NO_TELEGRAM=true\n')
        setEnvFileValues(path, { NOVA_NO_TELEGRAM: 'false', NEW_KEY: 'x' })
        expect(readFileSync(path, 'utf8')).toBe('# comment\nA=1\nNOVA_NO_TELEGRAM=false\nB=2\nNEW_KEY=x\n')
        expect(() => setEnvFileValues(path, { A: 'x\nEVIL=1' })).toThrow()
        expect(() => setEnvFileValues(path, { 'bad key': 'x' })).toThrow()
    })
})
