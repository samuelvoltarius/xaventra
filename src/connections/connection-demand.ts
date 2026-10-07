/**
 * 2.85 Paket A, Punkt 5 — Bedarfsregel für Verbindungen (wie Scout 2.84,
 * src/install/software-demand.ts):
 *
 *   nie gebraucht                 → keine Karte
 *   gefunden                      → still unter „Gefunden“ (connections-view.ts)
 *   Owner-Anfrage scheitert an der fehlenden Verbindung
 *                                 → genau dann EINE Frage („Home Assistant verbinden?“)
 *   ≥ 3 gleichartige Owner-Anfragen in 14 Tagen
 *                                 → EINE Frage („Google Kalender verbinden?“)
 *
 * Signals, only existing ones, fixed rules, no model:
 *  1. Outcome-Ledger: validated owner runs (`ownerKernelRun`) in which a tool of
 *     that service failed (manifest `bedarf.werkzeuge`, e.g. `hass_*`) — as the one
 *     need classification `classifyNeed` (software-demand.ts) decides: `dienst:<id>`.
 *  2. Werkzeug-Schmiede: a "fehlendes Werkzeug" need classified the same way.
 *  3. Owner requests (direct chat) with a service word (`bedarf.woerter`) while
 *     the service is not connected — stored as connector + time only.
 * A proposal is a thought with a button (Gedanken-Hub, Stufe fragen); its Ja is
 * the approval of the connection (connect-flow `connectFromApproval`). At most
 * one per service in 14 days; after „Nein“ 30 days quiet. Only the Main
 * proposes. Nothing here stores request text or user ids.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { connectedConnectorIds, verbindungsFrageKey, verbindungsFrageOffen } from './connection-state.js'
import { getNovaDataDir } from '../core/data-root.js'
import type { OutcomeRunView } from '../core/outcome-ledger.js'
import { ownerKernelRun } from '../core/validator-failure-escalation.js'
import { classifyNeed, registerServiceNeedRule, type NeedClassification, type ServiceNeedRule } from '../install/software-demand.js'
import { getConnectorCatalog, KATEGORIE_LABEL, type ConnectorManifest } from './connector-catalog.js'

export const DEMAND_WINDOW_MS = 14 * 24 * 60 * 60_000
export const REQUESTS_FOR_PROPOSAL = 3
const PROPOSAL_DEDUPE_MS = 14 * 24 * 60 * 60_000
const REJECT_MUTE_MS = 30 * 24 * 60 * 60_000

export type ConnectionDemandSource = 'owner-lauf' | 'schmiede' | 'anfrage'
export interface ConnectionDemandSignal { connectorId: string; source: ConnectionDemandSource; at: number; detail?: string }
export interface ConnectionNeed { connectorId: string; failures: number; requests: number; evidence: string[] }

interface StateFile { version: 1; signals: Array<{ connectorId: string; at: number }>; proposed: Record<string, number>; muted: Record<string, number> }

const statePathOf = (path?: string) => path || getNovaDataDir('connections', 'bedarf.json')
const within = (at: number, now: number) => Number.isFinite(at) && at <= now + 60_000 && now - at <= DEMAND_WINDOW_MS
const ID = /^[a-z][a-z0-9-]{1,39}$/

function readState(path?: string): StateFile {
    try {
        const file = statePathOf(path)
        if (!existsSync(file)) return { version: 1, signals: [], proposed: {}, muted: {} }
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        const signals = (Array.isArray(raw?.signals) ? raw.signals : []).filter((item: any) => ID.test(String(item?.connectorId)) && Number.isFinite(Number(item?.at)))
            .map((item: any) => ({ connectorId: String(item.connectorId), at: Number(item.at) }))
        const numbers = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value as Record<string, unknown> : {})
            .filter(([key, at]) => ID.test(key) && Number.isFinite(Number(at))).map(([key, at]) => [key, Number(at)]))
        return { version: 1, signals, proposed: numbers(raw?.proposed), muted: numbers(raw?.muted) }
    } catch { return { version: 1, signals: [], proposed: {}, muted: {} } }
}
function writeState(state: StateFile, path?: string): void {
    const file = statePathOf(path)
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteJsonSync(file, state)
}

function manifests(): ConnectorManifest[] { return getConnectorCatalog().entries }

function connectorForTool(name: string): string | null {
    const tool = String(name || '').toLowerCase()
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(tool)) return null
    for (const manifest of manifests()) if ((manifest.bedarf?.werkzeuge || []).some(prefix => tool.startsWith(prefix))) return manifest.name
    return null
}

/**
 * The one service rule (2.85 F ↔ A, „ein Bedarf, ein Empfänger“): a tool of a catalog service
 * (manifest `bedarf.werkzeuge`, e.g. `hass_*`) whose service is not connected means
 * „Verbindung fehlt“. Registered with `classifyNeed` (software-demand.ts), so Bug-Finder,
 * Schmiede and Scout leave it to „Verbindungen“; a failure while connected stays a tool fault.
 */
