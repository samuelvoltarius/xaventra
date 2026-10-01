/**
 * Wächter — Messverlauf je Knoten, dateibasiert unter `.nova-data/watch/samples/`.
 *
 *   YYYY-MM-DD.jsonl     Rohwerte des Tages (UTC), eine Messung je Zeile
 *   YYYY-MM-DD.h.jsonl   verdichtet: Stundenmittel je Knoten (ab dem Folgetag)
 *
 * Aufbewahrung höchstens 30 Tage, dazu eine Größengrenze: ist der Verlauf
 * größer, fallen die ältesten Tage zuerst weg (der laufende Tag nie). Es
 * werden nur eigene Messdateien gelöscht (L1: eigene Logs rotieren).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../core/atomic-storage.js'
import { sanitizeWatchSample, type WatchDisk, type WatchSample } from './sample.js'

const FILE = /^(\d{4}-\d{2}-\d{2})(\.h)?\.jsonl$/
const DAY_MS = 24 * 60 * 60_000

export const samplesDir = (watchDir: string) => join(watchDir, 'samples')
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

interface SampleFile { name: string; day: string; compacted: boolean; bytes: number }

function listFiles(dir: string): SampleFile[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir).flatMap(name => {
        const match = FILE.exec(name)
        if (!match) return []
        let bytes = 0
        try { bytes = statSync(join(dir, name)).size } catch { return [] }
        return [{ name, day: match[1], compacted: Boolean(match[2]), bytes }]
    }).sort((a, b) => a.day.localeCompare(b.day) || Number(a.compacted) - Number(b.compacted))
}

function readFile(path: string): WatchSample[] {
    let text = ''
    try { text = readFileSync(path, 'utf8') } catch { return [] }
    const out: WatchSample[] = []
    for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
            const sample = sanitizeWatchSample(JSON.parse(line))
            if (sample) out.push(sample)
        } catch { /* corrupt line: skip, never hide the rest */ }
    }
    return out
}

/** Appends one sample. Refuses when today's file alone already uses a quarter of the size limit. */
export function appendWatchSample(watchDir: string, sample: WatchSample, maxBytes: number): boolean {
    const dir = samplesDir(watchDir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${sample.at.slice(0, 10)}.jsonl`)
    try { if (statSync(path).size >= maxBytes / 4) return false } catch { /* new file */ }
    appendFileSync(path, `${JSON.stringify(sample)}\n`, { mode: 0o600 })
    return true
}

export function readWatchSamples(watchDir: string, options: { sinceMs?: number; nodeId?: string } = {}): WatchSample[] {
    const dir = samplesDir(watchDir)
    const sinceDay = options.sinceMs === undefined ? '' : dayOf(options.sinceMs)
    const samples = listFiles(dir)
        .filter(file => file.day >= sinceDay)
        .flatMap(file => readFile(join(dir, file.name)))
        .filter(sample => (options.sinceMs === undefined || Date.parse(sample.at) >= options.sinceMs) && (!options.nodeId || sample.nodeId === options.nodeId))
    return samples.sort((a, b) => a.at.localeCompare(b.at))
}

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const round = (value: number | null, digits = 1) => value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits

/** Hourly mean per node. Already aggregated input keeps its weight `agg.n`. */
export function aggregateHourly(samples: WatchSample[]): WatchSample[] {
    const groups = new Map<string, WatchSample[]>()
    for (const sample of samples) {
        const key = `${sample.nodeId}|${sample.at.slice(0, 13)}`
        groups.set(key, [...(groups.get(key) ?? []), sample])
    }
    const out: WatchSample[] = []
    for (const [key, group] of groups) {
        group.sort((a, b) => a.at.localeCompare(b.at))
        const last = group[group.length - 1]
        const weights = group.map(item => item.agg?.n ?? 1)
        const weighted = (pick: (sample: WatchSample) => number | null): number | null => {
            let sum = 0, weight = 0
            group.forEach((item, index) => { const value = pick(item); if (value !== null) { sum += value * weights[index]; weight += weights[index] } })
            return weight ? sum / weight : null
        }
        const mounts = [...new Set(group.flatMap(item => item.disks.map(disk => disk.mount)))]
        const disks: WatchDisk[] = mounts.map(mount => {
            const lastDisk = [...group].reverse().flatMap(item => item.disks).find(disk => disk.mount === mount)!
            return { ...lastDisk, usedPct: round(weighted(item => item.disks.find(disk => disk.mount === mount)?.usedPct ?? null)) ?? lastDisk.usedPct }
        })
        const temps = group.map(item => item.tempC).filter((value): value is number => value !== null)
        const responses = group.map(item => item.responseMs).filter((value): value is number => value !== null)
        out.push({
            schema: 1,
            nodeId: key.split('|')[0],
            at: `${key.split('|')[1]}:00:00.000Z`,
            cpuLoad: round(weighted(item => item.cpuLoad), 2),
            ramUsedPct: round(weighted(item => item.ramUsedPct)) ?? last.ramUsedPct,
            ramTotalGB: last.ramTotalGB,
            disks,
            tempC: temps.length ? Math.max(...temps) : null,
            services: last.services,
            responseMs: responses.length ? Math.max(...responses) : null,
            agg: { n: weights.reduce((sum, value) => sum + value, 0) },
        })
    }
    return out.sort((a, b) => a.at.localeCompare(b.at) || a.nodeId.localeCompare(b.nodeId))
}

export interface MaintenanceResult { compacted: string[]; removed: string[]; bytes: number }

/**
 * Compacts finished days, drops days past the retention and enforces the
 * size limit (oldest first, today never).
 */
export function maintainWatchStore(watchDir: string, options: { retentionDays: number; maxBytes: number; now?: number }): MaintenanceResult {
    const dir = samplesDir(watchDir)
    const now = options.now ?? Date.now()
    const today = dayOf(now)
    const oldestKept = dayOf(now - (Math.max(1, options.retentionDays) - 1) * DAY_MS)
    const result: MaintenanceResult = { compacted: [], removed: [], bytes: 0 }
    const remove = (name: string) => { try { unlinkSync(join(dir, name)); result.removed.push(name) } catch { /* already gone */ } }

    for (const file of listFiles(dir)) {
        if (file.day < oldestKept) { remove(file.name); continue }
        if (file.compacted || file.day >= today) continue
        const compactName = `${file.day}.h.jsonl`
        const merged = aggregateHourly([...readFile(join(dir, compactName)), ...readFile(join(dir, file.name))])
        atomicWriteFileSync(join(dir, compactName), merged.map(sample => JSON.stringify(sample)).join('\n') + (merged.length ? '\n' : ''))
        try { unlinkSync(join(dir, file.name)) } catch { /* keep going */ }
        result.compacted.push(file.day)
    }

    let files = listFiles(dir)
    let total = files.reduce((sum, file) => sum + file.bytes, 0)
    for (const file of files) {
        if (total <= options.maxBytes) break
        if (file.day >= today) continue
        remove(file.name)
        total -= file.bytes
    }
    files = listFiles(dir)
    result.bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    return result
}

export function watchStoreStats(watchDir: string): { days: number; bytes: number; oldest: string | null } {
    const files = listFiles(samplesDir(watchDir))
    return { days: new Set(files.map(file => file.day)).size, bytes: files.reduce((sum, file) => sum + file.bytes, 0), oldest: files[0]?.day ?? null }
}
