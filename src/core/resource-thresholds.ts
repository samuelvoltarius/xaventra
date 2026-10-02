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
 *
 * Eine Prüfung in der Nachtwache-Datei darf eigene warnPercent/critPercent
 * setzen (ausdrücklich je Prüfung); ohne Angabe gilt diese Definition.
 */

export type ResourceLevel = 'ok' | 'warn' | 'crit'

export interface ResourceThresholds {
    disk: { warnPercent: number; critPercent: number; minFreeGB: number }
    memory: { warnPercent: number; critPercent: number }
}

export const DEFAULT_RESOURCE_THRESHOLDS: Readonly<ResourceThresholds> = Object.freeze({
    disk: Object.freeze({ warnPercent: 90, critPercent: 95, minFreeGB: 5 }),
    memory: Object.freeze({ warnPercent: 90, critPercent: 95 }),
}) as Readonly<ResourceThresholds>

const percent = (value: unknown, fallback: number) => {
    const n = Number(value)
    return value !== undefined && value !== null && Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback
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
