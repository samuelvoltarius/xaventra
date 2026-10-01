/**
 * Wächter (Phase 7) — production wiring. Standard AUS (`autonomy.watch.enabled`).
 *
 * Main (autonomy authority): engine tick via planner job `sys-waechter`
 * (fallback timer), stores own and peers' samples, probes, forecasts, alarms.
 * Worker: only measures and sends a sample every 5 min inside its signed
 * `node.capabilities` envelope. With the switch off nothing runs, nothing is
 * measured, sent or stored.
 */
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { buildWatchOverview, createWatchEngine, formatWaechter, formatWatchStatusLines, type ProxmoxGuestSource, type WatchOverview, type WatchTickResult } from './engine.js'
import { acceptPeerWatchSample } from './peer.js'
import { defaultWatchProbeDeps } from './probes.js'
import { collectWatchSample, shouldPublishWatchSample, type WatchSample, type WatchService } from './sample.js'
import { parseWatchSettings, type WatchSettings } from './settings.js'

let settings: WatchSettings = parseWatchSettings(undefined)
let engine: ReturnType<typeof createWatchEngine> | null = null
let timer: ReturnType<typeof setInterval> | null = null
let proxmoxSource: ProxmoxGuestSource | undefined
let lastPublishedAt: number | null = null
const lastAccepted = new Map<string, number>()

export const watchDir = () => getNovaDataDir('watch')

/** Called once by the daemon with `config.autonomy`. */
export function setWatchConfig(autonomy: unknown): WatchSettings {
    settings = parseWatchSettings(autonomy)
    return settings
}
export function getWatchSettings(): WatchSettings { return settings }

/** A Proxmox module registers its read-only guest list here (none in this release). */
export function setWatchProxmoxSource(source: ProxmoxGuestSource | undefined): void { proxmoxSource = source }

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
    if (!settings.enabled) return { started: false, reason: 'autonomy.watch.enabled=false' }
    if (options.nodeOnly) return { started: false, reason: 'Mesh-Worker: sendet nur Messwerte (alle 5 min über das signierte Mesh)' }
    const { addThought, setThoughtStatus } = await import('../planner/index.js')
    const { rememberWatchAction } = await import('../core/thought-hub.js')
    const { listWatchableDevices } = await import('../sensing/runtime.js')
    let mainNow = false
    engine = createWatchEngine({
        settings,
        watchDir: watchDir(),
        localNodeId: await localNodeId(),
        isMain: () => mainNow,
        collect: collectLocal,
        devices: () => listWatchableDevices(),
        proxmox: proxmoxSource ? () => proxmoxSource!() : undefined,
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
            const { getSelfHealSettings, runSelfHealCycle } = await import('../doctor/self-heal-runtime.js')
            if (!getSelfHealSettings().enabled) return { ok: false, message: 'Selbstheilung aus' }
            await runSelfHealCycle({ isMain: true })
            return { ok: true, message: 'Selbstheilung gelaufen' }
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
    let via = 'Timer'
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
    const first = setTimeout(() => { void tick() }, 30_000)
    first.unref?.()
    return { started: true, reason: `${via} alle ${settings.intervalMinutes} min, ${settings.targets.length} Ziele aus der Config` }
}

export function stopWatch(): void {
    if (timer) clearInterval(timer)
    timer = null
    engine = null
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
    return buildWatchOverview(settings, watchDir(), now)
}

export function handleWaechterCommand(principal?: { permission?: string }): string {
    return formatWaechter(getWatchOverview(), principal)
}

export function watchStatusLines(): string[] {
    try { return formatWatchStatusLines(getWatchOverview()) } catch { return [] }
}
