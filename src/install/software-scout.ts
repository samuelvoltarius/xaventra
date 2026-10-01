/**
 * Phase 5b — Software-Scout: "welche Software/KI kann auf welchem Knoten laufen?"
 *
 * Pure part: candidate (src/install/software-candidates.ts) × node profile
 * (own + signed peer profiles, Stufe 1) → passt / passt nicht with a reason,
 * the best node per capability, and the capabilities missing in the whole
 * mesh. The overview (/software) is always available and only reads.
 *
 * Proposals (one thought per gap, stage `fragen`, via the Gedanken-Hub) only
 * when `autonomy.softwareScout.enabled` is literally `true`, only on the Main,
 * weekly and on profile change, debounced. The answer "Ja" goes only into the
 * existing Stufe-2 path (install queue → install card → signed ticket); a
 * candidate without a catalog id is only noted ("Katalogeintrag nötig").
 * This module installs, downloads and sends nothing.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { defaultOn } from '../core/autonomy-defaults.js'
import { getNovaDataDir } from '../core/data-root.js'
import { profileFingerprint, type NodeProfile } from '../core/node-profile.js'
import { findCatalogEntry, getInstallCatalog, type InstallCatalog } from './install-catalog.js'
import { isModelOnlyNode, planInstallRoute, type InstallTargetNode } from './install-queue.js'
import {
    CAPABILITY_LABEL, SOFTWARE_CAPABILITIES, getSoftwareCandidates,
    type SoftwareCandidate, type SoftwareCandidateCatalog, type SoftwareCapability,
} from './software-candidates.js'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ScoutNode {
    nodeId: string
    profile: NodeProfile
    /** The node this code runs on (host-agent installs only here). */
    local: boolean
    /** Heartbeat time of a peer (ms); stale peers are listed but not rated. */
    lastSeen?: number
    /** NAS: only models into the data volume, never system packages. */
    modelOnly?: boolean
    /** Optional measured load (local node): vLLM queue and GPU utilisation. */
    load?: { vllmWaiting?: number; gpuUtilPercent?: number }
}

export type FitStatus = 'passt' | 'passt-nicht' | 'vorhanden' | 'installiert'
export type FitRoute = 'host-agent' | 'image' | 'model-volume' | 'katalog-noetig' | 'keiner'

export interface FitResult {
    candidateId: string
    nodeId: string
    status: FitStatus
    route: FitRoute
    reasons: string[]
    notes: string[]
    freeMemGB: number | null
    freeDiskGB: number | null
    score: number
}

/** Free headroom next to vLLM on unified memory, in addition to the candidate's own need. */
export const VLLM_SIDE_RESERVE_GB = 8
export const STALE_PEER_MS = 10 * 60_000
const UNIFIED_GPU = /\b(GB10|GB200|GH200|Grace|Thor|Orin|Jetson)\b/i

// ---------------------------------------------------------------------------
// Reading the profile (only what Stufe 1 measured; nothing guessed)
// ---------------------------------------------------------------------------

/** Free RAM from the self-check ("NN % frei") × total RAM, or null. */
export function freeMemoryGB(profile: NodeProfile): number | null {
    const item = profile.selfCheck?.items?.find(entry => entry.id === 'memory')
    const match = item ? /(\d+(?:[.,]\d+)?)\s*%\s*frei/.exec(item.detail) : null
    if (!match || !(profile.ramGB > 0)) return null
    return Math.round(profile.ramGB * Number(match[1].replace(',', '.')) / 100 * 10) / 10
}

/** Free disk from the self-check ("NN GB frei"), data disk first, or null. */
export function freeDiskGB(profile: NodeProfile): number | null {
    const items = profile.selfCheck?.items || []
    for (const id of ['disk-data', 'disk-root']) {
        const item = items.find(entry => entry.id === id)
        const match = item ? /(\d+(?:[.,]\d+)?)\s*GB\s*frei/.exec(item.detail) : null
        if (match) return Number(match[1].replace(',', '.'))
    }
    return null
}

