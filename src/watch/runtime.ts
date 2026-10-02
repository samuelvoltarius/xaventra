/**
 * Wächter (Phase 7) — production wiring. 2.82.0 „ein Wächter“: die einzige
 * Ziel- und Messlogik. Aktiv, sobald etwas zu bewachen ist:
 *   - `autonomy.watch.enabled=true` (Messverlauf, Prognosen, Config-Ziele), oder
 *   - eigene Ziele (/monitor, übernommene L19-Ziele, watch/targets.ts), oder
 *   - die Nachtwache (`autonomy.nightwatch.enabled`; der Wächter führt sie aus), oder
 *   - 2.85: selbst abgeleitete Ziele (watch/derived.ts: Mesh-Knoten, gefundene
 *     Geräte, laufende KI-Dienste, Virtualisierungs-Host) — ohne Config, ohne Befehl. Ist
 *     beim Start noch nichts abzuleiten, prüft er alle 15 min erneut.
 *
 * Main (autonomy authority): engine tick as planner job `sys-waechter`; the
 * daemon starts the Wächter AFTER the planner, so the timer is only the
 * fallback when the planner is switched off. Worker: only measures and sends
 * a sample every 5 min inside its signed `node.capabilities` envelope.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { deriveWatchTargets, derivedSourcesFrom, EMPTY_DERIVED, type DerivedResult } from './derived.js'
import { buildWatchOverview, createWatchEngine, formatWaechter, formatWatchStatusLines, type WatchOverview, type WatchPeerHeartbeat, type WatchTickResult } from './engine.js'
import { acceptPeerWatchSample } from './peer.js'
import { defaultWatchProbeDeps } from './probes.js'
import { collectWatchSample, shouldPublishWatchSample, type WatchSample, type WatchService } from './sample.js'
import { parseWatchSettings, type WatchSettings } from './settings.js'
import { loadManagedTargets } from './targets.js'

export interface WatchNightwatchOptions { enabled: boolean; configPath: string; journalDir: string }

let settings: WatchSettings = parseWatchSettings(undefined)
let nightwatch: WatchNightwatchOptions | null = null
let engine: ReturnType<typeof createWatchEngine> | null = null
let timer: ReturnType<typeof setInterval> | null = null
let lastStartOptions: { nodeOnly: boolean } | null = null
let runningVia: 'Planer' | 'Timer' | null = null
let lastPublishedAt: number | null = null
const lastAccepted = new Map<string, number>()
let lastDerived: DerivedResult = EMPTY_DERIVED
let peerReader: (() => WatchPeerHeartbeat[]) | null = null
let recheckTimer: ReturnType<typeof setInterval> | null = null
const RECHECK_MS = 15 * 60_000

export const watchDir = () => getNovaDataDir('watch')

/** Called once by the daemon with `config.autonomy` and the Nachtwache paths. */
export function setWatchConfig(autonomy: unknown, options: { nightwatch?: WatchNightwatchOptions } = {}): WatchSettings {
    settings = parseWatchSettings(autonomy)
    nightwatch = options.nightwatch?.enabled ? options.nightwatch : null
    return settings
}
export function getWatchSettings(): WatchSettings { return settings }

/** Why the Wächter runs (or not). */
export function watchActivation(): { active: boolean; reason: string } {
    const reasons: string[] = []
    if (settings.enabled) reasons.push('autonomy.watch.enabled')
    const managed = loadManagedTargets(watchDir()).targets.length
    if (managed > 0) reasons.push(`${managed} eigene Ziele (/monitor)`)
    if (nightwatch?.enabled) reasons.push('Nachtwache')
    if (settings.selfDerive && lastDerived.targets.length) reasons.push(`${lastDerived.targets.length} selbst abgeleitete Ziele`)
    return reasons.length ? { active: true, reason: reasons.join(', ') } : { active: false, reason: 'nichts zu bewachen (autonomy.watch.enabled=false, keine /monitor-Ziele, Nachtwache aus, nichts selbst abzuleiten)' }
}

/**
 * 2.85: the self-derived targets from what the modules already know (mesh
 * config peers and registry, found devices, the last AI scan, the virtualisation host). Read
 * only, no network; recomputed every round.
 */
