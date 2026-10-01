import { randomUUID, sign, verify } from 'node:crypto'
import { canonicalJson, findCatalogEntry, installEntryHash, isCatalogId, type ApprovalLevel, type InstallCatalog } from './install-catalog.js'

// ============================================================================
// Stufe 2 (S2.2): single-use install ticket. Issued by the Main's code after
// an owner approval (or an owner-set 'erlauben' level in YOLO mode), signed
// with the operator's ed25519 key, short-lived and bound to catalog id + entry
// hash + node. Ticket ids are always generated here, never taken from a model.
// ============================================================================

export const INSTALL_TICKET_TTL_MS = 5 * 60_000
export const TICKET_ID_PATTERN = /^inst-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export interface InstallTicket {
    id: string
    operation: 'install' | 'rollback'
    nodeId: string
    clientId: string
    catalogId: string
    catalogHash: string
    entryHash: string
    approval: ApprovalLevel
    /** 'owner:<principal>' after /setup approve, 'policy:erlauben' for an owner-lifted entry in YOLO mode. */
    approvedBy: string
    /** Rollback tickets reference the install ticket whose recorded rollback is executed. */
    installTicketId?: string
    issuedAt: number
    expiresAt: number
}
export interface SignedInstallTicket { payload: InstallTicket; signature: string }

export const installTicketBytes = (ticket: InstallTicket): Buffer => Buffer.from(`xaventra-install-ticket:${canonicalJson(ticket)}`)

export function newInstallTicketId(): string { return `inst-${randomUUID()}` }

export interface IssueInstallTicketInput {
    operation?: 'install' | 'rollback'
    nodeId: string
    clientId: string
    catalogId: string
    approval: ApprovalLevel
    approvedBy: string
    installTicketId?: string
}

/** Code-side ticket creation. No caller-supplied id, expiry or hash. */
export function issueInstallTicket(input: IssueInstallTicketInput, privateKey: string, catalog: InstallCatalog, now = Date.now()): SignedInstallTicket {
    const entry = findCatalogEntry(input.catalogId, catalog)
    if (!entry) throw Error('Kein Katalogeintrag: Ticket wird nicht ausgestellt')
    if (!/^(owner:[^\s]{1,120}|policy:erlauben)$/.test(String(input.approvedBy || ''))) throw Error('Freigabe muss vom Owner oder einer Owner-Stufe stammen')
    if (input.approvedBy === 'policy:erlauben' && input.approval !== 'erlauben') throw Error('Automatische Freigabe nur für Stufe erlauben')
    const operation = input.operation || 'install'
    if (operation === 'rollback' && !TICKET_ID_PATTERN.test(String(input.installTicketId || ''))) throw Error('Rückweg braucht die Ticket-ID der Installation')
    const payload: InstallTicket = {
        id: newInstallTicketId(), operation, nodeId: String(input.nodeId), clientId: String(input.clientId),
        catalogId: entry.id, catalogHash: catalog.hash, entryHash: installEntryHash(entry),
        approval: input.approval, approvedBy: input.approvedBy, issuedAt: now, expiresAt: now + INSTALL_TICKET_TTL_MS,
        ...(operation === 'rollback' ? { installTicketId: input.installTicketId } : {}),
    }
    return { payload, signature: sign(null, installTicketBytes(payload), privateKey).toString('base64') }
}

export interface InstallTicketContext { nodeId: string; clientId: string; publicKey: string; catalog: InstallCatalog; now?: number }

const TICKET_KEYS = ['approval', 'approvedBy', 'catalogHash', 'catalogId', 'clientId', 'entryHash', 'expiresAt', 'id', 'issuedAt', 'nodeId', 'operation']

/** Host-side verification. Throws on anything but an exact, fresh, signed ticket for a catalog entry. */
export function verifyInstallTicket(signed: unknown, ctx: InstallTicketContext): InstallTicket {
    const now = ctx.now ?? Date.now()
    const value = signed as SignedInstallTicket
    if (!value || typeof value !== 'object' || typeof value.signature !== 'string' || !value.payload || typeof value.payload !== 'object') throw Error('Ticket fehlt')
    if (Object.keys(value).sort().join(',') !== 'payload,signature') throw Error('Ticket hat unbekannte Felder')
    const t = value.payload
    const keys = Object.keys(t).sort()
    const expected = t.operation === 'rollback' ? [...TICKET_KEYS, 'installTicketId'].sort() : TICKET_KEYS
    if (keys.join(',') !== expected.join(',')) throw Error('Ticket hat unbekannte oder fehlende Felder')
    if (!ctx.publicKey) throw Error('Kein Ticket-Schlüssel eingerichtet')
    let valid = false
    try { valid = verify(null, installTicketBytes(t), ctx.publicKey, Buffer.from(value.signature, 'base64')) } catch { valid = false }
    if (!valid) throw Error('Ticket-Signatur ungültig')
    if (!TICKET_ID_PATTERN.test(t.id)) throw Error('Ticket-ID nicht vom Code erzeugt')
    if (!['install', 'rollback'].includes(t.operation)) throw Error('Unbekannte Ticket-Operation')
    if (t.operation === 'rollback' && !TICKET_ID_PATTERN.test(String(t.installTicketId))) throw Error('Rückweg ohne Installations-Ticket')
    if (t.nodeId !== ctx.nodeId || t.clientId !== ctx.clientId) throw Error('Ticket gilt für einen anderen Knoten')
    if (!Number.isSafeInteger(t.expiresAt) || !Number.isSafeInteger(t.issuedAt) || t.expiresAt <= now
        || t.expiresAt > now + INSTALL_TICKET_TTL_MS || t.issuedAt > now + 30_000 || t.expiresAt - t.issuedAt > INSTALL_TICKET_TTL_MS) throw Error('Ticket abgelaufen oder zu lange gültig')
    if (!isCatalogId(t.catalogId)) throw Error('Ungültige Katalog-ID')
    const entry = findCatalogEntry(t.catalogId, ctx.catalog)
    if (!entry) throw Error('Nicht im Katalog')
    if (t.entryHash !== installEntryHash(entry)) throw Error('Katalogeintrag hat sich geändert (Hash)')
    if (!['fragen', 'erlauben'].includes(t.approval)) throw Error('Ungültige Freigabestufe')
    if (!/^(owner:[^\s]{1,120}|policy:erlauben)$/.test(String(t.approvedBy))) throw Error('Freigabe nicht vom Owner')
    if (t.approvedBy === 'policy:erlauben' && t.approval !== 'erlauben') throw Error('Automatische Freigabe nur für Stufe erlauben')
    return t
}