export function connectionServiceRule(options: { connected?: () => Set<string> } = {}): ServiceNeedRule {
    return toolName => {
        const connectorId = connectorForTool(toolName)
        if (!connectorId) return null
        let connected: Set<string>
        try { connected = (options.connected || defaultConnected)() } catch { connected = new Set() }
        return connected.has(connectorId) ? null : connectorId
    }
}
let unregisterRule: (() => void) | null = null
/** Exactly one connection rule is registered; docking again replaces it (connection-docks.ts). */
export function dockConnectionServiceRule(options: { connected?: () => Set<string> } = {}): () => void {
    unregisterRule?.()
    const off = registerServiceNeedRule(connectionServiceRule(options))
    unregisterRule = off
    return () => { off(); if (unregisterRule === off) unregisterRule = null }
}

type Classify = (toolName: unknown, errorText?: unknown) => NeedClassification
const serviceOf = (need: NeedClassification | undefined) =>
    need?.kind === 'dienst' && need.service && manifests().some(manifest => manifest.name === need.service) ? need.service : null

/** Signal 1: validated owner runs of the last 14 days that failed at a service tool (as `classifyNeed` decides). One run counts once per service. */
export function demandFromRuns(runs: readonly OutcomeRunView[], now = Date.now(), classify: Classify = classifyNeed): ConnectionDemandSignal[] {
    const out: ConnectionDemandSignal[] = []
    for (const run of runs) {
        if (!run || !ownerKernelRun(run)) continue
        const at = Date.parse(run.updatedAt)
        if (!within(at, now)) continue
        const seen = new Set<string>()
        for (const tool of run.tools || []) {
            if (tool?.success !== false) continue
            let need: NeedClassification | undefined
            try { need = classify(String(tool.toolName || ''), String(tool.result ?? tool.error ?? '').slice(0, 2_000)) } catch { need = undefined }
            const connectorId = serviceOf(need)
            if (!connectorId || seen.has(connectorId)) continue
            seen.add(connectorId)
            out.push({ connectorId, source: 'owner-lauf', at, detail: String(tool.toolName).slice(0, 60) })
        }
    }
    return out
}

/** Signal 2: forge needs "fehlendes Werkzeug" (tool name only), classified by the same place. */
export function demandFromForgeNeeds(needs: ReadonlyArray<{ tool: string; at: string }>, now = Date.now(), classify: Classify = classifyNeed): ConnectionDemandSignal[] {
    const out: ConnectionDemandSignal[] = []
    for (const need of needs) {
        let routed: NeedClassification | undefined
        try { routed = classify(String(need?.tool || ''), '') } catch { routed = undefined }
        const connectorId = serviceOf(routed)
        const at = Date.parse(String(need?.at || ''))
        if (connectorId && within(at, now)) out.push({ connectorId, source: 'schmiede', at, detail: String(need.tool).slice(0, 60) })
    }
    return out
}

