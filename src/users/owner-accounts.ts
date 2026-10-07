/**
 * Ein Owner, viele Kanäle (2.88 Paket „Projekte und ein Gedächtnis").
 *
 * Telegram, App, Web-App, Anruf über die App, Slack … sind für den Owner
 * EINE Person mit EINEM Gesprächs- und Projektkontext. Dafür hält diese Datei
 * die bestätigten Kanal-Konten des Owners und ihre gemeinsame Identität
 * (kanonischer Principal). `resolvePrincipalId` fragt hier nach; Sitzung,
 * Gedächtnis, Ziele und Projekte hängen schon heute am Principal und werden
 * dadurch automatisch kanalübergreifend.
 *
 * Bestätigt ist ein Konto nur, wenn
 *   - es der konfigurierte Telegram-Owner ist (allowFrom, permissionSource
 *     „configured"),
 *   - es über einen vertrauenswürdigen Zugang kommt, der Owner-Rechte erst
 *     nach Prüfung vergibt (App/Desktop mit Owner-Token, CLI am Gerät,
 *     REST mit Token), oder
 *   - der Owner es mit einem Einmal-Code verknüpft hat („verknüpfen 123456"
 *     im neuen Kanal; Code gilt 10 Minuten, höchstens 5 Fehlversuche, liegt
 *     nur im Speicher).
 * Nie: Gruppenchats, fremde Nutzer, ausdrücklich beförderte Zweit-Owner,
 * Telefonnummern (lassen sich fälschen).
 *
 * Der kanonische Principal wird beim ersten bestätigten Konto festgelegt und
 * bleibt danach stabil (sonst würden Daten bei einer Config-Änderung
 * „umziehen"). Bestehende Installationen behalten den Telegram-Principal.
 *
 * Datei: `<data>/users/owner-accounts.json` — keine Geheimnisse.
 */
import { randomInt } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'

export type OwnerAccountSource = 'konfiguriert' | 'vertrauter-zugang' | 'code'

export interface OwnerAccount {
    channel: string
    rawId: string
    source: OwnerAccountSource
    linkedAt: string
}

interface OwnerAccountFile { version: 1; canonical?: string; accounts: OwnerAccount[] }

export type RedeemResult = 'ok' | 'falsch' | 'abgelaufen' | 'gesperrt' | 'schon-verbunden'

const CODE_TTL_MS = 10 * 60_000
const MAX_FAILED_ATTEMPTS = 5
const MAX_ACCOUNTS = 32

const clean = (value: unknown, max = 200) => String(value ?? '').trim().slice(0, max)
export const normalizeChannel = (channel: unknown) => clean(channel, 40).toLowerCase() || 'unknown'
export const accountKey = (channel: unknown, rawId: unknown) => `${normalizeChannel(channel)}:${clean(rawId)}`

export class OwnerAccountRegistry {
    private data: OwnerAccountFile = { version: 1, accounts: [] }
    private code: { value: string; expiresAt: number; failures: number } | null = null

    constructor(private readonly path = getNovaDataDir('users', 'owner-accounts.json'), private readonly now: () => number = Date.now) {
        try {
            if (!existsSync(path)) return
            const parsed = JSON.parse(readFileSync(path, 'utf8'))
            if (parsed?.version !== 1 || !Array.isArray(parsed.accounts)) return
            this.data = {
                version: 1,
                canonical: typeof parsed.canonical === 'string' && parsed.canonical.trim() ? clean(parsed.canonical) : undefined,
                accounts: parsed.accounts.filter((item: any) => item && typeof item.channel === 'string' && typeof item.rawId === 'string')
                    .map((item: any) => ({ channel: normalizeChannel(item.channel), rawId: clean(item.rawId), source: item.source, linkedAt: String(item.linkedAt || '') }))
                    .slice(0, MAX_ACCOUNTS),
            }
        } catch { /* a damaged file links nothing (fail closed: everyone stays separate) */ }
    }

    canonical(): string | null { return this.data.canonical || null }

    list(): OwnerAccount[] { return this.data.accounts.map(item => ({ ...item })) }

    isLinked(channel: string, rawId: string): boolean {
        const key = accountKey(channel, rawId)
        return this.data.accounts.some(item => accountKey(item.channel, item.rawId) === key)
    }

    /** Canonical owner principal for a confirmed account, else null. */
    lookup(channel: string, rawId: string): string | null {
        return this.data.canonical && this.isLinked(channel, rawId) ? this.data.canonical : null
    }

    /** Records a confirmed owner account. The first confirmation fixes the canonical principal. */
    confirm(channel: string, rawId: string, source: OwnerAccountSource, canonicalCandidate: string): string {
        if (!this.data.canonical) this.data.canonical = clean(canonicalCandidate) || accountKey(channel, rawId)
        if (!this.isLinked(channel, rawId) && clean(rawId)) {
            this.data.accounts = [...this.data.accounts, { channel: normalizeChannel(channel), rawId: clean(rawId), source, linkedAt: new Date(this.now()).toISOString() }].slice(-MAX_ACCOUNTS)
            this.persist()
        } else if (this.data.accounts.length === 0) {
            this.persist()
        }
        return this.data.canonical
    }

