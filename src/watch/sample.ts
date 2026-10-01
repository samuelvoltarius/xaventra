/**
 * Wächter — one measurement of a node: CPU load, RAM, disk per mount,
 * temperature (when readable), local service states and the reaction time of
 * the own event loop. Read-only: os/statfs/sysfs, no child process, no
 * network, no secrets.
 *
 * Workers send their sample inside the signed `node.capabilities` envelope
 * (every 5 min, see `shouldPublishWatchSample`); the Main bounds it again
 * with `sanitizeWatchSample` before it is stored.
 */
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs'
import { cpus, freemem, hostname, loadavg, platform, totalmem } from 'node:os'
import { parse as parsePath } from 'node:path'

export interface WatchDisk { mount: string; usedPct: number; totalGB: number; freeGB: number }
export interface WatchService { name: string; status: 'running' | 'installed' | 'stopped' }

export interface WatchSample {
    schema: 1
    nodeId: string
    /** ISO time of the measurement. */
    at: string
    /** 1-min load per core (null on Windows). */
    cpuLoad: number | null
    ramUsedPct: number
    ramTotalGB: number
    disks: WatchDisk[]
    tempC: number | null
    services: WatchService[]
    /** Reaction time of the own event loop in ms (Antwortzeit des Dienstes). */
    responseMs: number | null
    /** Set by compaction: hourly aggregate of n raw samples. */
    agg?: { n: number }
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits

export function diskOf(mount: string): WatchDisk | null {
    try {
        const stats = statfsSync(mount)
        const total = Number(stats.blocks) * Number(stats.bsize)
        if (!(total > 0)) return null
        const free = Number(stats.bavail) * Number(stats.bsize)
        const used = (Number(stats.blocks) - Number(stats.bfree)) * Number(stats.bsize)
        return { mount, usedPct: round(used / Math.max(1, used + free) * 100), totalGB: round(total / 1024 ** 3), freeGB: round(free / 1024 ** 3) }
    } catch { return null }
}

/** Highest thermal zone in °C, Linux only. */
export function readTemperature(base = '/sys/class/thermal'): number | null {
    try {
        if (!existsSync(base)) return null
        let best: number | null = null
        for (const zone of readdirSync(base).filter(name => /^thermal_zone\d+$/.test(name)).slice(0, 32)) {
            const milli = Number(readFileSync(`${base}/${zone}/temp`, 'utf8').trim())
            if (Number.isFinite(milli) && milli > 0 && milli < 150_000) best = Math.max(best ?? 0, milli / 1000)
        }
        return best === null ? null : round(best)
    } catch { return null }
}

export function measureLoopLag(): Promise<number> {
    const start = process.hrtime.bigint()
    return new Promise(resolve => setImmediate(() => resolve(round(Number(process.hrtime.bigint() - start) / 1e6, 2))))
}

export interface CollectDeps {
    nodeId?: string
    mounts?: string[]
    dataDir?: string
    services?: () => WatchService[]
    now?: () => number
}

export async function collectWatchSample(deps: CollectDeps = {}): Promise<WatchSample> {
    const now = deps.now ?? Date.now
    const root = platform() === 'win32' ? parsePath(process.cwd()).root : '/'
    const mounts = [...new Set([root, ...(deps.dataDir ? [deps.dataDir] : []), ...(deps.mounts ?? [])])]
    const disks: WatchDisk[] = []
    for (const mount of mounts) {
        const disk = diskOf(mount)
        // The data dir often lives on the root disk; keep one line per real disk.
        if (disk && !disks.some(item => item.totalGB === disk.totalGB && item.freeGB === disk.freeGB)) disks.push(disk)
    }
    let services: WatchService[] = []
    try { services = deps.services ? deps.services() : [] } catch { /* optional */ }
    return {
        schema: 1,
        nodeId: deps.nodeId || process.env.NOVA_NODE_ID || hostname(),
        at: new Date(now()).toISOString(),
        cpuLoad: platform() === 'win32' ? null : round(loadavg()[0] / Math.max(1, cpus().length), 2),
        ramUsedPct: round((1 - freemem() / Math.max(1, totalmem())) * 100),
        ramTotalGB: round(totalmem() / 1024 ** 3),
        disks,
        tempC: readTemperature(),
        services: services.slice(0, 20),
        responseMs: await measureLoopLag(),
    }
}

// ---------------------------------------------------------------------------
// Receiving side: bounded, never trusted further than these fields
// ---------------------------------------------------------------------------

const str = (value: unknown, max: number) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max)
const pct = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : null
const nonNeg = (value: unknown, max: number) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Number(value))) : null

export function sanitizeWatchSample(raw: unknown): WatchSample | null {
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, any>
    if (value.schema !== 1 || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null
    const ram = pct(value.ramUsedPct)
    if (ram === null) return null
    const disks = (Array.isArray(value.disks) ? value.disks.slice(0, 8) : []).flatMap((disk: any): WatchDisk[] => {
        const used = pct(disk?.usedPct)
        return used === null ? [] : [{ mount: str(disk?.mount, 120), usedPct: used, totalGB: nonNeg(disk?.totalGB, 1e6) ?? 0, freeGB: nonNeg(disk?.freeGB, 1e6) ?? 0 }]
    })
    const services = (Array.isArray(value.services) ? value.services.slice(0, 20) : []).map((service: any): WatchService => ({
        name: str(service?.name, 40),
        status: ['running', 'installed', 'stopped'].includes(service?.status) ? service.status : 'stopped',
    }))
    const n = Number(value.agg?.n)
    return {
        schema: 1,
        nodeId: str(value.nodeId, 80),
        at: new Date(Date.parse(value.at)).toISOString(),
        cpuLoad: nonNeg(value.cpuLoad, 1000),
        ramUsedPct: ram,
        ramTotalGB: nonNeg(value.ramTotalGB, 1e6) ?? 0,
        disks,
        tempC: value.tempC === null || value.tempC === undefined ? null : nonNeg(value.tempC, 150),
        services,
        responseMs: value.responseMs === null || value.responseMs === undefined ? null : nonNeg(value.responseMs, 600_000),
        ...(Number.isInteger(n) && n > 0 ? { agg: { n: Math.min(n, 100_000) } } : {}),
    }
}

/** Workers send a sample at most every `intervalMs` (default 5 min). */
export const WATCH_PUBLISH_INTERVAL_MS = 5 * 60_000
export function shouldPublishWatchSample(lastSentAt: number | null, now: number, intervalMs = WATCH_PUBLISH_INTERVAL_MS): boolean {
    return lastSentAt === null || now - lastSentAt >= intervalMs
}