export async function collectDerivedTargets(): Promise<DerivedResult> {
    if (!settings.selfDerive) { lastDerived = EMPTY_DERIVED; return lastDerived }
    try {
        const [{ getLocalNodeId, loadMeshData }, { listDerivableDevices }, { getLastScanResult }, { resolveConfigPath }] = await Promise.all([
            import('../mesh/mesh-registry.js'), import('../sensing/runtime.js'), import('../mesh/ai-scanner.js'), import('../config/config-path.js'),
        ])
        let config: unknown = {}
        try { config = JSON.parse(readFileSync(resolveConfigPath(), 'utf8')) } catch { config = {} }
        const sources = derivedSourcesFrom({
            localNodeId: getLocalNodeId(), config, registryNodes: loadMeshData().nodes,
            devices: listDerivableDevices(), scanServices: getLastScanResult()?.services ?? [],
        })
        lastDerived = deriveWatchTargets(sources, { removed: loadManagedTargets(watchDir()).removedDerived, includeDevices: settings.includeDevices })
    } catch { lastDerived = EMPTY_DERIVED }
    return lastDerived
}

/** Peers' signed heartbeat values for the overview (no new connection). */
async function preparePeerReader(): Promise<void> {
    try {
        const { getMeshPeerStates } = await import('../mesh/mesh-transport-runtime.js')
        peerReader = () => Object.values(getMeshPeerStates()).map(peer => ({
            nodeId: peer.nodeId, lastSeen: peer.lastSeen,
            hardware: ((peer.capabilities as { hardware?: Record<string, unknown> } | undefined)?.hardware) ?? null,
        }))
    } catch { peerReader = null }
}

const effectiveSettings = (): WatchSettings => ({ ...settings, enabled: watchActivation().active })

async function isMain(): Promise<boolean> {
    if (process.env.NOVA_NODE_ONLY === 'true') return false
    const { hasGlobalAutonomyAuthority } = await import('../core/autonomy-authority.js')
    return hasGlobalAutonomyAuthority()
}

async function localServices(): Promise<() => WatchService[]> {
    try {
        const { getLocalNodeSnapshot } = await import('../mesh/mesh-registry.js')
        const { sanitizeNodeServices } = await import('../core/node-profile.js')
        return () => sanitizeNodeServices(getLocalNodeSnapshot()?.software?.ai_services || []).map(service => ({ name: `${service.name} (${service.type})`, status: service.status }))
    } catch { return () => [] }
}

async function localNodeId(): Promise<string> {
    const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
    return getLocalNodeId()
}

async function collectLocal(): Promise<WatchSample> {
    return collectWatchSample({ nodeId: await localNodeId(), mounts: settings.mounts, dataDir: getNovaDataDir(), services: await localServices() })
}

export async function startWatch(options: { nodeOnly: boolean }): Promise<{ started: boolean; reason: string }> {
    stopWatch()
    lastStartOptions = options
    if (!options.nodeOnly) await collectDerivedTargets()
    const activation = watchActivation()
    if (!activation.active) {
        // 2.85: nothing yet — look again later (devices, scans and peers appear after the start).
        if (!options.nodeOnly && settings.selfDerive) {
            recheckTimer = setInterval(() => {
                void collectDerivedTargets().then(derived => { if (derived.targets.length) void startWatch(options) }).catch(() => undefined)
            }, RECHECK_MS)
            recheckTimer.unref?.()
        }
        return { started: false, reason: activation.reason }
    }
    if (options.nodeOnly) return { started: false, reason: 'Mesh-Worker: sendet nur Messwerte (alle 5 min über das signierte Mesh)' }
    await preparePeerReader()
    const { addThought, setThoughtStatus } = await import('../planner/index.js')
    const { rememberWatchAction } = await import('../core/thought-hub.js')
    const { listWatchableDevices } = await import('../sensing/runtime.js')
    const runNightwatch = nightwatch
        ? (await import('../doctor/nightwatch.js')).createNightwatchRunner({ configPath: nightwatch.configPath, journalDir: nightwatch.journalDir })
        : undefined
    let mainNow = false
    engine = createWatchEngine({
        settings: { ...settings, enabled: true },
        watchDir: watchDir(),
        localNodeId: await localNodeId(),
        isMain: () => mainNow,
        collect: collectLocal,
        devices: () => listWatchableDevices(),
        managedTargets: () => loadManagedTargets(watchDir()).targets,
        derivedTargets: () => collectDerivedTargets(),
        nightwatch: runNightwatch,
        probes: defaultWatchProbeDeps,
        thoughts: {
            add(input, action) {
                const result = addThought(input)
                if (action && action.verdict.decision === 'ask') rememberWatchAction(result.thought.id, { actionKind: action.kind, node: action.node, target: action.target })
                return result
            },
            resolve(thoughtId) { setThoughtStatus(thoughtId, 'erledigt', 'waechter') },
        },
        async runL1(action) {
            if (action.kind !== 'self-heal-zyklus') return { ok: false, message: 'kein L1-Weg' }
            const { triggerSelfHeal } = await import('../doctor/self-heal-runtime.js')
            const outcome = await triggerSelfHeal({ isMain: true, reason: 'waechter' })
            return { ok: outcome.ran, message: outcome.note }
        },
    })
    const tick = async (): Promise<WatchTickResult> => {
        try {
            mainNow = await isMain()
            return await engine!.tick()
        } catch (error) {
            console.warn('[Wächter] Lauf fehlgeschlagen:', String((error as Error)?.message || error).slice(0, 200))
            return { active: false, reason: 'fehler' }
        }
    }
    let via: 'Planer' | 'Timer' = 'Timer'
    try {
        const { getPlannerRuntime } = await import('../planner/index.js')
        const planner = getPlannerRuntime()?.planner
        if (planner) {
            planner.register('waechter', {
                async run() {
                    const result = await tick()
                    return { summary: result.active ? `${result.targets ?? 0} Ziele, ${result.alarms ?? 0} Befunde, ${result.recovered ?? 0} erholt` : `nicht aktiv: ${result.reason}` }
                },
            })
            planner.upsertSystemJob({ id: 'sys-waechter', kind: 'waechter', title: 'Wächter', schedule: { type: 'intervall', minutes: settings.intervalMinutes }, mainOnly: true, enabled: true })
            via = 'Planer'
        }
    } catch { /* planner optional */ }
    if (via === 'Timer') {
        timer = setInterval(() => { void tick() }, settings.intervalMinutes * 60_000)
        timer.unref?.()
    }
    runningVia = via
    const first = setTimeout(() => { void tick() }, 30_000)
    first.unref?.()
    return { started: true, reason: `${via} alle ${settings.intervalMinutes} min (${activation.reason})` }
}

