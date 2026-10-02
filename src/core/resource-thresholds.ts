/**
 * Eine Schwellen-Definition für Platte und Arbeitsspeicher (2.82.0 Aufräumen).
 *
 * Vorher hatte jedes Modul eigene Zahlen: L0 92 % bzw. 5 GB frei, L21 90 %,
 * node-profile und Nachtwache 85/95 %, der Wächter 95 % für die RAM-Prognose.
 * Jetzt lesen alle diese eine Stelle:
 *
 *   autonomy.thresholds.disk.warnPercent     90   ab hier: Warnung (L0, L21, Selbstprüfung, Nachtwache)
 *   autonomy.thresholds.disk.critPercent     95   ab hier: kritisch
 *   autonomy.thresholds.disk.minFreeGB       5    weniger frei = Warnung, auch unter warnPercent
 *   autonomy.thresholds.memory.warnPercent   90   RAM belegt
 *   autonomy.thresholds.memory.critPercent   95   RAM belegt; Grenze der Wächter-RAM-Prognose
 *   autonomy.thresholds.memory.vllmMinAvailableMB  4096  vLLM-Knoten: weniger verfügbar = Warnung, unter der Hälfte kritisch
 *   autonomy.thresholds.memory.vllmSwapGrowthMB    1024  vLLM-Knoten: Swap-Zuwachs zwischen zwei Messungen = Warnung
 *   autonomy.thresholds.memory.vllmNode            -     true/false erzwingt die Knotenart; ohne Angabe erkannt
 *
 * vLLM-Knoten (Live-Befund 2.82.0 am Spark): vLLM reserviert den GPU-Unified-
 * Memory dauerhaft (--gpu-memory-utilization), der RAM steht bei ~92 %. Dort
 * ist der Prozentwert kein Gefahrensignal; es zählen verfügbarer Speicher
 * (MemAvailable) unter der Reserve, wachsender Swap und OOM-Kills. Ein
 * OOM-Kill ist auf jedem Knoten kritisch.
 *
 * Eine Prüfung in der Nachtwache-Datei darf eigene warnPercent/critPercent
 * setzen (ausdrücklich je Prüfung); ohne Angabe gilt diese Definition.
 */

import { readdirSync, readFileSync } from 'node:fs'

export type ResourceLevel = 'ok' | 'warn' | 'crit'

export interface ResourceThresholds {
    disk: { warnPercent: number; critPercent: number; minFreeGB: number }
    memory: { warnPercent: number; critPercent: number; vllmMinAvailableMB: number; vllmSwapGrowthMB: number; vllmNode: boolean | null }
}

export const DEFAULT_RESOURCE_THRESHOLDS: Readonly<ResourceThresholds> = Object.freeze({
    disk: Object.freeze({ warnPercent: 90, critPercent: 95, minFreeGB: 5 }),
    memory: Object.freeze({ warnPercent: 90, critPercent: 95, vllmMinAvailableMB: 4096, vllmSwapGrowthMB: 1024, vllmNode: null }),
}) as Readonly<ResourceThresholds>

const percent = (value: unknown, fallback: number) => {
    const n = Number(value)
    return value !== undefined && value !== null && Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback
}