    unlink(channel: string, rawId: string): boolean {
        const key = accountKey(channel, rawId)
        const before = this.data.accounts.length
        this.data.accounts = this.data.accounts.filter(item => accountKey(item.channel, item.rawId) !== key)
        if (this.data.accounts.length === before) return false
        this.persist()
        return true
    }

    /** One active code at a time; a new code replaces the old one. Never persisted. */
    issueCode(): { code: string; expiresAt: number } {
        const value = String(randomInt(0, 1_000_000)).padStart(6, '0')
        this.code = { value, expiresAt: this.now() + CODE_TTL_MS, failures: 0 }
        return { code: value, expiresAt: this.code.expiresAt }
    }

    redeemCode(code: string, channel: string, rawId: string, canonicalCandidate = ''): RedeemResult {
        if (this.isLinked(channel, rawId)) return 'schon-verbunden'
        const active = this.code
        if (!active) return 'falsch'
        if (active.failures >= MAX_FAILED_ATTEMPTS) return 'gesperrt'
        if (this.now() > active.expiresAt) { this.code = null; return 'abgelaufen' }
        if (clean(code) !== active.value) {
            active.failures++
            if (active.failures >= MAX_FAILED_ATTEMPTS) this.code = { ...active, value: '' }
            return 'falsch'
        }
        this.code = null
        this.confirm(channel, rawId, 'code', canonicalCandidate)
        return 'ok'
    }

    private persist(): void {
        atomicWriteJsonSync(this.path, this.data)
    }
}

let registry: OwnerAccountRegistry | null = null

export function getOwnerAccountRegistry(): OwnerAccountRegistry {
    return registry ||= new OwnerAccountRegistry()
}

/** Tests/runtime: replace (or reset with null) the process-wide registry. */
export function setOwnerAccountRegistry(value: OwnerAccountRegistry | null): void {
    registry = value
}

/** Canonical owner principal for a linked account; null for everyone else. Never throws. */
export function linkedOwnerPrincipal(channel: string, rawId: string): string | null {
    try { return getOwnerAccountRegistry().lookup(channel, rawId) } catch { return null }
}

/**
 * 2.89: who may answer a card. The numeric Telegram owner ids (allowFrom) and every
 * CONFIRMED owner account as `channel:rawId` (App/Desktop with owner token, CLI, REST
 * token, linked by code). Telegram accounts only count numerically (usernames never).
 * Never throws; a damaged registry adds nothing.
 */
export function cardOwnerIdentities(config: PrincipalConfigLike | null | undefined, registry?: OwnerAccountRegistry): string[] {
    const allowFrom = Array.isArray(config?.channels?.telegram?.allowFrom) ? config!.channels!.telegram!.allowFrom! : []
    const out = allowFrom.map(item => clean(item).replace(/^telegram:/i, '')).filter(item => /^\d{1,20}$/.test(item))
    try {
        for (const account of (registry || getOwnerAccountRegistry()).list()) {
            const channel = normalizeChannel(account.channel), raw = clean(account.rawId)
            if (!raw) continue
            if (channel === 'telegram') { if (/^\d{1,20}$/.test(raw)) out.push(raw); continue }
            out.push(accountKey(channel, raw))
        }
    } catch { /* fail closed: only the configured ids */ }
    return [...new Set(out)]
}

interface PrincipalConfigLike {
    ownerPrincipal?: string
    userPrincipals?: Record<string, string>
    channels?: { telegram?: { allowFrom?: unknown[] } }
}

/**
 * Who the owner "is" when the first account is confirmed: an explicit
 * ownerPrincipal, else the configured Telegram owner's principal (keeps all
 * existing data where it is), else the confirming account's own principal.
 */
export function canonicalOwnerCandidate(config: PrincipalConfigLike | null | undefined, channel: string, rawId: string): string {
    const explicit = clean(config?.ownerPrincipal)
    if (explicit) return explicit
    const mappings = config?.userPrincipals || {}
    const telegramOwner = clean(config?.channels?.telegram?.allowFrom?.[0]).replace(/^telegram:/i, '')
    if (telegramOwner) return clean(mappings[`telegram:${telegramOwner}`] || mappings[telegramOwner] || telegramOwner)
    const raw = clean(rawId)
    return clean(mappings[`${normalizeChannel(channel)}:${raw}`] || mappings[raw] || raw)
}

export interface OwnerAccountEvidence {
    channel: string
    rawUserId: string
    permission?: string
    permissionSource?: string
}

/**
 * Ingress that only ever grants owner rights after its own authentication:
 * the configured Telegram owner, the token-checked App/Desktop owner, the
 * local CLI and the token-authenticated REST principal. A phone number is
 * never proof (it can be spoofed); an explicitly promoted user may be
 * another person and needs the link code.
 */