const services = (profile: NodeProfile) => Array.isArray(profile.services) ? profile.services : []
const hasNvidia = (profile: NodeProfile) => /nvidia/i.test(String(profile.gpu?.name || ''))
const isUnified = (profile: NodeProfile) => UNIFIED_GPU.test(String(profile.gpu?.name || ''))

/** Where a capability is already there. Running services only — installed-but-stopped is not "vorhanden".
 * Erkannt ≠ nutzbar: this is the detected state, not an end-to-end proof. */
export function capabilityPresence(profile: NodeProfile, capability: SoftwareCapability): string | null {
    const running = services(profile).filter(service => service.status === 'running')
    const byType: Partial<Record<SoftwareCapability, string[]>> = { stt: ['stt'], tts: ['tts'], vision: ['vlm'], embedding: ['embeddings'], llm: ['llm', 'vlm'] }
    const service = running.find(item => (byType[capability] || []).includes(item.type))
    if (service) return `${service.name} läuft`
    if (capability === 'llm' && profile.gpu?.viaVllm) return 'vLLM läuft'
    const byTool: Partial<Record<SoftwareCapability, string[]>> = { media: ['ffmpeg'], browser: ['playwright_browsers'], desktop: ['display'], tts: ['edge_tts'] }
    const tool = (byTool[capability] || []).find(name => profile.tools?.includes(name))
    if (tool) return tool === 'edge_tts' ? 'edge-tts (Online-Dienst)' : `${tool} vorhanden`
    return null
}

function installedOn(candidate: SoftwareCandidate, profile: NodeProfile): string | null {
    const tool = candidate.detect?.tools?.find(name => profile.tools?.includes(name))
    if (tool) return tool
    const service = services(profile).find(item => candidate.detect?.services?.includes(item.name))
    return service ? `${service.name} (${service.status})` : null
}

// ---------------------------------------------------------------------------
// Eignung: one candidate on one node (pure)
// ---------------------------------------------------------------------------

