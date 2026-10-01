import { randomUUID, sign, verify } from 'node:crypto'
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalJson } from './install-catalog.js'

// ============================================================================
// P9 (Doppelungen): the one core for signed single-use host-agent tickets.
// Install tickets (Stufe 2) and vLLM switch tickets (Phase 8) used to carry the
// same code twice. Here: code-generated id and expiry, ed25519 signature over a
// domain-separated canonical payload, exact field set, node/client binding,
// strict timing, and the host-side single-use claim. Each ticket type keeps
// only its own rules (catalog entry/hash, operation, target list, approver).
// The byte format is unchanged (`<label>:<canonical JSON>`), so tickets stay
// compatible across a mixed-version rollout.
// ============================================================================

export interface TicketDomain {
    /** Domain separator in the signed bytes, e.g. 'xaventra-install-ticket'. */
    label: string
    /** Id prefix, e.g. 'inst' → `inst-<uuid>`. */
    idPrefix: string
    ttlMs: number
}
export interface TicketTiming { id: string; nodeId: string; clientId: string; issuedAt: number; expiresAt: number }
export interface SignedTicket<T> { payload: T; signature: string }

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
export const ticketIdPattern = (domain: Pick<TicketDomain, 'idPrefix'>) => new RegExp(`^${domain.idPrefix}-${UUID}$`)
export const ticketBytes = (domain: Pick<TicketDomain, 'label'>, payload: unknown): Buffer => Buffer.from(`${domain.label}:${canonicalJson(payload)}`)

/** Code-side issue: id, issuedAt and expiresAt are always set here, never taken from the caller. */
export function signTicket<T extends TicketTiming>(domain: TicketDomain, fields: Omit<T, 'id' | 'issuedAt' | 'expiresAt'>, privateKey: string, now = Date.now()): SignedTicket<T> {
    const { id: _id, issuedAt: _issuedAt, expiresAt: _expiresAt, ...rest } = fields as Record<string, unknown>
    const payload = { ...rest, id: `${domain.idPrefix}-${randomUUID()}`, issuedAt: now, expiresAt: now + domain.ttlMs } as unknown as T
    return { payload, signature: sign(null, ticketBytes(domain, payload), privateKey).toString('base64') }
}

export interface TicketVerifyContext<T> {
    publicKey: string
    /** Exact sorted field list the payload must have (may depend on the payload, e.g. rollback). */
    keys: (payload: T) => readonly string[]
    nodeId: string
    clientId: string
    now?: number
}

/** Host-side envelope check. Throws on anything but an exact, fresh, signed ticket for this node. */
export function verifyTicketEnvelope<T extends TicketTiming>(domain: TicketDomain, signed: unknown, ctx: TicketVerifyContext<T>): T {
    const now = ctx.now ?? Date.now()
    const value = signed as SignedTicket<T>
    if (!value || typeof value !== 'object' || typeof value.signature !== 'string' || !value.payload || typeof value.payload !== 'object') throw Error('Ticket fehlt')
    if (Object.keys(value).sort().join(',') !== 'payload,signature') throw Error('Ticket hat unbekannte Felder')
    const t = value.payload
    if (Object.keys(t).sort().join(',') !== [...ctx.keys(t)].sort().join(',')) throw Error('Ticket hat unbekannte oder fehlende Felder')
    if (!ctx.publicKey) throw Error('Kein Ticket-Schlüssel eingerichtet')
    let valid = false
    try { valid = verify(null, ticketBytes(domain, t), ctx.publicKey, Buffer.from(value.signature, 'base64')) } catch { valid = false }
    if (!valid) throw Error('Ticket-Signatur ungültig')
    if (!ticketIdPattern(domain).test(String(t.id))) throw Error('Ticket-ID nicht vom Code erzeugt')
    if (t.nodeId !== ctx.nodeId || t.clientId !== ctx.clientId) throw Error('Ticket gilt für einen anderen Knoten')
    if (!Number.isSafeInteger(t.expiresAt) || !Number.isSafeInteger(t.issuedAt) || t.expiresAt <= now
        || t.expiresAt > now + domain.ttlMs || t.issuedAt > now + 30_000 || t.expiresAt - t.issuedAt > domain.ttlMs) throw Error('Ticket abgelaufen oder zu lange gültig')
    return t
}

/** Durable JSON write (fsync file and, on POSIX, the directory). */
export function writeDurableJson(path: string, value: unknown, options: { exclusive?: boolean } = {}): void {
    const fd = openSync(path, options.exclusive ? 'wx' : 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
    if (process.platform !== 'win32') {
        const directory = openSync(dirname(path), 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
    }
}

/** Single use: the ticket record is created exclusively before any work; a second claim throws. */
export function claimTicketOnce(path: string, record: unknown): void {
    writeDurableJson(path, record, { exclusive: true })
}
