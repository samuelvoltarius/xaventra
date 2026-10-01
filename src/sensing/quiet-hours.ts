/**
 * Ruhezeiten lernen: aus den eigenen Gesprächs-Zeitstempeln des Owners
 * (`.nova-data/sessions/<owner>.jsonl`, nur Feld `ts` von `role: "user"`)
 * einen Vorschlag ableiten. Inhalte werden nicht gelesen bzw. sofort verworfen.
 * Ohne genug Daten bleibt der vorsichtige Standard 22–7 Uhr (nur Dringendes,
 * max. 10 Meldungen/Tag). Angewendet wird nichts — der Vorschlag ist ein
 * Gedanke mit Stufe `fragen`.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { localDay, localHour } from './notify-policy.js'

export const DEFAULT_QUIET = Object.freeze({ start: 22, end: 7, maxPerDay: 10 })

export interface QuietHoursProposal {
    start: number
    end: number
    learned: boolean
    reason: string
    samples: number
    days: number
    histogram: number[]
}

const MIN_SAMPLES = 50
const MIN_DAYS = 7
const MIN_LENGTH = 5
const MAX_LENGTH = 12
const WINDOW_MS = 90 * 24 * 60 * 60_000
const MAX_READ = 4 * 1024 * 1024

/** Reads only the timestamps of the owner's own messages (last 4 MB of each file). */
export function readOwnerTimestamps(dataDir: string, sessionNames: string[], nowMs = Date.now()): number[] {
    const out: number[] = []
    for (const name of [...new Set(sessionNames)].slice(0, 5)) {
        const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_')
        if (!safe) continue
        const path = join(dataDir, 'sessions', `${safe}.jsonl`)
        if (!existsSync(path)) continue
        const fd = openSync(path, 'r')
        try {
            const size = fstatSync(fd).size
            const length = Math.min(size, MAX_READ)
            const buf = Buffer.alloc(length)
            readSync(fd, buf, 0, length, size - length)
            for (const line of buf.toString('utf8').split('\n')) {
                // Cheap pre-filter, then take only role + ts; content is never kept.
                if (!line.includes('"role":"user"')) continue
                try {
                    const { ts, role } = JSON.parse(line)
                    const at = Date.parse(ts)
                    if (role === 'user' && Number.isFinite(at) && nowMs - at <= WINDOW_MS && at <= nowMs) out.push(at)
                } catch { /* partial first line */ }
            }
        } finally { closeSync(fd) }
    }
    return out
}

export function learnQuietHours(timestamps: number[], timezone = 'Europe/Vienna'): QuietHoursProposal {
    const histogram = new Array(24).fill(0)
    const days = new Set<string>()
    for (const at of timestamps) {
        histogram[localHour(at, timezone)]++
        days.add(localDay(at, timezone))
    }
    const samples = timestamps.length
    const base = { samples, days: days.size, histogram }
    if (samples < MIN_SAMPLES || days.size < MIN_DAYS) {
        return { ...DEFAULT_QUIET, learned: false, reason: `zu wenig Daten (${samples} Nachrichten an ${days.size} Tagen, nötig ${MIN_SAMPLES}/${MIN_DAYS})`, ...base }
    }
    // Longest circular run of hours with ≤ 2 % of the activity.
    const threshold = Math.max(1, Math.floor(samples * 0.02))
    let best = { start: -1, length: 0 }
    for (let start = 0; start < 24; start++) {
        if (histogram[(start + 23) % 24] <= threshold) continue // only runs that start after an active hour
        let length = 0
        while (length < 24 && histogram[(start + length) % 24] <= threshold) length++
        if (length > best.length) best = { start, length }
    }
    if (best.length < MIN_LENGTH) {
        return { ...DEFAULT_QUIET, learned: false, reason: 'kein ruhiger Block von mindestens 5 Stunden erkennbar', ...base }
    }
    // Cap at 12 h, centred on the quietest part of the run.
    let start = best.start
    let length = best.length
    if (length > MAX_LENGTH) { start = (start + Math.floor((length - MAX_LENGTH) / 2)) % 24; length = MAX_LENGTH }
    return { start, end: (start + length) % 24, learned: true, reason: `aus ${samples} eigenen Nachrichten an ${days.size} Tagen`, ...base }
}
