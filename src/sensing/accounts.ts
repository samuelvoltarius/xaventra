/**
 * Konten erkennen (E-Mail/Kalender) — nur aus EIGENEN Quellen:
 *  - Xaventra-Config (`autonomy.sensing.adapters.mail`, `homeassistant` usw.),
 *  - eigener Auth-Speicher `.nova-data/auth.json` (nur provider/type/email).
 * Keine fremden Profile (Thunderbird, Browser, Keychain), kein Auslesen von
 * Tokens/Passwörtern in Ergebnisse oder Logs. Vorschlag „lesend verbinden?“;
 * der OAuth-Login selbst bleibt ein einmaliger Owner-Schritt.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RawEvent } from './event-bus.js'
import type { SensingConfig } from './config.js'

export interface DetectedAccount {
    id: string
    kind: 'gmail' | 'imap' | 'google-calendar'
    label: string
    /** usable right now by the mail sensor (credentials present + adapter on) */
    connected: boolean
    note: string
}

const GOOGLE = new Set(['google', 'gmail', 'google-gmail'])
const CALENDAR = new Set(['google-calendar', 'gcal', 'calendar'])

export function maskEmail(email: string): string {
    const [local, domain] = String(email || '').split('@')
    if (!domain) return local ? `${local.slice(0, 3)}…` : '?'
    return `${local.slice(0, Math.min(8, Math.max(2, Math.ceil(local.length / 2))))}…@${domain}`
}

/** Own auth store, reduced to non-secret fields right away. */
export function readAuthProfileShapes(dataDir: string): Record<string, { provider: string; type: string; email?: string; expires?: number; hasToken: boolean }> {
    const path = join(dataDir, 'auth.json')
    if (!existsSync(path)) return {}
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        const profiles = parsed?.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : parsed
        const out: Record<string, { provider: string; type: string; email?: string; expires?: number; hasToken: boolean }> = {}
        for (const [name, value] of Object.entries(profiles || {})) {
            const p = value as any
            if (!p || typeof p !== 'object') continue
            out[name] = {
                provider: String(p.provider || name).toLowerCase(),
                type: String(p.type || ''),
                email: typeof p.email === 'string' ? p.email : undefined,
                expires: typeof p.expires === 'number' ? p.expires : undefined,
                hasToken: Boolean(p.access || p.token),
            }
        }
        return out
    } catch { return {} }
}

export function detectAccounts(config: SensingConfig, shapes: ReturnType<typeof readAuthProfileShapes>, nowMs = Date.now()): DetectedAccount[] {
    const out: DetectedAccount[] = []
    const mail = config.adapters.mail
    for (const [name, shape] of Object.entries(shapes)) {
        if (GOOGLE.has(shape.provider)) {
            const valid = shape.hasToken && (shape.expires === undefined || shape.expires > nowMs)
            out.push({
                id: `acct-gmail-${name}`, kind: 'gmail', label: `Gmail ${maskEmail(shape.email || name)}`,
                connected: valid && mail.enabled && config.enabled,
                note: valid ? (mail.enabled ? 'lesend verbunden' : 'Token vorhanden, Mail-Sensor aus') : 'Token abgelaufen oder fehlt: OAuth-Login durch den Owner nötig',
            })
        } else if (CALENDAR.has(shape.provider)) {
            out.push({ id: `acct-cal-${name}`, kind: 'google-calendar', label: `Kalender ${maskEmail(shape.email || name)}`, connected: false, note: 'Kalender-Sensor folgt; Verbindung nur nach OAuth-Login durch den Owner' })
        }
    }
    if (mail.imap?.host && mail.imap.user) {
        const hasSecret = Boolean(mail.imap.password || mail.imap.passwordEnv)
        out.push({
            id: 'acct-imap', kind: 'imap', label: `IMAP ${maskEmail(mail.imap.user)} @ ${mail.imap.host}`,
            connected: hasSecret && mail.enabled && config.enabled,
            note: hasSecret ? (mail.enabled ? 'lesend verbunden (EXAMINE)' : 'Zugang konfiguriert, Mail-Sensor aus') : 'Passwort fehlt: Owner trägt passwordEnv ein',
        })
    }
    return out
}

export function accountEvents(accounts: DetectedAccount[]): RawEvent[] {
    return accounts.filter(account => !account.connected).map(account => ({
        kind: 'accounts.found', subject: account.id, severity: 'info' as const,
        dedupeKey: `account:${account.id}:${account.note}`, dedupeWindowMs: 30 * 24 * 60 * 60_000,
        summary: `${account.label} gefunden. Lesend verbinden? (${account.note})`,
        evidence: { konto: account.label, art: account.kind },
        hint: {
            importance: 'normal' as const,
            proposal: account.kind === 'imap' ? 'Mail-Sensor lesend einschalten (autonomy.sensing.adapters.mail.enabled)?' : 'Einmaliger OAuth-Login durch den Owner, danach nur lesend.',
            action: { kind: 'connectAccount' as const, accountId: account.id },
            title: `${account.label}: lesend verbinden?`,
        },
    }))
}
