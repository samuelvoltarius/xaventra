import type { Express, Request, Response } from 'express'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveConfigPath } from '../config/config-path.js'
import { getRuntimeRoot } from '../core/data-root.js'
import { summarizeConnections } from './connections-port.js'
import { setEnvFileValues } from './env-file.js'
import { readOnboardingState, updateOnboardingState, type OnboardingState } from './first-start.js'
import { issueTelegramPairing, telegramPairingLink, telegramPairingStatus } from './telegram-pairing.js'

// ============================================================================
// 2.85 Paket B, Punkt 3 — Erster Start in der Desktop-App, höchstens 3 Fragen:
//   1. Wie heißt du?  2. Telegram koppeln (Link/QR)  3. Gefundene Dienste
//   verbinden → nur Verweis auf die Ansicht "Verbindungen" (Paket A).
// Alles hinter dem Desktop-Owner-Token. Einzige Ausnahme: die einmalige
// Übernahme dieses Tokens durch die lokale Desktop-App (claim), siehe unten.
// ============================================================================

/** The local Desktop app can take over the owner token within this window after seeding. */
export const CLAIM_WINDOW_MS = 24 * 60 * 60_000
const TELEGRAM_TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,80}$/
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,59}$/u

export interface OnboardingApiDeps {
    root?: () => string
    now?: () => number
    /** Telegram Bot API getMe (network). Only the bot's public username is returned. */
    telegramGetMe?: (token: string) => Promise<{ username: string }>
    telegramRunning?: () => boolean
    rememberName?: (name: string) => Promise<void> | void
    runDoctor?: () => Promise<unknown>
    qrDataUrl?: (text: string) => Promise<string>
}

const send = (res: Response, status: number, body: unknown) => { res.setHeader('Cache-Control', 'no-store'); res.status(status).json(body) }

/** Claimable = first start pending, token never handed out, inside the window, owner token configured. */
export function isOwnerTokenClaimable(state: OnboardingState | null, now = Date.now(), env: Record<string, string | undefined> = process.env): boolean {
    if (!state || state.state !== 'pending' || state.claimedAt || !env.NOVA_DESKTOP_API_TOKEN) return false
    const seeded = Date.parse(state.seededAt)
    return Number.isFinite(seeded) && now - seeded >= 0 && now - seeded <= CLAIM_WINDOW_MS
}

/** Small part of /api/desktop/bootstrap: lets the app open the first-start page. */
export function onboardingBootstrap(root = getRuntimeRoot()): { pending: boolean } | null {
    const state = readOnboardingState(root)
    return state ? { pending: state.state === 'pending' } : null
}

/**
 * Registered BEFORE the Desktop auth middleware. A fresh install has a random
 * owner token in its new .env, but the Desktop app on the same computer cannot
 * know it. It may take it over exactly once, only as a direct loopback client
 * (no proxy, no browser cross-site, no DNS rebinding — same check as tokenless
 * Desktop mode), only while the first start is pending and within 24 h.
 * Any process of the same OS user could read the .env anyway; the claim adds no
 * access a local user did not have. The Electron main process stores the token
 * encrypted (safeStorage); the renderer never sees it.
 */
export function registerOnboardingClaim(app: Express, options: { isDirectLoopbackClient: (req: Request) => boolean; deps?: OnboardingApiDeps }): void {
    const root = options.deps?.root ?? getRuntimeRoot
    const now = options.deps?.now ?? Date.now
    app.post('/api/desktop/onboarding/claim', (req, res) => {
        const state = readOnboardingState(root())
        if (!options.isDirectLoopbackClient(req) || !isOwnerTokenClaimable(state, now())) {
            return send(res, 403, { error: 'Übernahme nicht möglich. Trage das Desktop-Token in den Einstellungen ein.' })
        }
        // Mark first: a second request (or a crash) never hands the token out again.
        updateOnboardingState({ claimedAt: new Date(now()).toISOString() }, root())
        send(res, 200, { token: process.env.NOVA_DESKTOP_API_TOKEN })
    })
}

