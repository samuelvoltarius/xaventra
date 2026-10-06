/**
 * 2.85 Paket D — the two Werkzeugkasten buttons, on existing paths only.
 *
 * - "Installieren": proposeCatalogInstall (catalog ids only, never-list checked at
 *   catalog load) → the install card (installCardInput/offerCard). The signed ticket
 *   is issued only by the owner's "Ja" on that card (approveQueuedInstall).
 * - "Entfernen": a card `install-rollback`; its "Ja" runs rollbackQueuedInstall
 *   (owner, signed rollback ticket, the host's recorded rollback). No standing
 *   permission for removing.
 *
 * Nothing here executes, downloads or installs.
 */
import type { ApprovalCard, CardStoreOptions } from '../core/approval-cards.js'
import { findCatalogEntry, getInstallCatalog, isCatalogId } from './install-catalog.js'
import { describeProposal, loadInstallQueue, proposeCatalogInstall, QUEUE_ID_PATTERN, type InstallQueueDeps, type InstallTargetNode } from './install-queue.js'

export interface ToolboxActionDeps {
    installDeps: InstallQueueDeps
    /** The local node as install target (host-agent installs only run there). */
    target: () => Promise<InstallTargetNode | null>
    cards?: CardStoreOptions & { deliverNow?: boolean }
}
export interface ToolboxActionResult { ok: boolean; message: string; card?: ApprovalCard }

export async function requestToolboxInstall(katalogId: unknown, deps: ToolboxActionDeps): Promise<ToolboxActionResult> {
    if (!isCatalogId(katalogId) || !findCatalogEntry(katalogId, deps.installDeps.catalog || getInstallCatalog())) {
        return { ok: false, message: 'Das steht nicht im geprüften Katalog — freie Befehle führe ich nicht aus.' }
    }
    const target = await deps.target().catch(() => null)
    if (!target) return { ok: false, message: 'Kein Profil für diesen Rechner — bitte später noch einmal.' }
    const proposed = proposeCatalogInstall(katalogId, target, deps.installDeps, 'owner')
    const item = proposed.proposal
    if (!proposed.ok || !item) return { ok: false, message: proposed.message }
    if (item.route.kind !== 'host-agent' || item.status !== 'queued') return { ok: item.status !== 'refused', message: describeProposal(item) }
    const { ensureBuiltinCardExecutors, installCardInput, offerCard } = await import('../core/approval-card-sources.js')
    await ensureBuiltinCardExecutors()
    // 2.86: the owner pressed the button just now — the card is a direct answer (question-queue.ts).
    const offered = offerCard({ ...installCardInput(item), direkteAntwort: true }, deps.cards)
    return offered.ok ? { ok: true, message: offered.message, card: offered.card } : { ok: false, message: offered.message }
}

export async function requestToolboxRemoval(queueId: unknown, deps: ToolboxActionDeps): Promise<ToolboxActionResult> {
    if (typeof queueId !== 'string' || !QUEUE_ID_PATTERN.test(queueId)) return { ok: false, message: 'Unbekannte Installation.' }
    const item = loadInstallQueue(deps.installDeps).find(entry => entry.id === queueId)
    if (!item || item.status !== 'done' || !item.ticketId) return { ok: false, message: 'Keine abgeschlossene Installation für diesen Rückweg.' }
    if (item.result?.alreadyInstalled) return { ok: false, message: 'War schon vorher installiert: kein Rückweg (nichts wurde geändert).' }
    const { ensureBuiltinCardExecutors, installRollbackCardInput, offerCard } = await import('../core/approval-card-sources.js')
    await ensureBuiltinCardExecutors()
    const offered = offerCard({ ...installRollbackCardInput(item), direkteAntwort: true }, deps.cards)
    return offered.ok ? { ok: true, message: offered.message, card: offered.card } : { ok: false, message: offered.message }
}

/** Production deps: the same data directory, ticket key and host agent as `/setup`. */
export async function defaultToolboxActionDeps(): Promise<ToolboxActionDeps> {
    const { defaultInstallDeps, resolveInstallTarget } = await import('./install-queue.js')
    return { installDeps: defaultInstallDeps(), target: () => resolveInstallTarget() }
}
