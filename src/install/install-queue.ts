import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findCatalogEntry, getInstallCatalog, isCatalogId, type ApprovalLevel, type InstallCatalog, type InstallCatalogEntry } from './install-catalog.js'
import { issueInstallTicket, TICKET_ID_PATTERN, type SignedInstallTicket } from './install-ticket.js'

// ============================================================================
// Stufe 2 (S2.2/S2.4): Main-side install queue. Proposals come from the scan,
// the owner or the model; only the owner (slash command, owner role) turns a
// queued proposal into a signed ticket. In YOLO mode an entry the owner has
// lifted to 'erlauben' is ticketed by code ('policy:erlauben'); nothing else.
// Workers never get a ticket: they receive an image-variant suggestion.
// ============================================================================

export type InstallPathKind = 'package-manager' | 'host-agent' | 'image' | 'none'
export interface InstallTargetNode {
    nodeId: string
    installPath: InstallPathKind
    role: 'main' | 'worker'
    local: boolean
    platform?: string
    arch?: string
    gpuVendor?: 'nvidia' | 'none'
    /** NAS: only models into the data volume, never system packages. */
    modelOnly?: boolean
    version?: string
}
export type InstallRoute =
    | { kind: 'host-agent' }
    | { kind: 'image'; variant: string; packages: string[]; suggestedTag: string }
    | { kind: 'model-volume'; model: string; note: string }
    | { kind: 'refused'; reason: string }

export type ProposalStatus = 'queued' | 'suggested' | 'refused' | 'running' | 'done' | 'failed' | 'rolled-back'
export interface InstallProposal {
    id: string
    catalogId: string
    nodeId: string
    route: InstallRoute
    status: ProposalStatus
    source: 'scan' | 'owner' | 'model' | 'yolo'
    createdAt: string
    updatedAt: string
    ticketId?: string
    rollbackTicketId?: string
    approvedBy?: string
    result?: { success: boolean; alreadyInstalled?: boolean; newPackages?: string[]; rollback?: unknown; error?: string; evidenceHash?: string; signed?: boolean; restored?: boolean }
}
export interface InstallApprover { permission: string; principalId: string; channel?: string; viaModel?: boolean }
export interface HostInstallClient {
    execute(ticket: SignedInstallTicket): Promise<any>
    rollback(ticket: SignedInstallTicket): Promise<any>
    status(ticketId: string): Promise<any>
}
export interface InstallQueueDeps {
    dataDir: string
    catalog?: InstallCatalog
    /** ed25519 private key of the Main's ticket signer (operator file, never in the repo). */
    ticketPrivateKey?: string
    hostNodeId?: string
    hostClientId?: string
    hostClient?: HostInstallClient
    now?: () => number
    pollIntervalMs?: number
    pollTimeoutMs?: number
}
export interface InstallResult { ok: boolean; message: string; proposal?: InstallProposal; completion?: Promise<InstallProposal> }

export const QUEUE_ID_PATTERN = /^iq-[a-f0-9]{12}$/
const NAS_PATTERN = /(^|[-_.])nas($|[-_.\d])/i

export function isModelOnlyNode(nodeId: string, configured: readonly string[] = []): boolean {
    return configured.includes(nodeId) || NAS_PATTERN.test(nodeId)
}