export function trustedOwnerSource(evidence: OwnerAccountEvidence): OwnerAccountSource | null {
    if (evidence.permission !== 'owner') return null
    const channel = normalizeChannel(evidence.channel)
    const raw = clean(evidence.rawUserId)
    if (/^telefon:/i.test(raw)) return null
    if (evidence.permissionSource === 'configured') return 'konfiguriert'
    if (channel === 'desktop' && /^desktop:[^:]+$/.test(raw)) return 'vertrauter-zugang'
    if (channel === 'cli' && raw === 'cli') return 'vertrauter-zugang'
    if (channel === 'rest-api' && raw === 'rest-api:token') return 'vertrauter-zugang'
    return null
}

/**
 * Called by the pipeline after authentication. Confirms a trusted owner
 * account (idempotent) and returns the canonical principal for any linked
 * owner account; null for everyone else (they keep their own principal).
 */
export function confirmOwnerAccountIfTrusted(input: OwnerAccountEvidence & { config?: PrincipalConfigLike | null; isGroup: boolean | null }): string | null {
    if (input.isGroup !== false) return null
    try {
        const accounts = getOwnerAccountRegistry()
        const linked = accounts.lookup(input.channel, input.rawUserId)
        if (input.permission !== 'owner') return null
        if (linked) return linked
        const source = trustedOwnerSource(input)
        if (!source) return null
        return accounts.confirm(input.channel, input.rawUserId, source, canonicalOwnerCandidate(input.config, input.channel, input.rawUserId))
    } catch {
        return null
    }
}

/**
 * After a successful code redemption the new account is the owner's own
 * account and gets owner rights — the same proof standard as the Telegram
 * pairing code (onboarding/telegram-pairing.ts). Re-checked against the
 * registry, so a forged turn object grants nothing.
 */
export async function applyOwnerLink(turn: OwnerLinkTurn, channel: string, rawUserId: string): Promise<boolean> {
    if (turn.kind !== 'verbunden' || !turn.linkedPrincipal) return false
    if (getOwnerAccountRegistry().lookup(channel, rawUserId) !== turn.linkedPrincipal) return false
    const { setUserPermission } = await import('./multi-user-middleware.js')
    return setUserPermission(rawUserId, 'owner')
}

const REDEEM = /^\s*(?:verknüpfen|verknuepfen|verknüpfe|verknuepfe)\s+(\d{6})\s*[.!]?\s*$/i
const ISSUE_CODE = /\bverkn(?:ü|ue)pfungscode\b|^\s*\/verkn(?:ü|ue)pfen\s*$/i
const ISSUE_VERB = /\bverkn(?:ü|ue)pf/i
const ISSUE_TARGET = /\b(?:kanal|kanäle|konto|chat|account|slack|discord|whatsapp|signal|matrix|teams|web-?app|app|e-?mail)\w*/i

export interface OwnerLinkTurn {
    kind: 'code-ausgegeben' | 'verbunden' | 'abgelehnt'
    reply: string
    /** Set when an account was linked: the caller grants owner rights to it. */
    linkedPrincipal?: string
}

/**
 * Deterministic link conversation (no slash command needed):
 *   owner on a confirmed account: „Ich will Slack mit dir verknüpfen" → code
 *   new account (direct chat):    „verknüpfen 123456"                 → linked
 * Returns null when the message is not about linking (normal processing).
 */
export function ownerLinkTurn(input: { channel: string; rawUserId: string; isGroup: boolean | null; text: string; config?: PrincipalConfigLike | null }): OwnerLinkTurn | null {
    if (input.isGroup !== false) return null
    const text = String(input.text || '')
    const accounts = getOwnerAccountRegistry()
    const redeem = REDEEM.exec(text)
    if (redeem) {
        const result = accounts.redeemCode(redeem[1], input.channel, input.rawUserId, canonicalOwnerCandidate(input.config, input.channel, input.rawUserId))
        if (result === 'ok') {
            return { kind: 'verbunden', linkedPrincipal: accounts.canonical() || undefined,
                reply: 'Verbunden. Ab jetzt kenne ich dich hier genauso wie in deinen anderen Kanälen — gleiche Gespräche, gleiche Projekte.' }
        }
        if (result === 'schon-verbunden') return { kind: 'verbunden', reply: 'Dieser Kanal ist schon mit dir verbunden.', linkedPrincipal: accounts.canonical() || undefined }
        return { kind: 'abgelehnt', reply: 'Der Code passt nicht oder ist abgelaufen. Lass dir in einem verbundenen Kanal einen neuen geben.' }
    }
    const wantsCode = ISSUE_CODE.test(text) || (ISSUE_VERB.test(text) && ISSUE_TARGET.test(text))
    if (!wantsCode || text.length > 240) return null
    if (!accounts.isLinked(input.channel, input.rawUserId)) return null
    const { code } = accounts.issueCode()
    return {
        kind: 'code-ausgegeben',
        reply: `Schreib mir im neuen Kanal genau das: verknüpfen ${code}\nDer Code gilt 10 Minuten und nur einmal.`,
    }
}