export function assessCandidate(candidate: SoftwareCandidate, node: ScoutNode, options: { installCatalog?: InstallCatalog } = {}): FitResult {
    const p = node.profile
    const freeMem = freeMemoryGB(p)
    const freeDisk = freeDiskGB(p)
    const result = (status: FitStatus, route: FitRoute, reasons: string[], notes: string[] = [], score = 0): FitResult =>
        ({ candidateId: candidate.id, nodeId: node.nodeId, status, route, reasons, notes, freeMemGB: freeMem, freeDiskGB: freeDisk, score })
    const no = (reason: string) => result('passt-nicht', 'keiner', [reason])

    const present = capabilityPresence(p, candidate.capability)
    if (present) return result('vorhanden', 'keiner', [`Fähigkeit schon vorhanden: ${present}`])
    const installed = installedOn(candidate, p)
    if (installed) return result('installiert', 'keiner', [`schon installiert: ${installed}`])

    if (!candidate.platforms.includes(p.platform as any)) return no(`nur ${candidate.platforms.join('/')} (Knoten: ${p.platform})`)
    if (!candidate.arches.includes(p.arch as any)) return no(`nur ${candidate.arches.join('/')} (Knoten: ${p.arch})`)
    if (node.modelOnly && candidate.kind !== 'model') return no('NAS: nur Modelle ins Daten-Volume, keine Systempakete oder Programme')
    if (candidate.roles && !candidate.roles.includes(p.role)) return no(`nur für ${candidate.roles.map(role => role === 'main' ? 'den Main' : 'Worker').join('/')}`)
    if (p.ramGB < candidate.minRamGB) return no(`zu wenig RAM (${p.ramGB} GB, nötig ${candidate.minRamGB} GB)`)
    if (candidate.requiresService === 'ollama' && !services(p).some(item => item.name === 'ollama')) return no('braucht Ollama (auf dem Knoten nicht gefunden)')

    const notes: string[] = []
    if (freeDisk === null) notes.push('freie Platte unbekannt (prüft die Installation)')
    else if (freeDisk < candidate.minDiskGB + 10) return no(`zu wenig Platte (${freeDisk} GB frei, nötig ${candidate.minDiskGB} GB + 10 GB Reserve)`)

    if (candidate.gpu === 'nvidia') {
        if (!hasNvidia(p)) return no('keine NVIDIA-GPU')
        if (!isUnified(p)) return no('GPU-Speicher steht nicht im Profil (diskrete GPU): nicht vorgeschlagen')
        if (p.gpu.viaVllm) {
            // STUFENPLAN Grenze 6 (OOM 13.09.): never heavy load next to vLLM, light load only without a bottleneck.
            if (candidate.heavy) return no('schwere GPU-Last nie neben laufendem vLLM')
            const memoryItem = p.selfCheck?.items?.find(item => item.id === 'memory')
            if (memoryItem && memoryItem.status !== 'ok') return no(`vLLM-Engpass: Arbeitsspeicher ${memoryItem.detail} — keine GPU-Last daneben`)
            if ((node.load?.vllmWaiting ?? 0) > 0) return no(`vLLM-Engpass: ${node.load!.vllmWaiting} Anfragen warten — keine GPU-Last daneben`)
            if ((node.load?.gpuUtilPercent ?? 0) >= 90) return no(`vLLM-Engpass: GPU ${node.load!.gpuUtilPercent} % ausgelastet — keine GPU-Last daneben`)
            if (freeMem === null) return no('freier GPU-Speicher neben vLLM unbekannt')
            const need = (candidate.minVramGB || 0) + VLLM_SIDE_RESERVE_GB
            if (freeMem < need) return no(`zu wenig freier GPU-Speicher neben vLLM (${freeMem} GB frei, nötig ${need} GB inkl. ${VLLM_SIDE_RESERVE_GB} GB Reserve)`)
            notes.push(`neben vLLM: ${freeMem} GB frei`)
        } else if (freeMem !== null && freeMem < (candidate.minVramGB || 0)) {
            return no(`zu wenig freier GPU-Speicher (${freeMem} GB frei, nötig ${candidate.minVramGB} GB)`)
        }
    }

    // Route: only the Stufe-2 catalog decides how something gets onto a node.
    const isContainer = p.runtime === 'container' || p.installPath === 'image'
    let route: FitRoute
    if (candidate.catalogId) {
        const entry = findCatalogEntry(candidate.catalogId, options.installCatalog || getInstallCatalog())
        const target: InstallTargetNode = {
            nodeId: node.nodeId, installPath: p.installPath, role: p.role, local: node.local, platform: p.platform, arch: p.arch,
            gpuVendor: hasNvidia(p) ? 'nvidia' : 'none', modelOnly: node.modelOnly, version: p.version,
        }
        const planned = planInstallRoute(entry, target)
        if (planned.kind === 'refused') return no(planned.reason)
        route = planned.kind
        if (planned.kind === 'image') notes.push(`Container: nur über ein neues Image (Variante ${planned.variant}, Tag-Vorschlag ${planned.suggestedTag}), kein apt im laufenden Container`)
        if (planned.kind === 'model-volume') notes.push('Modell ins Daten-Volume, Stufe 2 führt auf Workern nichts aus')
        if (planned.kind === 'host-agent' && p.rootReadOnly) notes.push('System schreibgeschützt: nur über den Host-Agenten')
    } else {
        route = 'katalog-noetig'
        notes.push(isContainer ? 'Katalogeintrag nötig; im Container nur über ein neues Image'
            : p.installPath === 'host-agent' ? 'Katalogeintrag nötig; System schreibgeschützt, dann nur über den Host-Agenten'
                : 'Katalogeintrag nötig')
    }

    // Best node: an existing catalog route beats "Katalogeintrag nötig"; GPU loads go to the GPU node
    // (only it fits); CPU loads rather not on the vLLM node; then the most free memory.
    let score = route === 'katalog-noetig' ? 100 : 1000
    if (route === 'host-agent') score += 50
    if (candidate.gpu === 'none' && p.gpu?.viaVllm) score -= 20
    score += Math.min(200, freeMem ?? p.ramGB / 2)
    return result('passt', route, [], notes, Math.round(score))
}