/** Where a catalog entry may go on a given node. Never apt in a container. */
export function planInstallRoute(entry: InstallCatalogEntry | undefined, target: InstallTargetNode): InstallRoute {
    if (!entry) return { kind: 'refused', reason: 'Nicht im Installationskatalog.' }
    if (target.modelOnly && entry.kind !== 'ollama-model') return { kind: 'refused', reason: 'NAS: nur Modelle ins Daten-Volume, keine Systempakete.' }
    if (target.installPath === 'image') {
        if (entry.kind === 'ollama-model') {
            return entry.targets.includes('model-volume')
                ? { kind: 'model-volume', model: entry.id.slice('ollama-model:'.length), note: 'Modell ins Daten-Volume des Workers (Ollama-Dienst dort). Stufe 2 führt auf Workern nichts aus.' }
                : { kind: 'refused', reason: 'Modell nicht für Daten-Volumes freigegeben.' }
        }
        if (!entry.image || !entry.targets.includes('image')) return { kind: 'refused', reason: 'Für Container-Worker gibt es dafür keine Image-Variante.' }
        const base = target.version && /^\d+\.\d+\.\d+$/.test(target.version) ? target.version : 'next'
        return { kind: 'image', variant: entry.image.variant, packages: [...entry.image.packages], suggestedTag: `${base}-${entry.image.variant}` }
    }
    if (target.installPath !== 'host-agent') return { kind: 'refused', reason: 'Kein freigegebener Installationsweg auf diesem Knoten (nur Host-Agent oder Image).' }
    if (!target.local) return { kind: 'refused', reason: 'Host-Agent-Installationen nur auf dem eigenen Knoten (lokaler Socket).' }
    if (!entry.targets.includes('host-agent')) return { kind: 'refused', reason: 'Eintrag ist nicht für den Host-Agenten bestimmt.' }
    const r = entry.requires || {}
    if (r.platform && target.platform && target.platform !== r.platform) return { kind: 'refused', reason: `Nur für ${r.platform}.` }
    if (r.arch && target.arch !== r.arch) return { kind: 'refused', reason: `Nur für ${r.arch}.` }
    if (r.gpuVendor && target.gpuVendor !== r.gpuVendor) return { kind: 'refused', reason: `Nur mit ${r.gpuVendor}-GPU.` }
    return { kind: 'host-agent' }
}

// ----------------------------------------------------------------------------
// persistence
// ----------------------------------------------------------------------------

function writeJson(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
}
const queuePath = (deps: InstallQueueDeps) => join(deps.dataDir, 'install-queue.json')
const policyPath = (deps: InstallQueueDeps) => join(deps.dataDir, 'install-policy.json')
const journalPath = (deps: InstallQueueDeps) => join(deps.dataDir, 'install-journal.jsonl')
const nowIso = (deps: InstallQueueDeps) => new Date((deps.now || Date.now)()).toISOString()

export function loadInstallQueue(deps: InstallQueueDeps): InstallProposal[] {
    try {
        const value = JSON.parse(readFileSync(queuePath(deps), 'utf8'))
        return Array.isArray(value?.items) ? value.items : []
    } catch { return [] }
}
function saveQueue(deps: InstallQueueDeps, items: InstallProposal[]): void {
    mkdirSync(deps.dataDir, { recursive: true })
    writeJson(queuePath(deps), { version: 1, items: items.slice(-200) })
}
function updateProposal(deps: InstallQueueDeps, id: string, patch: Partial<InstallProposal>): InstallProposal | undefined {
    const items = loadInstallQueue(deps)
    const index = items.findIndex(item => item.id === id)
    if (index < 0) return undefined
    items[index] = { ...items[index], ...patch, updatedAt: nowIso(deps) }
    saveQueue(deps, items)
    return items[index]
}
function journal(deps: InstallQueueDeps, event: string, data: Record<string, unknown>): void {
    try {
        mkdirSync(deps.dataDir, { recursive: true })
        appendFileSync(journalPath(deps), `${JSON.stringify({ at: nowIso(deps), event, ...data })}\n`, { mode: 0o600 })
    } catch { /* journal is evidence, never a reason to fail open */ }
}

export function loadInstallPolicy(deps: InstallQueueDeps): Record<string, ApprovalLevel> {
    try {
        const value = JSON.parse(readFileSync(policyPath(deps), 'utf8'))
        const out: Record<string, ApprovalLevel> = {}
        for (const [id, level] of Object.entries(value?.levels || {})) if (isCatalogId(id) && (level === 'erlauben' || level === 'fragen')) out[id] = level
        return out
    } catch { return {} }
}

