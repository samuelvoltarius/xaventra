/**
 * /desktop – Direktverbindung: picker buttons, one-time links, sessions, audit.
 *
 * Rules (fixed in code):
 * - Picker buttons follow the Knopf-Karten mechanism (approval-cards.ts):
 *   `callback_data` is `dk:<16 hex>` without parameters, the press is
 *   resolved from the server-side store, only a numeric owner id from
 *   `allowFrom` (same `isCardOwner` check) may press, the first accepted press
 *   consumes every button of that picker.
 * - A link token is 32 random bytes (base64url). Only its SHA-256 is stored.
 *   It is bound to desktop + mode + owner, valid for at most 10 minutes and
 *   redeemable exactly once; lookups compare hashes in constant time.
 * - Redeeming creates a session id (same strength, also only hashed) that the
 *   page uses for exactly one WebSocket within 60 s. The session ends on
 *   disconnect, "Zurückgeben", or `sessionMaxMs`.
 * - Everything is in memory: a daemon restart invalidates every link.
 * - Audit lines (`.nova-data/desktop-sessions.jsonl`) carry who, desktop,
 *   mode, start/end, source IP — never a token, session id or password.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isCardOwner } from '../core/approval-cards.js'
import { getNovaDataDir } from '../core/data-root.js'
import type { DesktopDirectConfig, DesktopMode, DirectDesktop } from './config.js'
import { holdAgentDesktopInput } from './pause.js'

export const DESKTOP_CALLBACK_PREFIX = 'dk:'
const BUTTON_TOKEN = /^[a-f0-9]{16}$/
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/
export const CONNECT_WINDOW_MS = 60_000
const PICKER_TTL_MS = 10 * 60_000
const MAX_PICKERS = 50
const MAX_LINKS = 50

export const MODE_TEXT: Record<DesktopMode, string> = { view: 'Ansehen', control: 'Übernehmen' }
const AUDIT_MODE: Record<DesktopMode, string> = { view: 'ansehen', control: 'uebernehmen' }

export interface DesktopStoreOptions {
    now?: () => number
    /** Directory for desktop-sessions.jsonl (default `.nova-data`). */
    dataDir?: string
}

interface PickerButton { token: string; action: 'open' | 'release'; desktopId: string; mode: DesktopMode; linkHash?: Buffer }
interface Picker { id: string; ownerId: string; expiresAt: number; buttons: PickerButton[]; used: boolean }
interface LinkRecord { hash: Buffer; desktopId: string; mode: DesktopMode; ownerId: string; expiresAt: number; redeemed: boolean; revoked: boolean; auditId?: string }
export interface DesktopSession {
    auditId: string
    hash: Buffer
    desktop: DirectDesktop
    mode: DesktopMode
    ownerId: string
    sourceIp: string
    startedAt: number
    connectBy: number
    claimed: boolean
    ended: boolean
    release?: () => void
    closer?: (reason: string) => void
}

export type PressCode = 'link' | 'released' | 'kein-owner' | 'unbekannt' | 'verbraucht' | 'abgelaufen' | 'aus'
export interface PressResult {
    ok: boolean
    code: PressCode
    message: string
    link?: { url: string; desktop: DirectDesktop; mode: DesktopMode; expiresAt: number; releaseKeyboard?: Array<Array<{ text: string; callback_data: string }>> }
}

export type RedeemCode = 'ok' | 'unbekannt' | 'verbraucht' | 'abgelaufen'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest()
const newButtonToken = () => randomBytes(8).toString('hex')
const newSecret = () => randomBytes(32).toString('base64url')
const iso = (ms: number) => new Date(ms).toISOString()

export function auditFile(opts: DesktopStoreOptions = {}): string {
    return opts.dataDir ? join(opts.dataDir, 'desktop-sessions.jsonl') : getNovaDataDir('desktop-sessions.jsonl')
}