// ---------------------------------------------------------------------------
// Mesh: per capability vorhanden / passt / fehlt
// ---------------------------------------------------------------------------

export interface CapabilitySummary {
    capability: SoftwareCapability
    present: Array<{ nodeId: string; evidence: string }>
    fits: Array<{ candidate: SoftwareCandidate; fit: FitResult }>
    misfits: Array<{ candidate: SoftwareCandidate; fit: FitResult }>
    best: { candidate: SoftwareCandidate; fit: FitResult } | null
}
export interface MeshSoftwareAnalysis {
    nodes: Array<{ nodeId: string; rated: boolean; note?: string }>
    capabilities: CapabilitySummary[]
    fingerprint: string
}

const isFresh = (node: ScoutNode, now: number) => node.local || (typeof node.lastSeen === 'number' && now - node.lastSeen <= STALE_PEER_MS)

export function analyzeMesh(nodes: readonly ScoutNode[], options: { candidates?: SoftwareCandidateCatalog; installCatalog?: InstallCatalog; now?: number } = {}): MeshSoftwareAnalysis {
    const now = options.now ?? Date.now()
    const candidates = (options.candidates || getSoftwareCandidates()).entries
    const rated = nodes.filter(node => isFresh(node, now))
    const capabilities = SOFTWARE_CAPABILITIES.map((capability): CapabilitySummary => {
        const present = rated.flatMap(node => { const evidence = capabilityPresence(node.profile, capability); return evidence ? [{ nodeId: node.nodeId, evidence }] : [] })
        const fits: CapabilitySummary['fits'] = []
        const misfits: CapabilitySummary['misfits'] = []
        for (const candidate of candidates.filter(item => item.capability === capability)) {
            for (const node of rated) {
                const fit = assessCandidate(candidate, node, { installCatalog: options.installCatalog })
                if (fit.status === 'passt') fits.push({ candidate, fit })
                else if (fit.status === 'passt-nicht') misfits.push({ candidate, fit })
            }
        }
        const order = new Map(candidates.map((item, index) => [item.id, index]))
        const ranked = [...fits].sort((a, b) => {
            const routeA = a.fit.route === 'katalog-noetig' ? 1 : 0, routeB = b.fit.route === 'katalog-noetig' ? 1 : 0
            return routeA - routeB || order.get(a.candidate.id)! - order.get(b.candidate.id)! || b.fit.score - a.fit.score
        })
        return { capability, present, fits: ranked, misfits, best: present.length ? null : ranked[0] || null }
    })
    return {
        nodes: nodes.map(node => isFresh(node, now) ? { nodeId: node.nodeId, rated: true } : { nodeId: node.nodeId, rated: false, note: 'veraltet, nicht bewertet' }),
        capabilities,
        fingerprint: meshFingerprint(rated),
    }
}