export function approvalLevelFor(catalogId: string, deps: InstallQueueDeps): ApprovalLevel {
    const entry = findCatalogEntry(catalogId, deps.catalog || getInstallCatalog())
    if (!entry) return 'fragen'
    return loadInstallPolicy(deps)[catalogId] || entry.approval
}

const isOwner = (approver: InstallApprover) => approver?.permission === 'owner' && approver.viaModel !== true
    && typeof approver.principalId === 'string' && /^[^\s]{1,120}$/.test(approver.principalId)

/** Owner-only: lift an entry to 'erlauben' or set it back to 'fragen'. */
export function setApprovalLevel(catalogId: string, level: ApprovalLevel, approver: InstallApprover, deps: InstallQueueDeps): InstallResult {
    if (!isOwner(approver)) return { ok: false, message: 'Nur der Owner kann Freigabestufen ändern.' }
    if (level !== 'erlauben' && level !== 'fragen') return { ok: false, message: 'Stufe muss erlauben oder fragen sein.' }
    if (!findCatalogEntry(catalogId, deps.catalog || getInstallCatalog())) return { ok: false, message: 'Nicht im Installationskatalog (Nie-Liste-Einträge können nie aufgenommen werden).' }
    const levels = { ...loadInstallPolicy(deps), [catalogId]: level }
    mkdirSync(deps.dataDir, { recursive: true })
    writeJson(policyPath(deps), { version: 1, levels })
    journal(deps, 'policy', { catalogId, level, by: `owner:${approver.principalId}` })
    return { ok: true, message: `${catalogId}: Freigabestufe ${level}.` }
}

/** Proposal only. Anyone may propose a catalog id; nothing runs here. */
export function proposeCatalogInstall(catalogId: unknown, target: InstallTargetNode, deps: InstallQueueDeps, source: InstallProposal['source']): InstallResult {
    if (!isCatalogId(catalogId)) return { ok: false, message: 'Ungültige Katalog-ID.' }
    const entry = findCatalogEntry(catalogId, deps.catalog || getInstallCatalog())
    if (!entry) return { ok: false, message: `Nicht im Installationskatalog: ${catalogId}. Freie Befehle werden nicht ausgeführt.` }
    const items = loadInstallQueue(deps)
    const open = items.find(item => item.catalogId === entry.id && item.nodeId === target.nodeId && ['queued', 'suggested', 'running'].includes(item.status))
    if (open) return { ok: true, message: describeProposal(open), proposal: open }
    const route = planInstallRoute(entry, target)
    const proposal: InstallProposal = {
        id: `iq-${randomBytes(6).toString('hex')}`, catalogId: entry.id, nodeId: target.nodeId, route,
        status: route.kind === 'host-agent' ? 'queued' : route.kind === 'refused' ? 'refused' : 'suggested',
        source, createdAt: nowIso(deps), updatedAt: nowIso(deps),
    }
    saveQueue(deps, [...items, proposal])
    journal(deps, 'proposed', { id: proposal.id, catalogId: entry.id, nodeId: target.nodeId, route: route.kind, source })
    return { ok: proposal.status !== 'refused', message: describeProposal(proposal), proposal }
}

export function describeProposal(p: InstallProposal): string {
    switch (p.route.kind) {
        case 'host-agent':
            return p.status === 'queued'
                ? `${p.id}: ${p.catalogId} auf ${p.nodeId} wartet auf Freigabe. Owner: /setup approve ${p.id}`
                : `${p.id}: ${p.catalogId} auf ${p.nodeId} — ${p.status}${p.result?.error ? ` (${p.result.error})` : ''}`
        case 'image':
            return `${p.id}: ${p.catalogId} auf ${p.nodeId} nur über ein neues Image: Variante "${p.route.variant}" (Pakete ${p.route.packages.join(' ')}), Tag-Vorschlag ${p.route.suggestedTag}. Kein apt im laufenden Container.`
        case 'model-volume':
            return `${p.id}: Modell ${p.route.model} auf ${p.nodeId}: ${p.route.note}`
        default:
            return `${p.id}: ${p.catalogId} auf ${p.nodeId} abgelehnt — ${p.route.reason}`
    }
}

