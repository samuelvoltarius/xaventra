/**
 * Owner approval gate for tools with external or physical effect (R2).
 *
 * One approval source: a one-time, principal-bound code from
 * core/setup-confirmation.ts that the owner requests himself with
 * `/freigabe <werkzeug> <detail>` and that the model passes back as the
 * `confirm` parameter. The code is always bound to the tool AND a concrete
 * detail (file, entity, host, argument hash …): a code for one call never
 * approves a different call of the same tool. Only the owner can approve.
 * Everything else fails closed.
 *
 * P9 (Doppelungen): the former second source, a server-side
 * `approvalGranted` flag in the execution context, was never set by any
 * code path (a card answer runs its own executor and never re-enters the
 * model loop), so it is gone instead of being half-wired.
 */
import { createHash, randomBytes } from 'node:crypto'

const DETAIL_MAX = 80
const HASHED_DETAIL = /^#[a-f0-9]{12}$/

/**
 * Canonical approval detail: whitespace collapsed; long or multi-line values
 * (code, argument objects) become `#<12 hex of sha256>`, so the owner can type
 * them. The same function runs on both sides (/freigabe and the tool).
 */
export function approvalDetail(raw: unknown): string {
    const text = (typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')).replace(/\s+/g, ' ').trim()
    if (HASHED_DETAIL.test(text)) return text
    if (text && text.length <= DETAIL_MAX && !/[\u0000-\u001f\u007f]/.test(text)) return text
    return `#${createHash('sha256').update(text).digest('hex').slice(0, 12)}`
}

/** Stable hash detail for structured arguments (key order does not matter); always `#<12 hex>`. */
export function approvalDetailOf(value: unknown): string {
    const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item as object).sort().map(key => [key, sort((item as any)[key])])) : item
    return `#${createHash('sha256').update(JSON.stringify(sort(value ?? null))).digest('hex').slice(0, 12)}`
}

/** Target of a one-time token; the detail is mandatory. */
export const toolApprovalTarget = (toolName: string, detail: string) => `tool:${toolName}:${approvalDetail(detail)}`

function clean(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

// ---------------------------------------------------------------------------
// 2.90.x „Freigaben merken“ (Alfred 29.10.: „Ich lege es pro Gerät fest: Bei
// jeder Freigabe gibt es einen Knopf ‚merken‘.“). A remembered approval is one
// exact target `tool:<werkzeug>:<detail>`, stored in the one permission store
// (`action-policy/trust.json`, section `gemerkt`), owner only, revocable with
// `/freigaben widerruf <id>`. Every use is audited (Outcome-Ledger, event
// `approval.recorded`, kind `gemerkte-freigabe`) and named in the tool result.
// The fixed limits below are code: no config, no owner command lifts them, and
// they are checked again on every use (a stored entry that hits one is inert).
// ---------------------------------------------------------------------------

const NEVER_REMEMBER_TOOLS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
    [/^hass_service$/, 'beliebiger Home-Assistant-Dienst (Daten gehören nicht zum Ziel)'],
    [/^(execute_python|ssh_command|nova_restart)$|shell|exec|python|script|restart|reboot|shutdown/, 'Code, Shell oder Neustart'],
    [/print|druck/, 'Drucken'],
    [/delete|remove|loesch|lösch|entfern|purge|wipe|destroy|rollback|uninstall/, 'Löschen'],
    [/pay|zahl|kauf|buy|purchase|order|bestell|ueberweis|überweis|geld|money|wallet|trade/, 'Geld'],
    [/send|mail|message|nachricht|whatsapp|telegram|sms|post|publish|veroeffentlich|veröffentlich|tweet|upload|notify/, 'Nachrichten an Dritte'],
    [/proxmox|pve|kube|k8s|cluster|qemu|lxc|docker|container|(^|_)vms?(_|$)/, 'Proxmox/Kubernetes'],
    [/panoptes|fahrzeug|vehicle|byd|dolphin|(^|_)(auto|car)(_|$)/, 'Auto/Panoptes'],
] as const)

const NEVER_REMEMBER_DETAILS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
    [/^(lock|cover|alarm_control_panel|siren)\./, 'Schlösser, Türen, Tore oder Alarmanlage'],
    [/(^|[^a-zäöü])(tor|tore|tuer|tür|door|gate|lock|schloss)([^a-zäöü]|$)|garage|einfahrt|haustuer|haustür|schliess|schließ|riegel/, 'Schlösser, Türen oder Tore'],
    [/alarm|sirene|siren/, 'Alarmanlage'],
    [/^(script|automation|notify)\./, 'Skripte, Automationen oder Benachrichtigungen'],
    [/panoptes|fahrzeug|vehicle|byd|dolphin|(^|[^a-z])(auto|car)([^a-z]|$)/, 'Auto/Panoptes'],
    [/print|drucker?(job|auftrag)|gcode/, 'Drucken'],
] as const)