/** Changes when a rated node's static facts or check statuses change (Stufe-1 fingerprint). */
export function meshFingerprint(nodes: readonly ScoutNode[]): string {
    const parts = [...nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(node => `${node.nodeId}:${profileFingerprint(node.profile)}`)
    return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// /software (always available, read-only)
// ---------------------------------------------------------------------------

const ROUTE_LABEL: Record<FitRoute, string> = {
    'host-agent': 'Katalog, Host-Agent', image: 'Katalog, nur neues Image', 'model-volume': 'Katalog, Daten-Volume', 'katalog-noetig': 'Katalogeintrag nötig', keiner: '–',
}
const gb = (value: number | null) => value === null ? '' : ` (${value} GB frei)`

export function formatSoftwareOverview(analysis: MeshSoftwareAnalysis, options: { proposalsEnabled: boolean }): string {
    const lines = [
        `*Software-Übersicht* (nur lesend, keine Installation) — Vorschläge: ${options.proposalsEnabled ? 'an' : 'aus (autonomy.softwareScout.enabled)'}`,
        `Knoten: ${analysis.nodes.map(node => node.rated ? node.nodeId : `${node.nodeId} (${node.note})`).join(', ') || 'keine'}`,
        'Erkannt ≠ nutzbar: "vorhanden" heißt erkannt, nicht Ende-zu-Ende geprüft.',
    ]
    for (const summary of analysis.capabilities) {
        lines.push('')
        if (summary.present.length) {
            lines.push(`✅ *${CAPABILITY_LABEL[summary.capability]}* — vorhanden: ${summary.present.map(item => `${item.nodeId} (${item.evidence})`).join(', ')}`)
            continue
        }
        lines.push(`${summary.fits.length ? '➕' : '❌'} *${CAPABILITY_LABEL[summary.capability]}* — fehlt`)
        for (const { candidate, fit } of summary.fits.slice(0, 3)) lines.push(`  passt: ${candidate.title} auf ${fit.nodeId}${gb(fit.freeMemGB)} · ${ROUTE_LABEL[fit.route]}`)
        const seen = new Set<string>()
        for (const { candidate, fit } of summary.misfits) {
            const key = `${candidate.id}:${fit.nodeId}`
            if (seen.has(key) || seen.size >= 4) continue
            seen.add(key)
            lines.push(`  passt nicht: ${candidate.title} auf ${fit.nodeId} — ${fit.reasons[0]}`)
        }
    }
    return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Gap thoughts (pure). The action is chosen by code: candidate id + node id.
// ---------------------------------------------------------------------------

export interface SoftwareScoutThought {
    kind: 'software-scout:luecke'
    capability: SoftwareCapability
    candidateId: string
    nodeId: string
    title: string
    text: string
    evidence: string[]
    proposal: string
    permission: 'fragen'
    dedupeKey: string
}

export const MAX_THOUGHTS_PER_RUN = 3

export function gapThoughts(analysis: MeshSoftwareAnalysis, max = MAX_THOUGHTS_PER_RUN): SoftwareScoutThought[] {
    const out: SoftwareScoutThought[] = []
    for (const summary of analysis.capabilities) {
        if (out.length >= max) break
        if (summary.present.length || !summary.best) continue
        const { candidate, fit } = summary.best
        const elsewhere = [...new Map(summary.misfits.filter(item => item.candidate.id === candidate.id && item.fit.nodeId !== fit.nodeId)
            .map(item => [item.fit.nodeId, item.fit])).values()].slice(0, 2)
        const where = elsewhere.map(item => `auf ${item.nodeId} ${item.reasons[0]}`).join(', ')
        const title = `${candidate.title} passt auf ${fit.nodeId}${gb(fit.freeMemGB)}${where ? `, ${where}` : ''}. Einrichten?`
        const proposal = candidate.catalogId
            ? `In die Installations-Warteschlange (Katalog ${candidate.catalogId}, ${ROUTE_LABEL[fit.route]}); Ausführung erst nach der Installations-Karte mit Ticket.`
            : 'Nur vermerken: Katalogeintrag nötig (keine freie Installation).'
        out.push({
            kind: 'software-scout:luecke', capability: summary.capability, candidateId: candidate.id, nodeId: fit.nodeId,
            title, text: `${CAPABILITY_LABEL[summary.capability]} fehlt im Mesh. ${candidate.benefit}`,
            evidence: [`Profil ${fit.nodeId}: ${fit.freeMemGB ?? '?'} GB RAM frei, ${fit.freeDiskGB ?? '?'} GB Platte frei`, ...fit.notes, ...elsewhere.map(item => `${item.nodeId}: ${item.reasons[0]}`)],
            proposal, permission: 'fragen', dedupeKey: `software-scout:${summary.capability}:${candidate.id}:${fit.nodeId}`,
        })
    }
    return out
}

// ---------------------------------------------------------------------------
// Settings + state + tick (Main only, default off)
// ---------------------------------------------------------------------------

export interface SoftwareScoutSettings { enabled: boolean }
export function parseSoftwareScoutSettings(raw: unknown, env: NodeJS.ProcessEnv = process.env): SoftwareScoutSettings {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    return { enabled: defaultOn(value.enabled, env) }
}

let settings: SoftwareScoutSettings = parseSoftwareScoutSettings(undefined)
/** Once from the daemon with `autonomy.softwareScout`. */
export function setSoftwareScoutConfig(raw: unknown): void { settings = parseSoftwareScoutSettings(raw) }
export function getSoftwareScoutSettings(): SoftwareScoutSettings { return settings }

export const SCOUT_INTERVAL_MS = 7 * 24 * 60 * 60_000
/** A profile change triggers a run, but not more often than this (flapping profiles). */
export const PROFILE_CHANGE_MIN_GAP_MS = 30 * 60_000
/** The same proposal again at most once per week; after "Nein" not for 30 days. */
export const PROPOSAL_DEDUPE_MS = 7 * 24 * 60 * 60_000
export const REJECT_MUTE_MS = 30 * 24 * 60 * 60_000

interface ScoutState { version: 1; lastRunAt?: number; fingerprint?: string; proposed: Record<string, number>; muted: Record<string, number> }
const statePath = (path?: string) => path || getNovaDataDir('software-scout', 'state.json')
function loadState(path?: string): ScoutState {
    try {
        const file = statePath(path)
        if (!existsSync(file)) return { version: 1, proposed: {}, muted: {} }
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        return { version: 1, lastRunAt: Number(raw.lastRunAt) || undefined, fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : undefined,
            proposed: raw.proposed && typeof raw.proposed === 'object' ? raw.proposed : {}, muted: raw.muted && typeof raw.muted === 'object' ? raw.muted : {} }
    } catch { return { version: 1, proposed: {}, muted: {} } }
}
function saveState(state: ScoutState, path?: string, now = Date.now()): void {
    const prune = (map: Record<string, number>, keep: number) => Object.fromEntries(Object.entries(map).filter(([, at]) => Number(at) > now - keep).slice(-500))
    const file = statePath(path)
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteJsonSync(file, { ...state, proposed: prune(state.proposed, PROPOSAL_DEDUPE_MS), muted: Object.fromEntries(Object.entries(state.muted).filter(([, until]) => Number(until) > now).slice(-500)) })
}

/** Called by the Gedanken-Hub after a button press: "Nein" mutes the same proposal for 30 days. */
export function recordSoftwareScoutAnswer(dedupeKey: string, answer: 'ja' | 'nein', options: { statePath?: string; now?: number } = {}): void {
    if (!/^software-scout:[a-z]+:[a-z0-9.-]{2,61}:[A-Za-z0-9._-]{1,80}$/.test(String(dedupeKey))) return
    const now = options.now ?? Date.now()
    const state = loadState(options.statePath)
    if (answer === 'nein') state.muted[dedupeKey] = now + REJECT_MUTE_MS
    try { saveState(state, options.statePath, now) } catch { /* next run */ }
}

export interface SoftwareScoutSink { emit(thought: SoftwareScoutThought): Promise<void> | void }

export interface SoftwareScoutTickDeps {
    isMain: boolean
    now?: number
    settings?: SoftwareScoutSettings
    nodes?: () => Promise<ScoutNode[]> | ScoutNode[]
    sink?: SoftwareScoutSink
    statePath?: string
    candidates?: SoftwareCandidateCatalog
    installCatalog?: InstallCatalog
}

export async function runSoftwareScoutTick(deps: SoftwareScoutTickDeps): Promise<{ ran: boolean; reason: string; emitted: SoftwareScoutThought[] }> {
    const active = deps.settings || settings
    if (!deps.isMain) return { ran: false, reason: 'kein Main (Worker schlagen nichts vor, senden nichts)', emitted: [] }
    if (!active.enabled) return { ran: false, reason: 'aus (autonomy.softwareScout.enabled=false)', emitted: [] }
    const now = deps.now ?? Date.now()
    const state = loadState(deps.statePath)
    const nodes = await (deps.nodes || (() => collectScoutNodes({ measureLoad: true })))()
    const analysis = analyzeMesh(nodes, { candidates: deps.candidates, installCatalog: deps.installCatalog, now })
    const weekly = !state.lastRunAt || now - state.lastRunAt >= SCOUT_INTERVAL_MS
    const changed = state.fingerprint !== analysis.fingerprint && (!state.lastRunAt || now - state.lastRunAt >= PROFILE_CHANGE_MIN_GAP_MS)
    if (!weekly && !changed) return { ran: false, reason: 'nicht fällig (wöchentlich oder bei Profiländerung)', emitted: [] }
    const sink = deps.sink || await defaultSink()
    const emitted: SoftwareScoutThought[] = []
    for (const thought of gapThoughts(analysis, Number.POSITIVE_INFINITY)) {
        if (emitted.length >= MAX_THOUGHTS_PER_RUN) break
        if ((state.muted[thought.dedupeKey] ?? 0) > now) continue
        if (now - (state.proposed[thought.dedupeKey] ?? 0) < PROPOSAL_DEDUPE_MS) continue
        await sink.emit(thought)
        state.proposed[thought.dedupeKey] = now
        emitted.push(thought)
    }
    state.lastRunAt = now
    state.fingerprint = analysis.fingerprint
    try { saveState(state, deps.statePath, now) } catch { /* next run */ }
    return { ran: true, reason: `${emitted.length} Vorschlag/Vorschläge (${weekly ? 'wöchentlich' : 'Profiländerung'})`, emitted }
}

async function defaultSink(): Promise<SoftwareScoutSink> {
    const { createSoftwareScoutThoughtSink } = await import('../core/thought-hub.js')
    return createSoftwareScoutThoughtSink()
}

// ---------------------------------------------------------------------------
// Production wiring: own profile + signed peer profiles (no SSH)
// ---------------------------------------------------------------------------

export async function collectScoutNodes(options: { measureLoad?: boolean } = {}): Promise<ScoutNode[]> {
    const { collectNodeProfile } = await import('../core/node-profile.js')
    const { getMeshPeerStates } = await import('../mesh/mesh-transport-runtime.js')
    const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
    const localId = getLocalNodeId()
    const local = await collectNodeProfile()
    const nodes: ScoutNode[] = [{ nodeId: localId, profile: { ...local, nodeId: localId }, local: true, modelOnly: isModelOnlyNode(localId) }]
    if (options.measureLoad && local.gpu?.viaVllm) {
        // Same measurement as Phase 3 (nvidia-smi, vLLM /metrics). Not measurable = no extra
        // signal; the memory check and the 8 GB reserve still apply, and Stufe 2 measures again.
        try {
            const { createDefaultLoadProbe } = await import('../thinking/ports.js')
            const { getThinkingSettings } = await import('../thinking/thinking-runtime.js')
            const sample = await createDefaultLoadProbe({ vllmMetricsUrl: getThinkingSettings().load.vllmMetricsUrl, samples: 2, spacingMs: 1_000 }).sample()
            if (sample.measured) nodes[0].load = { vllmWaiting: sample.vllmWaiting, gpuUtilPercent: sample.gpuUtilPercent }
        } catch { /* optional */ }
    }
    for (const peer of Object.values(getMeshPeerStates())) {
        if (!peer.nodeId || peer.nodeId === localId || !peer.profile) continue
        nodes.push({ nodeId: peer.nodeId, profile: peer.profile, local: false, lastSeen: peer.lastSeen, modelOnly: isModelOnlyNode(peer.nodeId) })
    }
    return nodes.sort((a, b) => Number(b.local) - Number(a.local) || a.nodeId.localeCompare(b.nodeId))
}

/** /software: always available, read-only. */
export async function formatSoftwareCommand(): Promise<string> {
    return formatSoftwareOverview(analyzeMesh(await collectScoutNodes()), { proposalsEnabled: settings.enabled })
}