function summarize(receipt: any): InstallProposal['result'] {
    return {
        success: receipt?.success === true, alreadyInstalled: receipt?.alreadyInstalled === true,
        newPackages: Array.isArray(receipt?.newPackages) ? receipt.newPackages.slice(0, 100) : undefined,
        rollback: receipt?.rollback, error: typeof receipt?.error === 'string' ? receipt.error.slice(0, 250) : undefined,
        evidenceHash: typeof receipt?.evidenceHash === 'string' ? receipt.evidenceHash : undefined,
        signed: typeof receipt?.signature === 'string', restored: receipt?.restored,
    }
}

async function dispatch(proposal: InstallProposal, ticket: SignedInstallTicket, deps: InstallQueueDeps, operation: 'install' | 'rollback'): Promise<InstallResult> {
    const client = deps.hostClient!
    const ticketField = operation === 'install' ? { ticketId: ticket.payload.id } : { rollbackTicketId: ticket.payload.id }
    updateProposal(deps, proposal.id, { status: 'running', approvedBy: ticket.payload.approvedBy, ...ticketField })
    journal(deps, `${operation}-ticket`, { id: proposal.id, ticketId: ticket.payload.id, catalogId: proposal.catalogId, approvedBy: ticket.payload.approvedBy })
    let response: any
    try { response = operation === 'install' ? await client.execute(ticket) : await client.rollback(ticket) }
    catch { response = { success: false, error: 'Host-Agent nicht erreichbar' } }
    const settle = (receipt: any): InstallProposal => {
        const success = receipt?.success === true
        const status: ProposalStatus = operation === 'rollback' ? (success ? 'rolled-back' : 'failed') : (success ? 'done' : 'failed')
        journal(deps, `${operation}-receipt`, { id: proposal.id, ticketId: ticket.payload.id, success, evidenceHash: receipt?.evidenceHash, error: receipt?.error })
        return updateProposal(deps, proposal.id, { status, result: summarize(receipt) })!
    }
    if (!response?.success && !response?.accepted) {
        const failed = settle({ success: false, error: response?.error || 'Host-Agent lehnte ab' })
        return { ok: false, message: `${proposal.id}: abgelehnt — ${failed.result?.error}`, proposal: failed }
    }
    if (!response.accepted) {
        const settled = settle(response)
        return { ok: settled.status !== 'failed', message: describeProposal(settled), proposal: settled, completion: Promise.resolve(settled) }
    }
    const interval = deps.pollIntervalMs ?? 5_000, deadline = (deps.now || Date.now)() + (deps.pollTimeoutMs ?? 45 * 60_000)
    const completion = (async () => {
        while ((deps.now || Date.now)() < deadline) {
            await new Promise(resolve => setTimeout(resolve, interval))
            let state: any
            try { state = await client.status(ticket.payload.id) } catch { continue }
            if (state?.phase === 'completed' && state.receipt) return settle(state.receipt)
        }
        journal(deps, `${operation}-timeout`, { id: proposal.id, ticketId: ticket.payload.id })
        return updateProposal(deps, proposal.id, { status: 'failed', result: { success: false, error: 'Kein Ergebnis vom Host-Agenten (Zeitlimit); Betreiber prüft /v1/install/status.' } })!
    })()
    completion.catch(() => undefined)
    return { ok: true, message: `${proposal.id}: Ticket ${ticket.payload.id} angenommen, ${operation === 'install' ? 'Installation' : 'Rückweg'} läuft. Stand: /setup queue`, proposal: updateProposal(deps, proposal.id, {})!, completion }
}

function ticketDepsMissing(deps: InstallQueueDeps): string | null {
    if (!deps.ticketPrivateKey || !deps.hostNodeId || !deps.hostClientId || !deps.hostClient) return 'Host-Agent-Installation ist auf diesem Knoten nicht eingerichtet (Ticket-Schlüssel/Host-Agent fehlen).'
    return null
}

