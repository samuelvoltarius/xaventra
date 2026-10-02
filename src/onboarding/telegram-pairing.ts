import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'
import { getRuntimeRoot } from '../core/data-root.js'
import { updateOnboardingState } from './first-start.js'

// ============================================================================
// 2.85 Paket B, Punkt 3 — Telegram koppeln per Link/QR statt Owner-ID tippen.
//
// Der Owner erzeugt in der Desktop-App (Owner-Token) einen Einmal-Code. Die App
// zeigt https://t.me/<bot>?start=<code> als Link und QR. Tippt er ihn auf dem
// Handy an, schickt Telegram "/start <code>" an den Bot; der Absender wird als
// Owner in channels.telegram.allowFrom eingetragen. Sicherheit:
//  - 144 Bit Zufall, nur der sha256-Hash wird gespeichert, Vergleich in
//    konstanter Zeit, gültig 10 Minuten, genau einmal einlösbar;
//  - nur in privaten Chats; Gruppen können nicht koppeln;
//  - gesetzt wird nur, was TELEGRAM_ALLOW_FROM (.env) nicht ohnehin festlegt.
// ============================================================================

export const PAIRING_TTL_MS = 10 * 60_000
const START_WITH_CODE = /^\/start(?:@[A-Za-z0-9_]{1,64})?\s+([A-Za-z0-9_-]{16,64})\s*$/

interface PairingRecord { codeHash: string; expiresAt: string; issuedAt: string; usedAt?: string }

const hash = (code: string) => createHash('sha256').update(code, 'utf8').digest('hex')
const pairingPath = (root: string) => join(root, '.nova-data', 'telegram-pairing.json')

function writeAtomic(path: string, content: string, mode = 0o600): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, content, { mode })
    renameSync(tmp, path)
}

function readRecord(root: string): PairingRecord | null {
    try {
        const value = JSON.parse(readFileSync(pairingPath(root), 'utf8'))
        return typeof value?.codeHash === 'string' && typeof value?.expiresAt === 'string' ? value : null
    } catch { return null }
}

/** A deep-link payload: only [A-Za-z0-9_-], max 64 characters (Telegram rule). */
export function telegramPairingLink(botUsername: string, code: string): string {
    if (!/^[A-Za-z0-9_]{5,64}$/.test(botUsername)) throw new Error('Ungültiger Bot-Name')
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) throw new Error('Ungültiger Kopplungscode')
    return `https://t.me/${botUsername}?start=${code}`
}

/** New one-time code; replaces any earlier unused code. The code is returned once and never stored. */
export function issueTelegramPairing(options: { root?: string; now?: number; ttlMs?: number; env?: Record<string, string | undefined> } = {}): { code: string; expiresAt: string } {
    const root = options.root ?? getRuntimeRoot()
    const env = options.env ?? process.env
    if (String(env.TELEGRAM_ALLOW_FROM || '').split(',').some(entry => entry.trim())) {
        throw new Error('TELEGRAM_ALLOW_FROM in der .env legt den Telegram-Owner bereits fest; Kopplung per Code ist dort abgeschaltet.')
    }
    const now = options.now ?? Date.now()
    const code = randomBytes(18).toString('base64url')
    const expiresAt = new Date(now + (options.ttlMs ?? PAIRING_TTL_MS)).toISOString()
    writeAtomic(pairingPath(root), `${JSON.stringify({ codeHash: hash(code), expiresAt, issuedAt: new Date(now).toISOString() } satisfies PairingRecord, null, 2)}\n`)
    return { code, expiresAt }
}

/** Adds the Telegram user id to channels.telegram.allowFrom (owner), keeping existing entries and the file mode. */
export function bindTelegramOwner(userId: string, root = getRuntimeRoot()): string[] {
    if (!/^\d{1,20}$/.test(userId)) throw new Error('Ungültige Telegram-ID')
    const path = resolveConfigPath(root)
    const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    config.channels ||= {}
    config.channels.telegram ||= { enabled: false, token: '' }
    const current: string[] = Array.isArray(config.channels.telegram.allowFrom)
        ? config.channels.telegram.allowFrom.map((entry: unknown) => String(entry ?? '').trim()).filter(Boolean) : []
    const next = current.includes(userId) ? current : [...current, userId]
    config.channels.telegram.allowFrom = next
    let mode = 0o600
    try { mode = statSync(path).mode & 0o777 } catch { /* new file */ }
    writeAtomic(path, `${JSON.stringify(config, null, 2)}\n`, mode)
    return next
}

export type PairingOutcome =
    | { handled: false }
    | { handled: true; ok: false; reply: string }
    | { handled: true; ok: true; reply: string; userId: string }

/**
 * Called by the Telegram adapter for "/start <code>" in a private chat, before
 * the allowlist. handled=false: not a pairing message (normal processing).
 */
export function claimTelegramPairing(text: unknown, sender: { id: string; username?: string; isGroup?: boolean },
    options: { root?: string; now?: number; bind?: (userId: string) => void } = {}): PairingOutcome {
    const match = typeof text === 'string' ? START_WITH_CODE.exec(text) : null
    if (!match || sender.isGroup) return { handled: false }
    const root = options.root ?? getRuntimeRoot()
    const record = readRecord(root)
    if (!record) return { handled: false }
    const refused = { handled: true as const, ok: false as const, reply: 'Dieser Kopplungscode ist ungültig, abgelaufen oder schon benutzt. Erzeuge in der Xaventra-App einen neuen.' }
    const now = options.now ?? Date.now()
    if (record.usedAt || !(Date.parse(record.expiresAt) > now)) return refused
    const given = Buffer.from(hash(match[1]), 'hex')
    const expected = Buffer.from(record.codeHash, 'hex')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return refused
    if (!/^\d{1,20}$/.test(sender.id)) return refused
    // Single use: mark first, then bind (a crash in between leaves no reusable code).
    writeAtomic(pairingPath(root), `${JSON.stringify({ ...record, usedAt: new Date(now).toISOString() }, null, 2)}\n`)
    ;(options.bind ?? (id => { bindTelegramOwner(id, root) }))(sender.id)
    const pairedWith = sender.username ? `@${sender.username.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64)}` : 'verbunden'
    try { updateOnboardingState(current => ({ telegram: { ...(current.telegram || {}), pairedAt: new Date(now).toISOString(), pairedWith } }), root) } catch { /* marker optional */ }
    return { handled: true, ok: true, userId: sender.id, reply: 'Gekoppelt. Ich höre ab jetzt hier auf dich. In der Xaventra-App siehst du das auch.' }
}

export function telegramPairingStatus(root = getRuntimeRoot(), now = Date.now()): { pending: boolean; expiresAt?: string; usedAt?: string } {
    const record = readRecord(root)
    if (!record) return { pending: false }
    return { pending: !record.usedAt && Date.parse(record.expiresAt) > now, expiresAt: record.expiresAt, ...(record.usedAt ? { usedAt: record.usedAt } : {}) }
}

/** Private-chat "/start <code>" while a pairing code is outstanding (sync, for the update listener). */
export function isTelegramPairingMessage(msg: any, root = getRuntimeRoot(), now = Date.now()): boolean {
    const isGroup = msg?.chat?.type === 'group' || msg?.chat?.type === 'supergroup' || msg?.chat?.type === 'channel'
    if (isGroup || typeof msg?.text !== 'string' || !START_WITH_CODE.test(msg.text)) return false
    const record = readRecord(root)
    return Boolean(record && !record.usedAt && Date.parse(record.expiresAt) > now)
}