/** null when this exact approval may be remembered, otherwise why never. */
export async function rememberRefusal(toolName: string, detail: string): Promise<string | null> {
    const tool = String(toolName || '').toLowerCase()
    const canonical = approvalDetail(detail)
    const value = canonical.toLowerCase()
    if (!/^[a-z][a-z0-9_-]{1,79}$/.test(tool) || !canonical) return 'ungültiges Ziel'
    // A `#<hash>` detail (long/structured arguments) hides what it targets: the
    // detail limits below could not see a lock or a gate behind it.
    if (canonical.startsWith('#')) return 'Inhalt nicht prüfbar (Hash)'
    const { isNieAktionsart, isNieZiel } = await import('../core/action-policy.js')
    if (isNieAktionsart(tool.replace(/_/g, '-')) || isNieZiel(canonical) || isNieZiel(`${tool} ${canonical}`)) return 'Nie-Liste'
    for (const [pattern, why] of NEVER_REMEMBER_TOOLS) if (pattern.test(tool)) return why
    for (const [pattern, why] of NEVER_REMEMBER_DETAILS) if (pattern.test(value)) return why
    return null
}

async function auditRemembered(item: { id: string; target: string }, extra: Record<string, unknown>): Promise<void> {
    try {
        const { OutcomeLedger } = await import('../core/outcome-ledger.js')
        const { getNovaDataDir } = await import('../core/data-root.js')
        new OutcomeLedger(getNovaDataDir('outcome-ledger', 'decisions'), false)
            .recordApproval(String(extra.runId || `gemerkte-freigabe-${item.id}`), { kind: 'gemerkte-freigabe', id: item.id, target: item.target, at: new Date().toISOString(), ...extra })
    } catch (error) {
        console.warn(`[Freigaben] Audit nicht schreibbar: ${String((error as Error)?.message || error).slice(0, 160)}`)
    }
}

async function useRememberedApproval(toolName: string, target: string, who: { authUserId: string; channel: string; runId: string }, context: { approvalNotes?: string[] }): Promise<boolean> {
    const { findRememberedApproval, noteRememberedUse } = await import('../core/action-policy.js')
    const item = findRememberedApproval(target)
    if (!item || item.tool !== toolName) return false
    const never = await rememberRefusal(item.tool, item.detail)
    if (never) {
        await auditRemembered(item, { event: 'gesperrt', grund: never, ...who })
        return false
    }
    noteRememberedUse(item.id)
    await auditRemembered(item, { event: 'genutzt', ...who })
    const note = `📌 gemerkte Freigabe [${item.id}] für ${item.target} — ohne Code ausgeführt (widerrufen: /freigaben widerruf ${item.id})`
    if (Array.isArray(context.approvalNotes)) context.approvalNotes.push(note)
    return true
}

/** Owner remembers exactly this approval. The caller checked the owner. */
export async function rememberToolApproval(toolName: string, detail: string, by: string): Promise<{ ok: boolean; message: string; id?: string }> {
    const tool = String(toolName || '').trim()
    const canonical = approvalDetail(detail)
    const never = await rememberRefusal(tool, canonical)
    if (never) return { ok: false, message: `🔒 Nicht merkbar (${never}): ${toolApprovalTarget(tool, canonical)} braucht jedes Mal einen Einmal-Code.` }
    const { rememberApproval } = await import('../core/action-policy.js')
    const result = rememberApproval({ target: toolApprovalTarget(tool, canonical), tool, detail: canonical, by })
    if (result.ok && result.item) await auditRemembered(result.item, { event: 'gemerkt', by })
    return result.ok && result.item
        ? { ok: true, id: result.item.id, message: `📌 ${result.message} — dieser Aufruf braucht ab jetzt keinen Code mehr. Liste: /freigaben · widerrufen: /freigaben widerruf ${result.item.id}` }
        : { ok: false, message: `❌ ${result.message}` }
}

/** Owner revokes a remembered approval. */
export async function forgetToolApproval(id: string, by: string): Promise<string> {
    const { forgetApproval } = await import('../core/action-policy.js')
    const result = forgetApproval(String(id || '').trim())
    if (result.ok && result.item) await auditRemembered(result.item, { event: 'widerrufen', by })
    return result.ok ? `🔓 ${result.message}` : `❌ ${result.message}`
}

