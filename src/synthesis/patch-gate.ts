/**
 * PATCH_GATE — the ONE check chain for applying a queued patch proposal
 * (P9 Gruppe 4). Every way in goes through `approvePatchProposal`:
 *   - the owner's „Ja“ on the patch Knopf-Karte (Telegram/Even G2, `ac:`),
 *   - the Desktop trust view (owner token + dashboard fencing on top).
 * `/patch approve <id>` only (re)sends the card; the old Telegram buttons
 * `patch_ok:`/`patch_no:` and the `self_evolve apply` parameter are refused.
 *
 * Chain (fixed order, fail closed):
 *   1. owner only (the caller's verified permission, never a model field);
 *   2. single flight per proposal: a second press/request while one runs is
 *      refused before any await — a double press never applies twice;
 *   3. live Main fencing (`verifyLiveServiceLeadership(MAIN_SERVICE)`);
 *   4. the proposal must still be `queued` (re-read from disk);
 *   5. the PATCH_GATE token, compared in constant time by the apply step
 *      (`approveEvolutionProposal` / `applyApprovedDoctorProposal`);
 *   6. state changes are written atomically (`markPatchProposal`); a source
 *      patch is persisted as `activation-pending` before dispatch.
 */
import { MAIN_SERVICE, verifyLiveServiceLeadership } from '../mesh/leader-election.js'

export type PatchGateCode = 'ok' | 'kein-owner' | 'kein-main' | 'unbekannt' | 'nicht-offen' | 'laeuft' | 'fehlgeschlagen'
export interface PatchGateApprover { permission: string; principalId: string }
export interface PatchGateResult {
    ok: boolean
    code: PatchGateCode
    message: string
    activationPending?: boolean
    rollbackPerformed?: boolean
    attemptId?: string
    error?: string
}

let liveMainCheck: () => Promise<boolean> = () => verifyLiveServiceLeadership(MAIN_SERVICE)
/** Tests only: replace the live Main fencing probe (null restores the default). */
export function setPatchGateLiveMainCheck(check: (() => Promise<boolean>) | null): void {
    liveMainCheck = check || (() => verifyLiveServiceLeadership(MAIN_SERVICE))
}

const inFlight = new Set<string>()
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/
const short = (value: unknown, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function isOwner(approver: PatchGateApprover | undefined): boolean {
    return approver?.permission === 'owner' && typeof approver.principalId === 'string' && /^[^\s]{1,160}$/.test(approver.principalId)
}

export async function approvePatchProposal(id: string, input: { approver: PatchGateApprover; token: string }): Promise<PatchGateResult> {
    if (!isOwner(input?.approver)) return { ok: false, code: 'kein-owner', message: 'Nur der Owner darf PATCH_GATE freigeben.' }
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { ok: false, code: 'unbekannt', message: 'Ungültige Patch-ID.' }
    // Synchronous claim before the first await: a concurrent second press is refused here.
    if (inFlight.has(id)) return { ok: false, code: 'laeuft', message: `Patch ${id} wird gerade angewendet — nicht doppelt.` }
    inFlight.add(id)
    try {
        let live = false
        try { live = await liveMainCheck() } catch { live = false }
        if (!live) return { ok: false, code: 'kein-main', message: 'Live-Main-Fencing fehlt — Patch nicht angewendet.' }
        const evolution = await import('./self-evolution.js')
        const proposal = evolution.getPatchProposals(500).find((item: any) => item?.id === id)
        if (!proposal) return { ok: false, code: 'unbekannt', message: `Patch-Vorschlag ${id} nicht gefunden.` }
        if (proposal.status !== 'queued') return { ok: false, code: 'nicht-offen', message: `Patch-Vorschlag ist bereits ${short(proposal.status, 40)}.` }
        if (proposal.kind === 'doctor-config') {
            // Claim on disk first (atomic, only from queued), so no other process applies it twice.
            if (!evolution.markPatchProposal(id, { status: 'applying', applyingAt: Date.now() }, 'queued')) {
                return { ok: false, code: 'nicht-offen', message: 'Patch-Vorschlag ist nicht mehr offen.' }
            }
            const { applyApprovedDoctorProposal } = await import('../doctor/safe-fixes.js')
            let applied: { applied: boolean; message: string }
            try { applied = await applyApprovedDoctorProposal(proposal, input.token) } catch (error) { applied = { applied: false, message: short((error as Error)?.message || error) } }
            evolution.markPatchProposal(id, applied.applied ? { status: 'applied', appliedAt: Date.now() } : { status: 'queued', applyingAt: undefined }, 'applying')
            return applied.applied
                ? { ok: true, code: 'ok', message: 'Config-Patch angewendet; Neustart und Live-Nachprüfung stehen aus.' }
                : { ok: false, code: 'fehlgeschlagen', message: `Config-Patch nicht angewendet: ${short(applied.message)}`, error: applied.message }
        }
        const result = await evolution.approveEvolutionProposal(id, input.token)
        if (result.activationPending) {
            return { ok: true, code: 'ok', activationPending: true, attemptId: result.attemptId, message: 'Aktivierung noch nicht abschließend verifiziert; /patch status zeigt den signierten Stand. Kein erneuter Deploy.' }
        }
        return result.success
            ? { ok: true, code: 'ok', attemptId: result.attemptId, message: 'Patch aktiviert; ursprünglicher Fehler unabhängig live nachgeprüft.' }
            : { ok: false, code: 'fehlgeschlagen', rollbackPerformed: result.rollbackPerformed, error: result.error,
                message: `Patch fehlgeschlagen: ${short(result.error || 'unbekannt')}${result.rollbackPerformed ? ' (Rollback durchgeführt)' : ''}` }
    } finally {
        inFlight.delete(id)
    }
}

/** „Nein“: owner only, atomic, only from queued. */
export async function rejectPatchProposal(id: string, approver: PatchGateApprover): Promise<PatchGateResult> {
    if (!isOwner(approver)) return { ok: false, code: 'kein-owner', message: 'Nur der Owner darf PATCH_GATE-Vorschläge ablehnen.' }
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { ok: false, code: 'unbekannt', message: 'Ungültige Patch-ID.' }
    if (inFlight.has(id)) return { ok: false, code: 'laeuft', message: `Patch ${id} wird gerade angewendet.` }
    const { markPatchProposal } = await import('./self-evolution.js')
    return markPatchProposal(id, { status: 'rejected', rejectedAt: Date.now() }, 'queued')
        ? { ok: true, code: 'ok', message: `Patch ${id} abgelehnt.` }
        : { ok: false, code: 'nicht-offen', message: 'Patch-Vorschlag nicht (mehr) offen.' }
}