function readConfig(root: string): any {
    try { return JSON.parse(readFileSync(resolveConfigPath(root), 'utf8')) } catch { return {} }
}
function writeConfigAtomic(root: string, config: any): void {
    const path = resolveConfigPath(root)
    let mode = 0o600
    try { mode = statSync(path).mode & 0o777 } catch { /* new */ }
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode })
    renameSync(tmp, path)
}

async function defaultGetMe(token: string): Promise<{ username: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
        const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal })
        const body: any = await response.json().catch(() => null)
        if (!response.ok || body?.ok !== true || typeof body?.result?.username !== 'string') throw new Error('Telegram kennt dieses Token nicht.')
        return { username: body.result.username }
    } catch (error) {
        // Never leak the token through an error message (fetch errors can include the URL).
        throw new Error(String((error as any)?.message || error).includes(token) ? 'Telegram nicht erreichbar.' : String((error as any)?.message || 'Telegram nicht erreichbar.'))
    } finally { clearTimeout(timer) }
}

function telegramConfigured(root: string): boolean {
    const config = readConfig(root)
    return Boolean(process.env.TELEGRAM_BOT_TOKEN || config.channels?.telegram?.token)
}

/** Owner-only routes (registered after the Desktop auth middleware). */
export function registerOnboardingRoutes(app: Express, options: { ownerOnly: (req: Request, res: Response) => boolean; deps?: OnboardingApiDeps }): void {
    const deps = options.deps || {}
    const root = deps.root ?? getRuntimeRoot
    const now = deps.now ?? Date.now
    const ownerOnly = options.ownerOnly

    app.get('/api/desktop/onboarding', async (req, res) => {
        if (!ownerOnly(req, res)) return
        const state = readOnboardingState(root())
        const config = readConfig(root())
        const allowFrom = Array.isArray(config.channels?.telegram?.allowFrom) ? config.channels.telegram.allowFrom.filter(Boolean) : []
        const pairing = telegramPairingStatus(root(), now())
        const connections = await summarizeConnections()
        const running = (() => { try { return deps.telegramRunning?.() ?? false } catch { return false } })()
        send(res, 200, {
            firstStart: state?.state === 'pending',
            state: state?.state ?? null,
            ownerName: state?.ownerName ?? null,
            doctor: { running: state?.doctorRunning === true, report: state?.doctor ?? null },
            telegram: {
                configured: telegramConfigured(root()), running, botUsername: state?.telegram?.botUsername ?? null,
                paired: allowFrom.length > 0, pairedWith: state?.telegram?.pairedWith ?? (allowFrom.length ? 'verbunden' : null),
                pairingPending: pairing.pending, pairingExpiresAt: pairing.pending ? pairing.expiresAt : null,
                restartNeeded: Boolean(state?.telegram?.botUsername) && !running,
            },
            connections,
            // Never more than three questions.
            questions: [
                { id: 'name', done: Boolean(state?.ownerName) },
                { id: 'telegram', done: allowFrom.length > 0 },
                { id: 'verbindungen', done: connections.available && connections.gefunden === 0, available: connections.available },
            ],
        })
    })

    app.post('/api/desktop/onboarding/name', async (req, res) => {
        if (!ownerOnly(req, res)) return
        const name = String(req.body?.name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
        if (!NAME.test(name)) return send(res, 400, { error: 'Bitte nur einen Namen (Buchstaben, höchstens 60 Zeichen).' })
        const state = updateOnboardingState({ ownerName: name }, root())
        if (!state) return send(res, 409, { error: 'Kein Erster Start aktiv.' })
        try {
            if (deps.rememberName) await deps.rememberName(name)
            else {
                const { addFact } = await import('../layers/L6-core-facts.js')
                addFact({ category: 'identity', fact: `Der Owner heißt ${name}.`, source: 'manual', confidence: 1, updatedAt: new Date(now()).toISOString() })
            }
        } catch { /* the name is stored in the first-start marker either way */ }
        send(res, 200, { ownerName: name })
    })

    app.post('/api/desktop/onboarding/doctor', async (req, res) => {
        if (!ownerOnly(req, res)) return
        if (!readOnboardingState(root())) return send(res, 409, { error: 'Kein Erster Start aktiv.' })
        const run = deps.runDoctor ?? (async () => (await import('./first-start-doctor.js')).runAndStoreFirstStartDoctor(undefined, root()))
        void Promise.resolve().then(run).catch(error => console.warn(`[Erster Start] Doctor-Lauf gescheitert: ${error}`))
        send(res, 202, { started: true })
    })

    // Bot token from BotFather: pasted once, checked with getMe, stored in .env (0600), never shown again.
    app.post('/api/desktop/onboarding/telegram/token', async (req, res) => {
        if (!ownerOnly(req, res)) return
        const token = String(req.body?.token ?? '').trim()
        if (!TELEGRAM_TOKEN.test(token)) return send(res, 400, { error: 'Das sieht nicht wie ein Bot-Token von @BotFather aus.' })
        if (!readOnboardingState(root())) return send(res, 409, { error: 'Kein Erster Start aktiv. Telegram wird in den Einstellungen eingerichtet.' })
        let username: string
        try { ({ username } = await (deps.telegramGetMe ?? defaultGetMe)(token)) }
        catch (error) {
            const message = String((error as any)?.message || 'Prüfung fehlgeschlagen.')
            return send(res, 400, { error: message.includes(token) ? 'Prüfung fehlgeschlagen.' : message })
        }
        if (!/^[A-Za-z0-9_]{5,64}$/.test(username)) return send(res, 400, { error: 'Telegram hat keinen gültigen Bot-Namen geliefert.' })
        setEnvFileValues(join(root(), '.env'), { TELEGRAM_BOT_TOKEN: token, NOVA_NO_TELEGRAM: 'false', NOVA_TELEGRAM_MODE: 'primary' })
        const config = readConfig(root())
        config.channels ||= {}
        config.channels.telegram = { ...(config.channels.telegram || {}), enabled: true }
        if (existsSync(resolveConfigPath(root()))) writeConfigAtomic(root(), config)
        updateOnboardingState(current => ({ telegram: { ...(current.telegram || {}), botUsername: username } }), root())
        send(res, 200, { ok: true, botUsername: username, restartNeeded: !(deps.telegramRunning?.() ?? false) })
    })

    app.post('/api/desktop/onboarding/telegram/pair', async (req, res) => {
        if (!ownerOnly(req, res)) return
        const state = readOnboardingState(root())
        let username = state?.telegram?.botUsername || ''
        if (!username) {
            const token = process.env.TELEGRAM_BOT_TOKEN || readConfig(root()).channels?.telegram?.token || ''
            if (!token) return send(res, 409, { error: 'Zuerst einen Telegram-Bot anlegen und sein Token einfügen.' })
            try { ({ username } = await (deps.telegramGetMe ?? defaultGetMe)(token)) } catch { return send(res, 502, { error: 'Telegram nicht erreichbar.' }) }
        }
        try {
            const { code, expiresAt } = issueTelegramPairing({ root: root(), now: now() })
            const link = telegramPairingLink(username, code)
            let qr: string | null = null
            try {
                qr = deps.qrDataUrl ? await deps.qrDataUrl(link) : await (await import('qrcode')).default.toDataURL(link, { margin: 1, width: 240 })
            } catch { qr = null }
            send(res, 200, { link, qr, expiresAt, botUsername: username })
        } catch (error) {
            send(res, 409, { error: String((error as any)?.message || error).slice(0, 300) })
        }
    })

    app.post('/api/desktop/onboarding/done', (req, res) => {
        if (!ownerOnly(req, res)) return
        const state = updateOnboardingState({ state: 'done', completedAt: new Date(now()).toISOString() }, root())
        if (!state) return send(res, 409, { error: 'Kein Erster Start aktiv.' })
        send(res, 200, { state: state.state })
    })
}