const megabytes = (value: unknown, fallback: number) => {
    const n = Number(value)
    return value !== undefined && value !== null && Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Validates `autonomy.thresholds`; warn is never above crit. */
export function parseResourceThresholds(raw: any): ResourceThresholds {
    const d = DEFAULT_RESOURCE_THRESHOLDS
    const diskCrit = percent(raw?.disk?.critPercent, d.disk.critPercent)
    const memoryCrit = percent(raw?.memory?.critPercent, d.memory.critPercent)
    const minFree = Number(raw?.disk?.minFreeGB)
    return {
        disk: {
            warnPercent: Math.min(diskCrit, percent(raw?.disk?.warnPercent, d.disk.warnPercent)),
            critPercent: diskCrit,
            minFreeGB: raw?.disk?.minFreeGB !== undefined && Number.isFinite(minFree) && minFree >= 0 ? minFree : d.disk.minFreeGB,
        },
        memory: {
            warnPercent: Math.min(memoryCrit, percent(raw?.memory?.warnPercent, d.memory.warnPercent)),
            critPercent: memoryCrit,
            vllmMinAvailableMB: megabytes(raw?.memory?.vllmMinAvailableMB, d.memory.vllmMinAvailableMB),
            vllmSwapGrowthMB: megabytes(raw?.memory?.vllmSwapGrowthMB, d.memory.vllmSwapGrowthMB),
            vllmNode: typeof raw?.memory?.vllmNode === 'boolean' ? raw.memory.vllmNode : null,
        },
    }
}

let current: ResourceThresholds = parseResourceThresholds(undefined)

/** Called once by the daemon with `config.autonomy`. */
export function setResourceThresholds(autonomy: any): ResourceThresholds {
    current = parseResourceThresholds(autonomy?.thresholds)
    return current
}

export function getResourceThresholds(): ResourceThresholds {
    return current
}

/** Disk level from used percent and (optional) free GB. */
export function diskLevel(usedPercent: number, freeGB?: number | null, thresholds: ResourceThresholds = current): ResourceLevel {
    if (Number.isFinite(usedPercent) && usedPercent >= thresholds.disk.critPercent) return 'crit'
    if (Number.isFinite(usedPercent) && usedPercent >= thresholds.disk.warnPercent) return 'warn'
    if (freeGB !== undefined && freeGB !== null && Number.isFinite(freeGB) && freeGB < thresholds.disk.minFreeGB) return 'warn'
    return 'ok'
}

/** Memory level from used percent. */
export function memoryLevel(usedPercent: number, thresholds: ResourceThresholds = current): ResourceLevel {
    if (!Number.isFinite(usedPercent) || usedPercent < 0) return 'ok'
    if (usedPercent >= thresholds.memory.critPercent) return 'crit'
    if (usedPercent >= thresholds.memory.warnPercent) return 'warn'
    return 'ok'
}

// ============================================
// vLLM-aware memory assessment
// ============================================

export interface MemorySample {
    usedPercent: number
    totalMB?: number | null
    /** MemAvailable; derived from usedPercent and totalMB when missing. */
    availableMB?: number | null
    swapUsedMB?: number | null
    /** Cumulative oom_kill counter from /proc/vmstat. */
    oomKills?: number | null
}

export interface MemoryAssessment {
    level: ResourceLevel
    reason: string
    vllmNode: boolean
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Memory level including the danger signals that matter on a vLLM node. */
export function assessMemory(
    sample: MemorySample,
    context: { vllmNode: boolean; previous?: MemorySample | null },
    thresholds: ResourceThresholds = current,
): MemoryAssessment {
    const { vllmNode, previous } = context
    const previousOom = previous?.oomKills
    if (finite(sample.oomKills) && finite(previousOom) && sample.oomKills > previousOom) {
        return { level: 'crit', reason: `OOM-Kill: ${sample.oomKills - previousOom} Prozess(e) beendet`, vllmNode }
    }
    if (!vllmNode) {
        const level = memoryLevel(sample.usedPercent, thresholds)
        return { level, reason: level === 'ok' ? '' : `${sample.usedPercent} % belegt`, vllmNode }
    }
    const available = finite(sample.availableMB)
        ? sample.availableMB
        : finite(sample.totalMB) && finite(sample.usedPercent) ? sample.totalMB * (100 - sample.usedPercent) / 100 : null
    const reserve = thresholds.memory.vllmMinAvailableMB
    if (available !== null && available < reserve / 2) {
        return { level: 'crit', reason: `nur ${Math.round(available)} MB verfügbar (vLLM-Knoten, Reserve ${reserve} MB)`, vllmNode }
    }
    if (available !== null && available < reserve) {
        return { level: 'warn', reason: `nur ${Math.round(available)} MB verfügbar (vLLM-Knoten, Reserve ${reserve} MB)`, vllmNode }
    }
    const previousSwap = previous?.swapUsedMB
    if (finite(sample.swapUsedMB) && finite(previousSwap)) {
        const growth = sample.swapUsedMB - previousSwap
        if (growth >= thresholds.memory.vllmSwapGrowthMB) {
            return { level: 'warn', reason: `Swap wächst um ${Math.round(growth)} MB (vLLM-Knoten)`, vllmNode }
        }
    }
    return { level: 'ok', reason: '', vllmNode }
}

/** Parses /proc/meminfo (+ optional /proc/vmstat) into MB values. */
export function parseMeminfo(meminfo: string, vmstat = ''): { totalMB: number | null; availableMB: number | null; swapUsedMB: number | null; oomKills: number | null } {
    const kb = (key: string): number | null => {
        const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(meminfo)
        return match ? Number(match[1]) : null
    }
    const total = kb('MemTotal'), available = kb('MemAvailable'), swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree')
    const oom = /^oom_kill\s+(\d+)/m.exec(vmstat)
    return {
        totalMB: total === null ? null : Math.round(total / 1024),
        availableMB: available === null ? null : Math.round(available / 1024),
        swapUsedMB: swapTotal === null || swapFree === null ? null : Math.round((swapTotal - swapFree) / 1024),
        oomKills: oom ? Number(oom[1]) : null,
    }
}

let vllmMark: boolean | null = null

/** Node profile reports a locally running vLLM service (gpu.viaVllm). */
export function markVllmNode(value: boolean | null): void {
    vllmMark = value
}

/** True when a command line of this host runs a vLLM server. */
export function detectVllmProcess(listCommandLines: () => string[]): boolean {
    try {
        return listCommandLines().some(line => /\bvllm(\.entrypoints\b|\s+serve\b)/i.test(line))
    } catch {
        return false
    }
}

function linuxCommandLines(): string[] {
    if (process.platform !== 'linux') return []
    const out: string[] = []
    for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue
        try { out.push(readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()) } catch { /* process gone */ }
    }
    return out
}

let processScan: { at: number; value: boolean } | null = null
const PROCESS_SCAN_TTL_MS = 10 * 60_000

/** Config override > node profile mark > running vLLM process (cached). */
export function isVllmNode(deps: { listCommandLines?: () => string[]; now?: number } = {}): boolean {
    if (current.memory.vllmNode !== null) return current.memory.vllmNode
    if (vllmMark !== null) return vllmMark
    if (deps.listCommandLines) return detectVllmProcess(deps.listCommandLines)
    const now = deps.now ?? Date.now()
    if (!processScan || now - processScan.at > PROCESS_SCAN_TTL_MS) {
        processScan = { at: now, value: detectVllmProcess(linuxCommandLines) }
    }
    return processScan.value
}

let previousLocal: MemorySample | null = null

/** Reads /proc on Linux; elsewhere only the given sample counts. */
function enrichLocalSample(sample: MemorySample): MemorySample {
    if (process.platform !== 'linux') return sample
    try {
        let vmstat = ''
        try { vmstat = readFileSync('/proc/vmstat', 'utf8') } catch { /* optional */ }
        const parsed = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'), vmstat)
        return {
            ...sample,
            totalMB: sample.totalMB ?? parsed.totalMB,
            availableMB: parsed.availableMB ?? sample.availableMB,
            swapUsedMB: parsed.swapUsedMB ?? sample.swapUsedMB,
            oomKills: parsed.oomKills ?? sample.oomKills,
        }
    } catch {
        return sample
    }
}

/**
 * Assessment of this host's memory, remembering the previous sample for the
 * swap-growth and OOM signals. Used by L0, the node self-check and L15.
 */
export function assessLocalMemory(sample: MemorySample, options: { remember?: boolean } = {}): MemoryAssessment {
    const enriched = enrichLocalSample(sample)
    const assessment = assessMemory(enriched, { vllmNode: isVllmNode(), previous: previousLocal })
    if (options.remember !== false) previousLocal = enriched
    return assessment
}
