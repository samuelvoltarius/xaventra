/**
 * Wächter (Phase 7) — production wiring. 2.82.0 „ein Wächter“: die einzige
 * Ziel- und Messlogik. Aktiv, sobald etwas zu bewachen ist:
 *   - `autonomy.watch.enabled=true` (Messverlauf, Prognosen, Config-Ziele), oder
 *   - eigene Ziele (/monitor, übernommene L19-Ziele, watch/targets.ts), oder
 *   - die Nachtwache (`autonomy.nightwatch.enabled`; der Wächter führt sie aus).
 *
 * Main (autonomy authority): engine tick as planner job `sys-waechter`; the
 * daemon starts the Wächter AFTER the planner, so the timer is only the
 * fallback when the planner is switched off. Worker: only measures and sends
 * a sample every 5 min inside its signed `node.capabilities` envelope.
 */
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { buildWatchOverview, createWatchEngine, formatWaechter, formatWatchStatusLines, type WatchOverview, type WatchTickResult } from './engine.js'
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
    return reasons.length ? { active: true, reason: reasons.join(', ') } : { active: false, reason: 'nichts zu bewachen (autonomy.watch.enabled=false, keine /monitor-Ziele, Nachtwache aus)' }
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
    const activation = watchActivation()
    if (!activation.active) return { started: false, reason: activation.reason }
    if (options.nodeOnly) return { started: false, reason: 'Mesh-Worker: sendet nur Messwerte (alle 5 min über das signierte Mesh)' }
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
    if (!settings.enabled) return { accepted: false, reason: 'aus' }
    return acceptPeerWatchSample(
        { sourceNode, payload, knownNodes, localNodeId: await localNodeId() },
        { enabled: settings.enabled, isMain: await isMain().catch(() => false), watchDir: watchDir(), maxBytes: settings.maxBytes, now: Date.now(), lastAccepted },
    )
}

/** Data source for /waechter, /status, dashboard and G2-HUD (JSON-safe). */
export function getWatchOverview(now = Date.now()): WatchOverview {
    return buildWatchOverview(effectiveSettings(), watchDir(), now)
}

export function handleWaechterCommand(principal?: { permission?: string }): string {
    return formatWaechter(getWatchOverview(), principal)
}

export function watchStatusLines(): string[] {
    try { return formatWatchStatusLines(getWatchOverview()) } catch { return [] }
}

/** The former L19 target file (migrated once into watch/targets.json). */
export const legacyMonitorFile = () => join(process.cwd(), '.nova-data', 'monitoring.json')
