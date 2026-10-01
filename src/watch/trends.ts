/**
 * Wächter — Trends und Prognosen. Pure functions, fixed thresholds:
 *
 *   Platte voll   lineare Regression über 7 Tage; gemeldet nur, wenn < 14 Tage
 *   RAM-Trend     Anstieg ≥ 1 %-Punkt/Tag und 95 % in < 14 Tagen
 *   TLS           Ablauf < tlsWarnDays (Standard 21); < 7 Tage oder abgelaufen = kritisch
 *   Backup        jüngste Datei älter als maxAgeHours
 */
import type { WatchSample } from './sample.js'

export const DAY_MS = 24 * 60 * 60_000
export const TREND_WINDOW_DAYS = 7
export const FORECAST_REPORT_DAYS = 14
const MIN_POINTS = 6
const MIN_SPAN_MS = 12 * 60 * 60_000

export interface Regression { slope: number; intercept: number; n: number }

/** Least squares over (x, y). Null for fewer than 2 points or no spread in x. */
export function linearRegression(points: ReadonlyArray<readonly [number, number]>): Regression | null {
    const n = points.length
    if (n < 2) return null
    const mx = points.reduce((sum, [x]) => sum + x, 0) / n
    const my = points.reduce((sum, [, y]) => sum + y, 0) / n
    let sxx = 0, sxy = 0
    for (const [x, y] of points) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my) }
    if (sxx === 0) return null
    const slope = sxy / sxx
    return { slope, intercept: my - slope * mx, n }
}

export interface Forecast {
    nodeId: string
    subject: string
    /** Current value from the regression line at `now`. */
    current: number
    perDay: number
    daysLeft: number
    limit: number
}

/** Days until `limit` from a series of (ms, value), or null when not rising / not enough data. */
export function forecastToLimit(series: ReadonlyArray<readonly [number, number]>, limit: number, now: number): { current: number; perDay: number; daysLeft: number } | null {
    const window = series.filter(([t]) => t >= now - TREND_WINDOW_DAYS * DAY_MS && t <= now)
    if (window.length < MIN_POINTS) return null
    const span = window[window.length - 1][0] - window[0][0]
    if (span < MIN_SPAN_MS) return null
    const fit = linearRegression(window.map(([t, y]) => [(t - now) / DAY_MS, y] as const))
    if (!fit || fit.slope <= 0) return null
    const current = Math.min(limit, fit.intercept)
    return { current, perDay: fit.slope, daysLeft: Math.max(0, (limit - current) / fit.slope) }
}

/** Disk full forecasts per node and mount; only those under 14 days. */
export function diskForecasts(samples: readonly WatchSample[], now: number): Forecast[] {
    const series = new Map<string, Array<[number, number]>>()
    for (const sample of samples) {
        for (const disk of sample.disks) {
            const key = `${sample.nodeId}|${disk.mount}`
            series.set(key, [...(series.get(key) ?? []), [Date.parse(sample.at), disk.usedPct]])
        }
    }
    const out: Forecast[] = []
    for (const [key, points] of series) {
        points.sort((a, b) => a[0] - b[0])
        const result = forecastToLimit(points, 100, now)
        if (!result || result.daysLeft >= FORECAST_REPORT_DAYS) continue
        const [nodeId, mount] = key.split('|')
        out.push({ nodeId, subject: mount, limit: 100, ...result })
    }
    return out.sort((a, b) => a.daysLeft - b.daysLeft)
}

export const RAM_LIMIT_PCT = 95
export const RAM_MIN_SLOPE_PER_DAY = 1
export function ramForecasts(samples: readonly WatchSample[], now: number): Forecast[] {
    const series = new Map<string, Array<[number, number]>>()
    for (const sample of samples) series.set(sample.nodeId, [...(series.get(sample.nodeId) ?? []), [Date.parse(sample.at), sample.ramUsedPct]])
    const out: Forecast[] = []
    for (const [nodeId, points] of series) {
        points.sort((a, b) => a[0] - b[0])
        const result = forecastToLimit(points, RAM_LIMIT_PCT, now)
        if (!result || result.perDay < RAM_MIN_SLOPE_PER_DAY || result.daysLeft >= FORECAST_REPORT_DAYS) continue
        out.push({ nodeId, subject: 'RAM', limit: RAM_LIMIT_PCT, ...result })
    }
    return out
}

export type TrendSeverity = 'ok' | 'warning' | 'critical'

export function diskSeverity(daysLeft: number): TrendSeverity {
    return daysLeft < 3 ? 'critical' : daysLeft < FORECAST_REPORT_DAYS ? 'warning' : 'ok'
}

export function certSeverity(validTo: number, now: number, warnDays: number): { severity: TrendSeverity; daysLeft: number } {
    const daysLeft = (validTo - now) / DAY_MS
    return { daysLeft, severity: daysLeft < 7 ? 'critical' : daysLeft < warnDays ? 'warning' : 'ok' }
}

export function backupSeverity(newestMtime: number | null, now: number, maxAgeHours: number): { severity: TrendSeverity; ageHours: number | null } {
    if (newestMtime === null) return { severity: 'warning', ageHours: null }
    const ageHours = (now - newestMtime) / 3_600_000
    return { severity: ageHours > maxAgeHours * 2 ? 'critical' : ageHours > maxAgeHours ? 'warning' : 'ok', ageHours }
}
