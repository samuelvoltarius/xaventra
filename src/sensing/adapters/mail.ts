/**
 * E-Mail-Sensor (nur lesen): IMAP (EXAMINE + BODY.PEEK) oder Gmail-REST (GET).
 *
 * Zugangsdaten NUR aus vorhandenen Quellen:
 *  - IMAP: `autonomy.sensing.adapters.mail.imap` mit host + user + Passwort
 *    (Config-Feld `password` oder Env-Variable aus `passwordEnv`),
 *  - Gmail: ein vorhandenes OAuth-/Token-Profil im eigenen Auth-Speicher
 *    (`.nova-data/auth.json`, provider google/gmail) mit gültigem Access-Token.
 * Fehlt etwas, tut der Adapter nichts: kein Raten von Hosts („imap.<domain>“),
 * kein Durchsuchen der Umgebung, kein Lesen fremder Profile, kein Token-Refresh
 * (der OAuth-Login bleibt ein Owner-Schritt).
 *
 * Meldet: neue Mail von bekanntem Kontakt und/oder mit Stichwort
 * (Angebot/Rechnung/Termin). Ereignisse enthalten nur Absender, gekürzten
 * Betreff und erkannte Stichworte — nie den Text. Logs enthalten nur Zahlen.
 */

import type { AdapterContext, RawEvent, SensingAdapter } from '../event-bus.js'
import type { MailAdapterConfig } from '../config.js'
import { fetchNewMailsImap, type ImapConnect, type ImapCredentials, type MailHeader } from './imap-readonly.js'
import type { FetchLike } from './printer.js'

export type MailCredentials =
    | ({ kind: 'imap' } & ImapCredentials)
    | { kind: 'gmail'; accessToken: string; account: string }

export type MailCredentialStatus = { credentials: MailCredentials | null; reason: string }

const GOOGLE_PROVIDERS = new Set(['google', 'gmail', 'google-gmail'])

/** Reads only provider/type/email/expiry fields of the OWN auth store profiles. */
export function resolveMailCredentials(cfg: MailAdapterConfig, deps: { env?: NodeJS.ProcessEnv; authProfiles?: Record<string, any> | null; now?: number }): MailCredentialStatus {
    const env = deps.env || {}
    const imap = cfg.imap
    if (imap) {
        const password = imap.password || (imap.passwordEnv ? env[imap.passwordEnv] : undefined)
        if (imap.host && imap.user && password) {
            return { credentials: { kind: 'imap', host: imap.host, port: imap.port || (imap.tls === false ? 143 : 993), user: imap.user, password, tls: imap.tls !== false }, reason: 'imap-config' }
        }
        return { credentials: null, reason: 'imap-unvollstaendig' }
    }
    const profiles = deps.authProfiles || {}
    const wanted = cfg.gmail?.profile
    const entries = Object.entries(profiles).filter(([name, profile]) =>
        profile && typeof profile === 'object' && (wanted ? name === wanted : GOOGLE_PROVIDERS.has(String(profile.provider || '').toLowerCase())))
    for (const [name, profile] of entries) {
        const token = profile.type === 'oauth' ? profile.access : profile.type === 'token' ? profile.token : undefined
        if (!token || typeof token !== 'string') continue
        if (typeof profile.expires === 'number' && profile.expires <= (deps.now ?? Date.now())) return { credentials: null, reason: 'gmail-token-abgelaufen' }
        return { credentials: { kind: 'gmail', accessToken: token, account: String(profile.email || name) }, reason: 'gmail-profil' }
    }
    return { credentials: null, reason: 'keine-zugangsdaten' }
}

export function parseAddress(from: string): { name: string; address: string; domain: string } {
    const angle = /^(.*)<([^>]+)>\s*$/.exec(from)
    const address = (angle ? angle[2] : from).trim().toLowerCase()
    const name = (angle ? angle[1] : '').trim().replace(/^"|"$/g, '')
    const domain = address.includes('@') ? address.split('@').pop()! : ''
    return { name, address, domain }
}

export function isKnownContact(address: string, known: string[]): boolean {
    const domain = address.split('@').pop() || ''
    return known.some(entry => entry === address || (entry.startsWith('@') ? domain === entry.slice(1) : !entry.includes('@') && domain === entry))
}