const WORD = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, 'iu')

/** Services whose request words appear in an owner message (whole words only). */
export function matchRequestWords(text: string): string[] {
    const value = String(text || '').slice(0, 2000)
    return manifests().filter(manifest => (manifest.bedarf?.woerter || []).length && WORD(manifest.bedarf!.woerter!.join('|')).test(value)).map(manifest => manifest.name)
}

/** Default: connected = what the one connection truth calls „verbunden“ (connection-state.ts; configured HA included). */
function defaultConnected(): Set<string> {
    return connectedConnectorIds()
}

/** Signal 3: an owner request about a service that is not connected (connector + time only). Never throws. */
export function noteOwnerRequest(text: string, options: { statePath?: string; now?: number; connected?: () => Set<string> } = {}): string[] {
    try {
        const connected = (options.connected || defaultConnected)()
        const hits = matchRequestWords(text).filter(id => !connected.has(id))
        if (!hits.length) return []
        const now = options.now ?? Date.now()
        const state = readState(options.statePath)
        state.signals = [...state.signals.filter(item => now - item.at <= 2 * DEMAND_WINDOW_MS), ...hits.map(connectorId => ({ connectorId, at: now }))].slice(-400)
        writeState(state, options.statePath)
        return hits
    } catch { return [] }
}

/** Need per service from all signals (14 days). */
export function connectionDemand(options: { statePath?: string; now?: number; runs?: readonly OutcomeRunView[]; forgeNeeds?: ReadonlyArray<{ tool: string; at: string }> }): Map<string, ConnectionNeed> {
    const now = options.now ?? Date.now()
    const failures = [...demandFromRuns(options.runs || [], now), ...demandFromForgeNeeds(options.forgeNeeds || [], now)]
    const requests = readState(options.statePath).signals.filter(item => within(item.at, now))
    const out = new Map<string, ConnectionNeed>()
    const label = (id: string) => {
        const manifest = manifests().find(item => item.name === id)
        return manifest ? KATEGORIE_LABEL[manifest.kategorie] : id
    }
    for (const manifest of manifests()) {
        const id = manifest.name
        const failed = failures.filter(item => item.connectorId === id)
        const asked = requests.filter(item => item.connectorId === id)
        if (!failed.length && !asked.length) continue
        const evidence: string[] = []
        if (failed.length) evidence.push(`${failed.length}× Anfrage gescheitert, weil ${manifest.title} nicht verbunden ist (${[...new Set(failed.map(item => item.detail))].slice(0, 3).join(', ')})`)
        if (asked.length) evidence.push(`${asked.length}× nach ${label(id)} gefragt (14 Tage)`)
        out.set(id, { connectorId: id, failures: failed.length, requests: asked.length, evidence })
    }
    return out
}

export interface ConnectionProposal { kind: 'connect'; connectorId: string; title: string; text: string; proposal: string; dedupeKey: string; evidence: string[] }
export interface ConnectionDemandSink { emit(proposal: ConnectionProposal): void | Promise<void> }

export interface DemandTickDeps {
    isMain: boolean
    now?: number
    statePath?: string
    runs?: () => readonly OutcomeRunView[] | Promise<readonly OutcomeRunView[]>
    forgeNeeds?: () => ReadonlyArray<{ tool: string; at: string }> | Promise<ReadonlyArray<{ tool: string; at: string }>>
    connected?: () => Set<string>
    /** Services found on the network/in own accounts (evidence only; never a reason on its own). */
    found?: () => string[] | Promise<string[]>
    sink?: ConnectionDemandSink
    /** 2.89: is a question with this key already open (card or thought)? Default: connection-state `verbindungsFrageOffen`. */
    questionOpen?: (key: string) => boolean | Promise<boolean>
}

