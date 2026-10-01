import { randomUUID, sign, verify } from 'node:crypto'
import { canonicalJson } from './install-catalog.js'

// ============================================================================
// Phase 8 (Alfred 01.10.2026): signed single-use ticket for ONE step of a vLLM
// model switch at the Spark. Issued by the Main's code after the owner's "Ja"
// on a `vllm-wechsel` card (the automatic way back is part of that approval),
// signed with the operator's ed25519 ticket key, short-lived, bound to node,
// client, plan, step and target. The target is a name from the closed list —
// never free text, never a command. Domain-separated from install tickets.
// ============================================================================

export const VLLM_TICKET_TTL_MS = 5 * 60_000
export const VLLM_TICKET_ID_PATTERN = /^vllm-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
/** Target names of spark-models.sh: lower-case letters, digits, '-' and '_' only (no shell characters, no paths). */
export const VLLM_TARGET_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const VLLM_PLAN_ID_PATTERN = /^v[a-f0-9]{12}$/
/** Default closed list (spark-models.sh, live read 01.10.2026). Config `routing.vllm.targets` may narrow or replace it. */
export const DEFAULT_VLLM_TARGETS: readonly string[] = Object.freeze(['coder', 'qwen27', 'qwen35', 'ornith', 'ornith15', 'flash', 'nano', 'nemotron'])

/** markieren = Wartungsmarke setzen · wechseln = spark-models.sh switch <ziel> (abgekoppelt) · freigeben = eigene Wartungsmarke entfernen */
export type VllmOperation = 'markieren' | 'wechseln' | 'freigeben'
export type VllmPurpose = 'wechsel' | 'rueckweg'
export const VLLM_OPERATIONS: readonly VllmOperation[] = Object.freeze(['markieren', 'wechseln', 'freigeben'])

export interface VllmTicket {
    id: string
    operation: VllmOperation
    purpose: VllmPurpose
    nodeId: string
    clientId: string
    planId: string
    target: string
    /** 'owner:<principal>' — the owner's "Ja" on the card. Never a model, never a policy. */
    approvedBy: string
    issuedAt: number
    expiresAt: number
}
export interface SignedVllmTicket { payload: VllmTicket; signature: string }

export const vllmTicketBytes = (ticket: VllmTicket): Buffer => Buffer.from(`xaventra-vllm-ticket:${canonicalJson(ticket)}`)

/** A target name is accepted only when it matches the pattern AND is on the closed list. */
export function isAllowedVllmTarget(value: unknown, targets: readonly string[]): value is string {
    return typeof value === 'string' && VLLM_TARGET_PATTERN.test(value) && targets.includes(value)
}

/** Closed list from config; invalid names are dropped, an empty/missing list falls back to the default. */
export function normalizeVllmTargets(raw: unknown): string[] {
    const list = Array.isArray(raw) ? [...new Set(raw.filter((item): item is string => typeof item === 'string' && VLLM_TARGET_PATTERN.test(item)))] : []
    return list.length ? list : [...DEFAULT_VLLM_TARGETS]
}

export interface IssueVllmTicketInput {
    operation: VllmOperation
    purpose: VllmPurpose
    nodeId: string
    clientId: string
    planId: string
    target: string
    approvedBy: string
    targets: readonly string[]
}

/** Code-side creation. No caller-supplied id or expiry; target only from the closed list. */
export function issueVllmTicket(input: IssueVllmTicketInput, privateKey: string, now = Date.now()): SignedVllmTicket {
    if (!VLLM_OPERATIONS.includes(input.operation)) throw Error('Unbekannter vLLM-Schritt')
    if (input.purpose !== 'wechsel' && input.purpose !== 'rueckweg') throw Error('Unbekannter Zweck')
    if (!isAllowedVllmTarget(input.target, input.targets)) throw Error('Ziel nicht auf der geschlossenen Liste')
    if (!VLLM_PLAN_ID_PATTERN.test(String(input.planId))) throw Error('Ungültige Plan-ID')
    if (!/^owner:[^\s]{1,120}$/.test(String(input.approvedBy || ''))) throw Error('Freigabe muss vom Owner stammen')
    if (!input.nodeId || !input.clientId) throw Error('Knoten und Client nötig')
    const payload: VllmTicket = {
        id: `vllm-${randomUUID()}`, operation: input.operation, purpose: input.purpose, nodeId: String(input.nodeId), clientId: String(input.clientId),
        planId: input.planId, target: input.target, approvedBy: input.approvedBy, issuedAt: now, expiresAt: now + VLLM_TICKET_TTL_MS,
    }
    return { payload, signature: sign(null, vllmTicketBytes(payload), privateKey).toString('base64') }
}

export interface VllmTicketContext { nodeId: string; clientId: string; publicKey: string; targets: readonly string[]; now?: number }
const TICKET_KEYS = ['approvedBy', 'clientId', 'expiresAt', 'id', 'issuedAt', 'nodeId', 'operation', 'planId', 'purpose', 'target']

/** Host-side verification. Throws on anything but an exact, fresh, signed ticket for a listed target. */
export function verifyVllmTicket(signed: unknown, ctx: VllmTicketContext): VllmTicket {
    const now = ctx.now ?? Date.now()
    const value = signed as SignedVllmTicket
    if (!value || typeof value !== 'object' || typeof value.signature !== 'string' || !value.payload || typeof value.payload !== 'object') throw Error('Ticket fehlt')
    if (Object.keys(value).sort().join(',') !== 'payload,signature') throw Error('Ticket hat unbekannte Felder')
    const t = value.payload
    if (Object.keys(t).sort().join(',') !== TICKET_KEYS.join(',')) throw Error('Ticket hat unbekannte oder fehlende Felder')
    if (!ctx.publicKey) throw Error('Kein Ticket-Schlüssel eingerichtet')
    let valid = false
    try { valid = verify(null, vllmTicketBytes(t), ctx.publicKey, Buffer.from(value.signature, 'base64')) } catch { valid = false }
    if (!valid) throw Error('Ticket-Signatur ungültig')
    if (!VLLM_TICKET_ID_PATTERN.test(t.id)) throw Error('Ticket-ID nicht vom Code erzeugt')
    if (!VLLM_OPERATIONS.includes(t.operation)) throw Error('Unbekannter vLLM-Schritt')
    if (t.purpose !== 'wechsel' && t.purpose !== 'rueckweg') throw Error('Unbekannter Zweck')
    if (t.nodeId !== ctx.nodeId || t.clientId !== ctx.clientId) throw Error('Ticket gilt für einen anderen Knoten')
    if (!VLLM_PLAN_ID_PATTERN.test(String(t.planId))) throw Error('Ungültige Plan-ID')
    if (!isAllowedVllmTarget(t.target, ctx.targets)) throw Error('Ziel nicht auf der geschlossenen Liste')
    if (!/^owner:[^\s]{1,120}$/.test(String(t.approvedBy))) throw Error('Freigabe nicht vom Owner')
    if (!Number.isSafeInteger(t.expiresAt) || !Number.isSafeInteger(t.issuedAt) || t.expiresAt <= now
        || t.expiresAt > now + VLLM_TICKET_TTL_MS || t.issuedAt > now + 30_000 || t.expiresAt - t.issuedAt > VLLM_TICKET_TTL_MS) throw Error('Ticket abgelaufen oder zu lange gültig')
    return t
}