const cleanIp = (ip: string) => String(ip || '').replace(/[^0-9a-fA-F:.]/g, '').slice(0, 64) || '-'

export class DesktopDirectStore {
    private pickers: Picker[] = []
    private links: LinkRecord[] = []
    private sessions: DesktopSession[] = []

    constructor(readonly config: DesktopDirectConfig, private readonly opts: DesktopStoreOptions = {}) {}

    private now(): number { return (this.opts.now || Date.now)() }

    audit(event: string, fields: Record<string, unknown>): void {
        try {
            const file = auditFile(this.opts)
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
            appendFileSync(file, `${JSON.stringify({ at: iso(this.now()), event, ...fields })}\n`, { mode: 0o600 })
        } catch (error) {
            console.warn(`[Desktop-Direkt] Audit nicht schreibbar: ${String((error as Error)?.message || error).slice(0, 120)}`)
        }
    }

    desktop(id: string): DirectDesktop | undefined {
        return this.config.desktops.find(desktop => desktop.id === id)
    }

    // -----------------------------------------------------------------------
    // picker (Telegram buttons)
    // -----------------------------------------------------------------------

    createPicker(ownerId: string): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
        this.sweep()
        const buttons: PickerButton[] = []
        const keyboard: Array<Array<{ text: string; callback_data: string }>> = []
        for (const desktop of this.config.desktops) {
            const row: Array<{ text: string; callback_data: string }> = []
            for (const mode of (desktop.allowControl ? ['view', 'control'] : ['view']) as DesktopMode[]) {
                const token = newButtonToken()
                buttons.push({ token, action: 'open', desktopId: desktop.id, mode })
                row.push({ text: `${mode === 'view' ? '👁' : '🖱'} ${desktop.label} – ${MODE_TEXT[mode]}`, callback_data: `${DESKTOP_CALLBACK_PREFIX}${token}` })
            }
            keyboard.push(row)
        }
        this.pickers.push({ id: newButtonToken(), ownerId, expiresAt: this.now() + PICKER_TTL_MS, buttons, used: false })
        if (this.pickers.length > MAX_PICKERS) this.pickers = this.pickers.slice(-MAX_PICKERS)
        const lines = ['🖥 Desktops — Direktverbindung', '']
        for (const desktop of this.config.desktops) lines.push(`• ${desktop.label} (${desktop.id})${desktop.allowControl ? '' : ' — nur Ansehen'}${desktop.agentInput ? ' — Übernehmen pausiert Xaventras Eingaben' : ''}`)
        lines.push('', `Knopf → Einmal-Link (${Math.round(this.config.linkTtlMs / 60_000)} min, nur Tailnet, ohne Passwort).`)
        return { text: lines.join('\n'), keyboard }
    }

    press(callbackData: string, presser: { userId: string; ownerIds: readonly string[] }): PressResult {
        if (!this.config.enabled) return { ok: false, code: 'aus', message: 'Desktop-Direktverbindung ist aus.' }
        const data = String(callbackData ?? '')
        const token = data.startsWith(DESKTOP_CALLBACK_PREFIX) ? data.slice(DESKTOP_CALLBACK_PREFIX.length) : ''
        if (!BUTTON_TOKEN.test(token)) return { ok: false, code: 'unbekannt', message: 'Unbekannter Knopf.' }
        if (!isCardOwner(presser?.userId, presser?.ownerIds || [])) return { ok: false, code: 'kein-owner', message: '🔒 Nur der Owner kann Desktops öffnen.' }
        const picker = this.pickers.find(item => item.buttons.some(button => button.token === token))
        if (!picker) return { ok: false, code: 'unbekannt', message: 'Unbekannter oder abgelaufener Knopf — /desktop neu aufrufen.' }
        if (picker.used) return { ok: false, code: 'verbraucht', message: 'Dieser Knopf wurde bereits benutzt — /desktop neu aufrufen.' }
        // Consume first (no await in between): a second press can never pass.
        picker.used = true
        if (this.now() > picker.expiresAt) return { ok: false, code: 'abgelaufen', message: 'Auswahl abgelaufen — /desktop neu aufrufen.' }
        const button = picker.buttons.find(item => item.token === token)!
        if (button.action === 'release') {
            const ended = this.releaseByLinkHash(button.linkHash!)
            return { ok: true, code: 'released', message: ended ? '↩️ Zurückgegeben — Xaventra darf den Desktop wieder bedienen.' : 'Keine laufende Übernahme mehr.' }
        }
        const desktop = this.desktop(button.desktopId)
        if (!desktop || (button.mode === 'control' && !desktop.allowControl)) return { ok: false, code: 'unbekannt', message: 'Desktop nicht mehr konfiguriert.' }
        const ownerId = String(presser.userId).trim()
        const issued = this.issueLink(desktop, button.mode, ownerId)
        let releaseKeyboard: PressResult['link']['releaseKeyboard']
        if (button.mode === 'control') {
            const releaseToken = newButtonToken()
            this.pickers.push({
                id: newButtonToken(), ownerId, expiresAt: issued.expiresAt + this.config.sessionMaxMs, used: false,
                buttons: [{ token: releaseToken, action: 'release', desktopId: desktop.id, mode: 'control', linkHash: issued.hash }],
            })
            releaseKeyboard = [[{ text: '↩️ Zurückgeben', callback_data: `${DESKTOP_CALLBACK_PREFIX}${releaseToken}` }]]
        }
        return {
            ok: true, code: 'link', message: `Einmal-Link für ${desktop.label} (${MODE_TEXT[button.mode]}) erstellt.`,
            link: { url: issued.url, desktop, mode: button.mode, expiresAt: issued.expiresAt, ...(releaseKeyboard ? { releaseKeyboard } : {}) },
        }
    }

    // -----------------------------------------------------------------------
    // links
    // -----------------------------------------------------------------------

    issueLink(desktop: DirectDesktop, mode: DesktopMode, ownerId: string): { url: string; expiresAt: number; hash: Buffer } {
        this.sweep()
        const token = newSecret()
        const hash = sha256(token)
        const expiresAt = this.now() + this.config.linkTtlMs
        this.links.push({ hash, desktopId: desktop.id, mode, ownerId, expiresAt, redeemed: false, revoked: false })
        if (this.links.length > MAX_LINKS) this.links = this.links.slice(-MAX_LINKS)
        this.audit('link-ausgegeben', { by: `telegram:${ownerId}`, desktop: desktop.id, mode: AUDIT_MODE[mode], expiresAt: iso(expiresAt) })
        return { url: `${this.config.publicBaseUrl}/desktop/s/${token}`, expiresAt, hash }
    }

    /** Constant-time lookup over every stored hash; never short-circuits on a match. */
    private findLink(token: string): LinkRecord | undefined {
        const candidate = sha256(LINK_TOKEN.test(token) ? token : `invalid:${token}`)
        let found: LinkRecord | undefined
        for (const link of this.links) if (timingSafeEqual(link.hash, candidate) && !found) found = link
        return LINK_TOKEN.test(token) ? found : undefined
    }

    /** GET: tells whether a link would be accepted, without consuming it. */
    checkLink(token: string): RedeemCode {
        const link = this.findLink(token)
        if (!link || link.revoked) return 'unbekannt'
        if (link.redeemed) return 'verbraucht'
        if (this.now() > link.expiresAt) return 'abgelaufen'
        return 'ok'
    }

    /** POST: consume the link and open a session. */
    redeemLink(token: string, sourceIp: string): { code: RedeemCode; sessionId?: string; session?: DesktopSession } {
        const link = this.findLink(token)
        const code = !link || link.revoked ? 'unbekannt' : link.redeemed ? 'verbraucht' : this.now() > link.expiresAt ? 'abgelaufen' : 'ok'
        if (code !== 'ok' || !link) {
            this.audit('link-abgelehnt', { reason: code, sourceIp: cleanIp(sourceIp), ...(link ? { desktop: link.desktopId, mode: AUDIT_MODE[link.mode] } : {}) })
            return { code }
        }
        link.redeemed = true
        const desktop = this.desktop(link.desktopId)
        if (!desktop) return { code: 'unbekannt' }
        const sessionId = newSecret()
        const now = this.now()
        const session: DesktopSession = {
            auditId: randomBytes(6).toString('hex'), hash: sha256(sessionId), desktop, mode: link.mode, ownerId: link.ownerId,
            sourceIp: cleanIp(sourceIp), startedAt: now, connectBy: now + CONNECT_WINDOW_MS, claimed: false, ended: false,
        }
        link.auditId = session.auditId
        if (link.mode === 'control' && desktop.agentInput) session.release = holdAgentDesktopInput(session.auditId, desktop.id)
        this.sessions.push(session)
        this.audit('sitzung-start', { session: session.auditId, by: `telegram:${link.ownerId}`, desktop: desktop.id, mode: AUDIT_MODE[link.mode], sourceIp: session.sourceIp, agentInputPaused: Boolean(session.release) })
        return { code: 'ok', sessionId, session }
    }

    // -----------------------------------------------------------------------
    // sessions
    // -----------------------------------------------------------------------

    /** WebSocket: exactly one claim per session, within the connect window. */
    claimSession(sessionId: string): DesktopSession | null {
        this.sweep()
        const candidate = sha256(LINK_TOKEN.test(sessionId) ? sessionId : `invalid:${sessionId}`)
        let found: DesktopSession | undefined
        for (const session of this.sessions) if (timingSafeEqual(session.hash, candidate) && !found) found = session
        if (!found || !LINK_TOKEN.test(sessionId) || found.ended || found.claimed || this.now() > found.connectBy) return null
        found.claimed = true
        this.audit('verbunden', { session: found.auditId, desktop: found.desktop.id, mode: AUDIT_MODE[found.mode] })
        return found
    }

    endSession(session: DesktopSession, reason: string): void {
        if (session.ended) return
        session.ended = true
        try { session.release?.() } catch { /* ignore */ }
        try { session.closer?.(reason) } catch { /* ignore */ }
        this.sessions = this.sessions.filter(item => item !== session)
        this.audit('sitzung-ende', { session: session.auditId, desktop: session.desktop.id, mode: AUDIT_MODE[session.mode], reason, durationMs: this.now() - session.startedAt })
    }

    private releaseByLinkHash(hash: Buffer): boolean {
        const link = this.links.find(item => item.hash.equals(hash))
        if (!link) return false
        if (!link.redeemed) {
            link.revoked = true
            this.audit('link-zurueckgezogen', { desktop: link.desktopId, mode: AUDIT_MODE[link.mode] })
            return true
        }
        const session = this.sessions.find(item => item.auditId === link.auditId)
        if (!session) return false
        this.endSession(session, 'zurueckgegeben')
        return true
    }

    activeSessions(): readonly DesktopSession[] { return this.sessions }

    /** Expire links/pickers, end unclaimed sessions after the connect window and long sessions after sessionMaxMs. */
    sweep(): void {
        const now = this.now()
        this.pickers = this.pickers.filter(picker => now <= picker.expiresAt)
        this.links = this.links.filter(link => now <= link.expiresAt + this.config.sessionMaxMs)
        for (const session of [...this.sessions]) {
            if (!session.claimed && now > session.connectBy) this.endSession(session, 'nicht-verbunden')
            else if (now - session.startedAt > this.config.sessionMaxMs) this.endSession(session, 'zeitlimit')
        }
    }

    /** Daemon stop: end everything (releases every pause). */
    shutdown(): void {
        for (const session of [...this.sessions]) this.endSession(session, 'daemon-stopp')
        this.pickers = []
        this.links = []
    }
}
