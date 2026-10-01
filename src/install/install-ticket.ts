import { findCatalogEntry, installEntryHash, isCatalogId, type ApprovalLevel, type InstallCatalog } from './install-catalog.js'
import { signTicket, ticketBytes, ticketIdPattern, verifyTicketEnvelope, type SignedTicket, type TicketDomain } from './signed-ticket.js'

// ============================================================================
// Stufe 2 (S2.2): single-use install ticket. Issued by the Main's code after
// the owner's card „Ja“ (or a standing permission in trust.json), signed with
// the operator's ed25519 key, short-lived and bound to catalog id + entry
// hash + node. Ticket ids are always generated here, never taken from a model.
// Signature, expiry, envelope and single use: the shared core signed-ticket.ts.
// ============================================================================

export const INSTALL_TICKET_TTL_MS = 5 * 60_000
const DOMAIN: TicketDomain = { label: 'xaventra-install-ticket', idPrefix: 'inst', ttlMs: INSTALL_TICKET_TTL_MS }
export const TICKET_ID_PATTERN = ticketIdPattern(DOMAIN)
const APPROVER = /^(owner:[^\s]{1,120}|policy:erlauben|policy:vertrauensleiter)$/

export interface InstallTicket {
    id: string
    operation: 'install' | 'rollback'
    nodeId: string
    clientId: string
    catalogId: string
    catalogHash: string
    entryHash: string
    approval: ApprovalLevel
    /** 'owner:<principal>' after the owner's card „Ja“; 'policy:vertrauensleiter' for a standing permission
     * (trust.json). 'policy:erlauben' (pre-P9 YOLO path) is no longer issued, only still verified. */
    approvedBy: string
    /** Rollback tickets reference the install ticket whose recorded rollback is executed. */
    installTicketId?: string
    issuedAt: number
    expiresAt: number
}
export type SignedInstallTicket = SignedTicket<InstallTicket>

export const installTicketBytes = (ticket: InstallTicket): Buffer => ticketBytes(DOMAIN, ticket)

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
    if (!APPROVER.test(String(input.approvedBy || ''))) throw Error('Freigabe muss vom Owner oder einer Owner-Stufe stammen')
    if (input.approvedBy === 'policy:erlauben' && input.approval !== 'erlauben') throw Error('Automatische Freigabe nur für Stufe erlauben')
    const operation = input.operation || 'install'
    if (operation === 'rollback' && !TICKET_ID_PATTERN.test(String(input.installTicketId || ''))) throw Error('Rückweg braucht die Ticket-ID der Installation')
    return signTicket<InstallTicket>(DOMAIN, {
        operation, nodeId: String(input.nodeId), clientId: String(input.clientId),
        catalogId: entry.id, catalogHash: catalog.hash, entryHash: installEntryHash(entry),
        approval: input.approval, approvedBy: input.approvedBy,
        ...(operation === 'rollback' ? { installTicketId: input.installTicketId } : {}),
    }, privateKey, now)
}

export interface InstallTicketContext { nodeId: string; clientId: string; publicKey: string; catalog: InstallCatalog; now?: number }

const TICKET_KEYS = ['approval', 'approvedBy', 'catalogHash', 'catalogId', 'clientId', 'entryHash', 'expiresAt', 'id', 'issuedAt', 'nodeId', 'operation']

/** Host-side verification. Throws on anything but an exact, fresh, signed ticket for a catalog entry. */
export function verifyInstallTicket(signed: unknown, ctx: InstallTicketContext): InstallTicket {
    const t = verifyTicketEnvelope<InstallTicket>(DOMAIN, signed, {
        publicKey: ctx.publicKey, nodeId: ctx.nodeId, clientId: ctx.clientId, now: ctx.now,
        keys: payload => payload?.operation === 'rollback' ? [...TICKET_KEYS, 'installTicketId'] : TICKET_KEYS,
    })
    if (!['install', 'rollback'].includes(t.operation)) throw Error('Unbekannte Ticket-Operation')
    if (t.operation === 'rollback' && !TICKET_ID_PATTERN.test(String(t.installTicketId))) throw Error('Rückweg ohne Installations-Ticket')
    if (!isCatalogId(t.catalogId)) throw Error('Ungültige Katalog-ID')
    const entry = findCatalogEntry(t.catalogId, ctx.catalog)
    if (!entry) throw Error('Nicht im Katalog')
    if (t.entryHash !== installEntryHash(entry)) throw Error('Katalogeintrag hat sich geändert (Hash)')
    if (!['fragen', 'erlauben'].includes(t.approval)) throw Error('Ungültige Freigabestufe')
    if (!APPROVER.test(String(t.approvedBy))) throw Error('Freigabe nicht vom Owner')
    if (t.approvedBy === 'policy:erlauben' && t.approval !== 'erlauben') throw Error('Automatische Freigabe nur für Stufe erlauben')
    return t
}