/** The only manual path to a ticket: owner role, queued proposal id generated by code. */
export async function approveQueuedInstall(queueId: unknown, approver: InstallApprover, deps: InstallQueueDeps): Promise<InstallResult> {
    if (!isOwner(approver)) return { ok: false, message: 'Freigabe nur durch den Owner (nicht durch das Modell).' }
    if (typeof queueId !== 'string' || !QUEUE_ID_PATTERN.test(queueId)) return { ok: false, message: 'Ungültige Warteschlangen-ID.' }
    const proposal = loadInstallQueue(deps).find(item => item.id === queueId)
    if (!proposal) return { ok: false, message: `Kein Vorschlag ${queueId} in der Warteschlange.` }
    if (proposal.route.kind !== 'host-agent') return { ok: false, message: describeProposal(proposal), proposal }
    if (proposal.status !== 'queued') return { ok: false, message: `${queueId} ist ${proposal.status}, nicht freigabebereit.`, proposal }
    const missing = ticketDepsMissing(deps)
    if (missing) return { ok: false, message: missing, proposal }
    const catalog = deps.catalog || getInstallCatalog()
    const ticket = issueInstallTicket({ nodeId: deps.hostNodeId!, clientId: deps.hostClientId!, catalogId: proposal.catalogId,
        approval: approvalLevelFor(proposal.catalogId, deps), approvedBy: `owner:${approver.principalId}` }, deps.ticketPrivateKey!, catalog, (deps.now || Date.now)())
    return dispatch(proposal, ticket, deps, 'install')
}

/** YOLO path: only entries the owner lifted to 'erlauben'. Everything else stays queued. */
export async function autoApproveIfAllowed(queueId: string, yolo: boolean, deps: InstallQueueDeps): Promise<InstallResult> {
    const proposal = loadInstallQueue(deps).find(item => item.id === queueId)
    if (!proposal) return { ok: false, message: 'Kein Vorschlag.' }
    if (!yolo || approvalLevelFor(proposal.catalogId, deps) !== 'erlauben') return { ok: false, message: describeProposal(proposal), proposal }
    if (proposal.route.kind !== 'host-agent' || proposal.status !== 'queued') return { ok: false, message: describeProposal(proposal), proposal }
    const missing = ticketDepsMissing(deps)
    if (missing) return { ok: false, message: missing, proposal }
    const ticket = issueInstallTicket({ nodeId: deps.hostNodeId!, clientId: deps.hostClientId!, catalogId: proposal.catalogId,
        approval: 'erlauben', approvedBy: 'policy:erlauben' }, deps.ticketPrivateKey!, deps.catalog || getInstallCatalog(), (deps.now || Date.now)())
    return dispatch(proposal, ticket, deps, 'install')
}

/** Owner-only rollback of a completed installation; the host executes its own recorded rollback. */
export async function rollbackQueuedInstall(queueId: unknown, approver: InstallApprover, deps: InstallQueueDeps): Promise<InstallResult> {
    if (!isOwner(approver)) return { ok: false, message: 'Rückweg nur durch den Owner.' }
    if (typeof queueId !== 'string' || !QUEUE_ID_PATTERN.test(queueId)) return { ok: false, message: 'Ungültige Warteschlangen-ID.' }
    const proposal = loadInstallQueue(deps).find(item => item.id === queueId)
    if (!proposal || proposal.status !== 'done' || !proposal.ticketId || !TICKET_ID_PATTERN.test(proposal.ticketId)) return { ok: false, message: 'Keine abgeschlossene Installation für diesen Rückweg.' }
    if (proposal.result?.alreadyInstalled) return { ok: false, message: 'War schon vorher installiert: kein Rückweg (nichts wurde geändert).' }
    const missing = ticketDepsMissing(deps)
    if (missing) return { ok: false, message: missing }
    const ticket = issueInstallTicket({ operation: 'rollback', nodeId: deps.hostNodeId!, clientId: deps.hostClientId!, catalogId: proposal.catalogId,
        approval: approvalLevelFor(proposal.catalogId, deps), approvedBy: `owner:${approver.principalId}`, installTicketId: proposal.ticketId }, deps.ticketPrivateKey!, deps.catalog || getInstallCatalog(), (deps.now || Date.now)())
    return dispatch(proposal, ticket, deps, 'rollback')
}