export function matchKeywords(subject: string, text: string, keywords: string[]): string[] {
    const haystack = `${subject}\n${text}`.toLowerCase()
    return keywords.filter(keyword => new RegExp(`(^|[^\\p{L}])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(haystack))
}

/** Short summary WITHOUT the mail text. */
export function mailToEvent(mail: MailHeader, cfg: Pick<MailAdapterConfig, 'knownContacts' | 'keywords'>, account: string): RawEvent | null {
    const sender = parseAddress(mail.from)
    const known = isKnownContact(sender.address, cfg.knownContacts)
    const hits = matchKeywords(mail.subject, mail.text, cfg.keywords)
    if (!known && !hits.length) return null
    const who = sender.name ? `${sender.name} (${sender.domain || sender.address})` : sender.address
    const subject = mail.subject.length > 80 ? `${mail.subject.slice(0, 79)}…` : mail.subject
    const label = hits.length ? hits.map(hit => hit[0].toUpperCase() + hit.slice(1)).join('/') : 'Nachricht'
    return {
        kind: 'mail.new', subject: account, severity: known && hits.length ? 'warning' : 'info',
        dedupeKey: `mail:${account}:${mail.id}`, dedupeWindowMs: 30 * 24 * 60 * 60_000,
        summary: `E-Mail von ${who} wegen ${label}: „${subject}“`,
        evidence: { konto: account, absender: sender.address, bekannt: known, stichworte: hits.join(',') || null, datum: mail.date || null },
        hint: {
            importance: known && hits.length ? 'hoch' : known ? 'normal' : 'niedrig',
            proposal: known ? 'Antwortentwurf vorbereiten?' : undefined,
            level: 'fragen',
            title: `E-Mail von ${who}${hits.length ? ` (${label})` : ''}`,
        },
    }
}

async function fetchGmail(credentials: Extract<MailCredentials, { kind: 'gmail' }>, seen: string[] | null, doFetch: FetchLike, signal: AbortSignal): Promise<{ ids: string[]; mails: MailHeader[] }> {
    const headers = { Authorization: `Bearer ${credentials.accessToken}`, Accept: 'application/json' }
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
    const list = await doFetch(`${base}?maxResults=20&q=${encodeURIComponent('in:inbox newer_than:2d')}`, { method: 'GET', headers, signal })
    if (!list.ok) throw new Error(`Gmail HTTP ${list.status}`)
    const ids: string[] = ((await list.json())?.messages || []).map((item: any) => String(item?.id || '')).filter(Boolean)
    const out: MailHeader[] = []
    // First run only sets the baseline (no flood of old mails, no metadata fetched).
    if (!seen) return { ids, mails: out }
    for (const id of ids.filter(item => !seen.includes(item)).slice(0, 20)) {
        const res = await doFetch(`${base}/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { method: 'GET', headers, signal })
        if (!res.ok) continue
        const body = await res.json()
        const h = Object.fromEntries(((body?.payload?.headers || []) as any[]).map(item => [String(item?.name || '').toLowerCase(), String(item?.value || '')]))
        out.push({ id, from: h.from || '', subject: h.subject || '', date: h.date || '', text: String(body?.snippet || '') })
    }
    return { ids, mails: out }
}

export function createMailAdapter(options: {
    config: MailAdapterConfig
    credentials: () => MailCredentialStatus
    fetch?: FetchLike
    imapConnect?: ImapConnect
}): SensingAdapter {
    const cfg = options.config
    const doFetch: FetchLike = options.fetch || ((url, init) => fetch(url, init) as any)
    return {
        id: 'mail', source: 'mail', intervalMs: cfg.intervalSec * 1000, timeoutMs: cfg.timeoutSec * 1000,
        async poll(ctx: AdapterContext): Promise<RawEvent[]> {
            const { credentials, reason } = options.credentials()
            ctx.state.credentialStatus = reason
            if (!credentials) return []
            let mails: MailHeader[] = []
            let account = ''
            if (credentials.kind === 'imap') {
                account = `${credentials.user}@imap`
                const sinceKey = `${credentials.host}|${credentials.user}`
                const cursor = (ctx.state.imap as Record<string, { uid: number; validity?: string }>) || {}
                const previous = cursor[sinceKey]
                const result = await fetchNewMailsImap(credentials, previous?.uid, { connect: options.imapConnect, signal: ctx.signal })
                // A new UIDVALIDITY invalidates the cursor: restart quietly from the newest mail.
                if (previous && result.uidValidity && previous.validity && previous.validity !== result.uidValidity) {
                    cursor[sinceKey] = { uid: result.lastUid, validity: result.uidValidity }
                } else {
                    mails = result.mails
                    cursor[sinceKey] = { uid: result.lastUid, validity: result.uidValidity }
                }
                ctx.state.imap = cursor
            } else {
                account = credentials.account
                const seen = Array.isArray(ctx.state.gmailSeen) ? ctx.state.gmailSeen as string[] : null
                const fetched = await fetchGmail(credentials, seen, doFetch, ctx.signal)
                mails = fetched.mails
                ctx.state.gmailSeen = [...new Set([...(seen || []), ...fetched.ids])].slice(-500)
            }
            const events = mails.map(mail => mailToEvent(mail, cfg, account)).filter((event): event is RawEvent => event !== null)
            // Text is dropped here; nothing of it reaches the bus, a sink or a log.
            mails.forEach(mail => { mail.text = '' })
            ctx.state.lastCount = { geprueft: mails.length, gemeldet: events.length }
            return events
        },
    }
}