/** The rule: a failure → question; ≥3 requests in 14 days → question; found alone → nothing. */
export async function runConnectionDemandTick(deps: DemandTickDeps): Promise<{ emitted: ConnectionProposal[] }> {
    if (!deps.isMain) return { emitted: [] }
    const now = deps.now ?? Date.now()
    const runs = deps.runs ? await deps.runs() : await defaultRuns()
    const forgeNeeds = deps.forgeNeeds ? await deps.forgeNeeds() : await defaultForgeNeeds()
    const need = connectionDemand({ statePath: deps.statePath, now, runs, forgeNeeds })
    const connected = (deps.connected || defaultConnected)()
    const found = new Set(await (deps.found || (() => []))())
    const state = readState(deps.statePath)
    const sink = deps.sink || defaultSink()
    const emitted: ConnectionProposal[] = []
    for (const [id, item] of need) {
        if (connected.has(id)) continue
        if (!(item.failures >= 1 || item.requests >= REQUESTS_FOR_PROPOSAL)) continue
        if ((state.muted[id] ?? 0) > now || now - (state.proposed[id] ?? 0) < PROPOSAL_DEDUPE_MS) continue
        const manifest = manifests().find(entry => entry.name === id)!
        // A self-hosted service is only proposed from words when it was actually found here
        // (a failed owner request is enough on its own).
        if (manifest.findet?.geraet && !item.failures && !found.has(id)) continue
        // 2.89: one question per thing — the device card / „verbinden?“ card share this key.
        const dedupeKey = verbindungsFrageKey({ connectorId: id })
        if (await (deps.questionOpen || (key => verbindungsFrageOffen(key, { now })))(dedupeKey)) continue
        const proposal: ConnectionProposal = {
            kind: 'connect', connectorId: id, title: `${manifest.title} verbinden?`,
            text: `Damit ${manifest.wirkung.replace(/^kann dann /, 'kann ich dann ')}.`,
            proposal: `Verbinden? Ja richtet ${manifest.title} ein${manifest.auth_typ === 'oauth' || manifest.auth_typ === 'ha-login' ? '; danach einmal anmelden' : ''}.`,
            dedupeKey,
            evidence: [...item.evidence.map(text => `Bedarf: ${text}`), ...(found.has(id) ? [`${manifest.title} im Netz gefunden`] : [])],
        }
        await sink.emit(proposal)
        state.proposed[id] = now
        emitted.push(proposal)
    }
    if (emitted.length) writeState(state, deps.statePath)
    return { emitted }
}

/** Ja/Nein on a need thought: Nein = 30 days quiet for this service. */
export function recordConnectionAnswer(connectorId: string, answer: 'ja' | 'nein', options: { statePath?: string; now?: number } = {}): void {
    if (!ID.test(String(connectorId || ''))) return
    const now = options.now ?? Date.now()
    const state = readState(options.statePath)
    if (answer === 'nein') state.muted[connectorId] = now + REJECT_MUTE_MS
    try { writeState(state, options.statePath) } catch { /* next run */ }
}

async function defaultRuns(): Promise<readonly OutcomeRunView[]> {
    try { const { getOutcomeLedger } = await import('../core/outcome-ledger.js'); return getOutcomeLedger().listRuns(500) } catch { return [] }
}
async function defaultForgeNeeds(): Promise<ReadonlyArray<{ tool: string; at: string }>> {
    try { const { forgeMissingToolNeeds } = await import('../tools/skill-builder.js'); return forgeMissingToolNeeds() } catch { return [] }
}
function defaultSink(): ConnectionDemandSink {
    return {
        async emit(proposal) {
            const { createConnectionThought } = await import('../core/thought-hub.js')
            createConnectionThought(proposal)
        },
    }
}

// Wherever the connection need logic is loaded, its one rule is active (connection-docks.ts re-docks at start).
dockConnectionServiceRule()