export function formatInstallQueue(deps: InstallQueueDeps): string {
    const items = loadInstallQueue(deps).slice(-20)
    if (!items.length) return 'Installations-Warteschlange leer.'
    return ['Installations-Warteschlange:', ...items.map(item => `- [${item.status}] ${describeProposal(item)}`)].join('\n')
}

export function formatInstallCatalog(deps: InstallQueueDeps): string {
    const catalog = deps.catalog || getInstallCatalog()
    const policy = loadInstallPolicy(deps)
    return [
        `Installationskatalog (Hash ${catalog.hash.slice(0, 12)}…, ${catalog.entries.length} Einträge${catalog.rejected.length ? `, ${catalog.rejected.length} abgelehnt` : ''})`,
        ...catalog.entries.map(entry => `- ${entry.id}: ${entry.title} | ${entry.sizeMb} MB | Risiko ${entry.risk} | Stufe ${policy[entry.id] || entry.approval} | Ziele ${entry.targets.join(', ')}`),
        '',
        'Vorschlagen: /setup install <id> · Freigeben: /setup approve <iq-…> · Stufe: /setup allow|ask <id> · Rückweg: /setup rollback <iq-…>',
    ].join('\n')
}

// ----------------------------------------------------------------------------
// production wiring (lazy, no side effects at import)
// ----------------------------------------------------------------------------

export function defaultInstallDeps(dataDir = join(process.cwd(), '.nova-data')): InstallQueueDeps {
    const deps: InstallQueueDeps = { dataDir }
    const keyFile = process.env.XAVENTRA_INSTALL_TICKET_KEY_FILE
    try { if (keyFile && existsSync(keyFile)) deps.ticketPrivateKey = readFileSync(keyFile, 'utf8') } catch { /* stays unset: approvals refused */ }
    deps.hostNodeId = process.env.XAVENTRA_HOST_AGENT_NODE_ID || undefined
    deps.hostClientId = process.env.XAVENTRA_HOST_AGENT_CLIENT_ID || undefined
    if (process.env.XAVENTRA_HOST_AGENT_SOCKET && process.env.XAVENTRA_HOST_AGENT_TOKEN_FILE) {
        deps.hostClient = {
            execute: async ticket => (await import('../host/docker-client.js')).callHostAgent('/v1/install/execute', { ticket }),
            rollback: async ticket => (await import('../host/docker-client.js')).callHostAgent('/v1/install/rollback', { ticket }),
            status: async ticketId => (await import('../host/docker-client.js')).callHostAgent('/v1/install/status', { ticketId }),
        }
    }
    return deps
}

/** The local node as an install target, from the Stufe-1 node profile. */
export async function resolveInstallTarget(nodeId?: string): Promise<InstallTargetNode | null> {
    const { collectNodeProfile } = await import('../core/node-profile.js')
    const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
    const localId = getLocalNodeId()
    const toTarget = (profile: any, id: string, local: boolean): InstallTargetNode => ({
        nodeId: id, installPath: profile.installPath, role: profile.role, local, platform: profile.platform, arch: profile.arch,
        gpuVendor: /nvidia/i.test(String(profile.gpu?.name || '')) ? 'nvidia' : 'none', modelOnly: isModelOnlyNode(id), version: profile.version,
    })
    if (!nodeId || nodeId === localId) return toTarget(await collectNodeProfile(), localId, true)
    const { getMeshPeerStates } = await import('../mesh/mesh-transport-runtime.js')
    const peer = Object.values(getMeshPeerStates()).find((item: any) => item.nodeId === nodeId) as any
    return peer?.profile ? toTarget(peer.profile, nodeId, false) : null
}