/** `/freigaben` text: every remembered approval with its id, uses and last use. */
export async function formatRememberedApprovals(): Promise<string> {
    const { rememberedApprovals } = await import('../core/action-policy.js')
    const items = rememberedApprovals()
    if (!items.length) return 'Keine gemerkten Freigaben. Bei /freigabe <werkzeug> <detail> gibt es den Knopf „📌 merken“.'
    const lines = [`Gemerkte Freigaben (${items.length}) — gelten ohne Einmal-Code, nur für dich:`]
    for (const item of items) {
        const never = await rememberRefusal(item.tool, item.detail)
        lines.push(`- [${item.id}] ${item.target} · seit ${item.grantedAt.slice(0, 10)} · ${item.uses}× genutzt${item.lastUsedAt ? ` (zuletzt ${item.lastUsedAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}${never ? ` · gesperrt: ${never}` : ''}`)
    }
    lines.push('Widerrufen: /freigaben widerruf <id>')
    return lines.join('\n')
}

// One-time „merken“ buttons (Telegram `fm:<16 hex>`): server-generated, bound to
// the owner principal and the exact target, single use, 30 min.
const REMEMBER_OFFER_TTL_MS = 30 * 60_000
const rememberOffers = new Map<string, { principal: string; tool: string; detail: string; expiresAt: number }>()
export const REMEMBER_CALLBACK_PREFIX = 'fm:'

export async function issueRememberOffer(principal: string, toolName: string, detail: string): Promise<string | null> {
    if (await rememberRefusal(toolName, detail)) return null
    const now = Date.now()
    for (const [token, offer] of rememberOffers) if (offer.expiresAt <= now) rememberOffers.delete(token)
    const token = randomBytes(8).toString('hex')
    rememberOffers.set(token, { principal, tool: toolName, detail: approvalDetail(detail), expiresAt: now + REMEMBER_OFFER_TTL_MS })
    return `${REMEMBER_CALLBACK_PREFIX}${token}`
}

/** A press of „📌 merken“: the presser must be the principal the offer was made for. */
export async function pressRememberOffer(data: string, principal: string, by: string): Promise<string> {
    const token = String(data || '').startsWith(REMEMBER_CALLBACK_PREFIX) ? String(data).slice(REMEMBER_CALLBACK_PREFIX.length) : ''
    const offer = /^[a-f0-9]{16}$/.test(token) ? rememberOffers.get(token) : undefined
    if (!offer || offer.expiresAt <= Date.now()) { if (offer) rememberOffers.delete(token); return '❌ Dieser Merken-Knopf ist abgelaufen — /freigabe erneut senden.' }
    if (offer.principal !== principal) return '🔒 Nur der Owner, der die Freigabe angefordert hat, kann sie merken.'
    rememberOffers.delete(token)
    return (await rememberToolApproval(offer.tool, offer.detail, by)).message
}

/**
 * Returns null when the call is approved, otherwise a refusal message.
 * The identity comes from the execution context, falling back to the
 * runner-injected authorizationUserId/channel, never from other model fields.
 */
export async function ownerApprovalRefusal(params: Record<string, unknown>, toolName: string, detail: string): Promise<string | null> {
    try {
        if (typeof detail !== 'string' || !detail.trim()) return `❌ ${toolName}: Freigabe ohne Detail ist nicht möglich — nicht ausgeführt.`
        const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const context = getExecutionPolicyContext()
        const authUserId = clean(context.authUserId) || clean(params.authorizationUserId)
        const channel = clean(context.channel) || clean(params.channel)
        if (!authUserId) return `❌ ${toolName}: kein authentifizierter Auftraggeber — nicht ausgeführt.`
        const { getUserPermission } = await import('../users/multi-user-middleware.js')
        if (getUserPermission(authUserId, channel || undefined) !== 'owner') {
            return `❌ ${toolName}: nur der Owner darf das freigeben — nicht ausgeführt.`
        }
        const { consumeSetupConfirmation, setupConfirmationPrincipal, findLiveSetupConfirmation, noteToolApprovalRequest } = await import('../core/setup-confirmation.js')
        const principal = setupConfirmationPrincipal(channel, clean(context.userId) || clean(params.userId) || authUserId)
        const target = toolApprovalTarget(toolName, detail)
        if (consumeSetupConfirmation(principal, target, params.confirm)) return null
        // 2.90.x „merken“: a remembered approval for exactly this target, checked against the fixed limits on every use.
        if (await useRememberedApproval(toolName, target, { authUserId, channel, runId: clean(context.runId) }, context)) return null
        // 2.90.2: the owner's next message (the detail or the code) must offer this tool again.
        noteToolApprovalRequest(target)
        // 2.89.4: when a code is already open, ask for THAT code — never re-send /freigabe.
        const live = findLiveSetupConfirmation(principal, target)
        if (live) {
            return `❌ ${toolName}: ein Einmal-Code für genau diesen Aufruf ist noch offen (5 min). Sage dem Owner: „Schick mir jetzt den Code von der /freigabe-Zeile.“ Erneutes /freigabe erzeugt denselben Code. Codes niemals selbst bilden — nicht ausgeführt.`
        }
        return `❌ ${toolName} braucht eine ausdrückliche Freigabe des Owners für genau diesen Aufruf. Der Owner sendet selbst „/freigabe ${toolName} ${approvalDetail(detail)}“ und nennt danach den Einmal-Code in der nächsten Nachricht (nicht nochmal die /freigabe-Zeile). Codes niemals selbst bilden — nicht ausgeführt.`
    } catch (error) {
        return `❌ ${toolName}: Freigabe konnte nicht geprüft werden (${String(error).slice(0, 120)}) — nicht ausgeführt.`
    }
}