/** /monitor add|remove: (re)start the Wächter when the target list changed. */
export async function refreshWatch(): Promise<{ started: boolean; reason: string }> {
    return startWatch(lastStartOptions ?? { nodeOnly: process.env.NOVA_NODE_ONLY === 'true' })
}

export function watchRunningVia(): 'Planer' | 'Timer' | null { return runningVia }

export function stopWatch(): void {
    if (timer) clearInterval(timer)
    timer = null
    if (recheckTimer) clearInterval(recheckTimer)
    recheckTimer = null
    engine = null
    runningVia = null
}

/**
 * Mesh data plane (every 30 s): a node without autonomy authority returns a
 * sample at most every 5 min; otherwise nothing. Off = nothing measured.
 */
export async function watchSampleForMesh(now = Date.now()): Promise<WatchSample | null> {
    if (!settings.enabled) return null
    if (await isMain().catch(() => false)) return null
    if (!shouldPublishWatchSample(lastPublishedAt, now)) return null
    const sample = await collectLocal()
    lastPublishedAt = now
    return sample
}

/** Main side of the signed mesh channel (see peer.ts for the rules). */
export async function ingestPeerWatchSample(sourceNode: string, payload: unknown, knownNodes: readonly string[]): Promise<{ accepted: boolean; reason: string }> {
    // 2.85: accepted whenever the Wächter runs on the Main (also via Nachtwache,
    // /monitor or self-derived targets), not only with autonomy.watch.enabled.
    const active = watchActivation().active
    if (!active) return { accepted: false, reason: 'aus' }
    return acceptPeerWatchSample(
        { sourceNode, payload, knownNodes, localNodeId: await localNodeId() },
        { enabled: active, isMain: await isMain().catch(() => false), watchDir: watchDir(), maxBytes: settings.maxBytes, now: Date.now(), lastAccepted },
    )
}

/** Data source for /waechter, /status, dashboard and G2-HUD (JSON-safe). */
export function getWatchOverview(now = Date.now()): WatchOverview {
    let peers: WatchPeerHeartbeat[] = []
    try { peers = peerReader?.() ?? [] } catch { peers = [] }
    return buildWatchOverview(effectiveSettings(), watchDir(), now, peers)
}

export function handleWaechterCommand(principal?: { permission?: string }): string {
    return formatWaechter(getWatchOverview(), principal)
}

export function watchStatusLines(): string[] {
    try { return formatWatchStatusLines(getWatchOverview()) } catch { return [] }
}

/**
 * Owner removes a target by name: own list first; otherwise a self-derived
 * target of the last round is remembered as removed and never derived again.
 */
export async function removeWatchTarget(name: string): Promise<boolean> {
    const { removeManagedTarget } = await import('./targets.js')
    const derived = (getWatchOverview().snapshot?.reachability ?? []).map(item => ({ id: item.id, name: item.name, origin: item.origin as WatchSettings['targets'][number]['origin'] }))
    return removeManagedTarget(watchDir(), name, derived)
}

/** The former L19 target file (migrated once into watch/targets.json). */
export const legacyMonitorFile = () => join(process.cwd(), '.nova-data', 'monitoring.json')
