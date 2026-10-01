/**
 * Drucker-Adapter (nur lesend): Moonraker, OctoPrint, PrusaLink.
 *
 * Ereignisse je Druckauftrag: „gleich fertig“ (Fortschritt ≥ 90 %, genau
 * einmal je Auftrag), fertig, Fehler, pausiert. Nur GET-Endpunkte; Steuerung
 * (Start/Pause/G-Code) bleibt im Werkzeug src/tools/3dprinter.ts und dort
 * hinter der Owner-Freigabe.
 *
 * Geräte: aus `autonomy.sensing.adapters.printer.devices` und aus der
 * Geräte-Datei, aber nur mit Status `eingerichtet` (approveDevice).
 */

import type { PrintStats } from '../../tools/3dprinter.js'
import type { AdapterContext, RawEvent, SensingAdapter } from '../event-bus.js'
import type { PrinterDeviceConfig } from '../config.js'

export type PrinterState = PrintStats['state'] | 'unknown'

export interface PrinterSnapshot {
    state: PrinterState
    /** 0..1, null if unknown */
    progress: number | null
    job: string
    message?: string
}

export interface PrinterLatch {
    job: string
    lastState?: PrinterState
    lastProgress?: number | null
    nearDoneSent: boolean
}

export const NEAR_DONE = 0.9

const clamp01 = (value: unknown): number | null => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null
}

/** GET /printer/objects/query?print_stats&display_status&virtual_sdcard */
export function parseMoonraker(json: any): PrinterSnapshot {
    const status = json?.result?.status || {}
    const stats = status.print_stats || {}
    const state = (['standby', 'printing', 'paused', 'complete', 'error', 'cancelled'] as const).includes(stats.state) ? stats.state : 'unknown'
    const progress = clamp01(status.virtual_sdcard?.progress ?? status.display_status?.progress)
    return { state, progress, job: String(stats.filename || ''), message: stats.message ? String(stats.message) : undefined }
}

/** GET /api/job (OctoPrint, needs the owner's API key) */
export function parseOctoPrint(json: any): PrinterSnapshot {
    const raw = String(json?.state || '').toLowerCase()
    const completion = clamp01(Number(json?.progress?.completion) / 100)
    const job = String(json?.job?.file?.name || '')
    let state: PrinterState = 'unknown'
    if (raw.startsWith('printing')) state = 'printing'
    else if (raw.startsWith('paus')) state = 'paused'
    else if (raw.includes('error') || raw.startsWith('offline after error')) state = 'error'
    else if (raw.startsWith('cancel')) state = 'cancelled'
    else if (raw.startsWith('operational') || raw.startsWith('finishing')) state = completion !== null && completion >= 1 && job ? 'complete' : 'standby'
    return { state, progress: completion, job, message: json?.error ? String(json.error) : undefined }
}

/** GET /api/v1/status (PrusaLink) */
export function parsePrusaLink(json: any): PrinterSnapshot {
    const raw = String(json?.printer?.state || '').toUpperCase()
    const map: Record<string, PrinterState> = { PRINTING: 'printing', PAUSED: 'paused', FINISHED: 'complete', ERROR: 'error', STOPPED: 'cancelled', IDLE: 'standby', READY: 'standby', ATTENTION: 'paused', BUSY: 'printing' }
    return { state: map[raw] || 'unknown', progress: clamp01(Number(json?.job?.progress) / 100), job: String(json?.job?.id ?? '') }
}

/**
 * Pure transition detector. Returns the events for this observation and the
 * new latch. „gleich fertig“ fires at most once per job; the first observation
 * of a printer only reports „gleich fertig“ (a stale complete/paused/error from
 * before the start is not news).
 */
export function printerTransitions(deviceId: string, name: string, previous: PrinterLatch | undefined, current: PrinterSnapshot): { events: RawEvent[]; latch: PrinterLatch } {
    const events: RawEvent[] = []
    const regressed = previous && previous.lastProgress != null && current.progress != null && current.progress + 0.2 < previous.lastProgress
    const newJob = !previous || previous.job !== current.job || regressed
    const latch: PrinterLatch = newJob
        ? { job: current.job, nearDoneSent: false }
        : { ...previous! }
    const first = !previous
    const pct = current.progress === null ? null : Math.round(current.progress * 100)
    const evidence = { geraet: deviceId, zustand: current.state, fortschritt: pct, auftrag: current.job || null }
    const jobKey = `${deviceId}:${current.job || '-'}`

    if (current.state === 'printing' && current.progress !== null && current.progress >= NEAR_DONE && !latch.nearDoneSent) {
        latch.nearDoneSent = true
        events.push({
            kind: 'printer.near-done', subject: deviceId, severity: 'info', dedupeKey: `printer:${jobKey}:near-done`, dedupeWindowMs: 24 * 60 * 60_000,
            summary: `${name}: Druck ${current.job || ''} gleich fertig (${pct} %).`.replace('  ', ' '), evidence,
            hint: { importance: 'normal', proposal: 'Nächsten Druck aus der Warteschlange vorbereiten?', level: 'fragen' },
        })
    }
    const changed = !first && latch.lastState !== current.state
    if (changed && current.state === 'complete') {
        events.push({ kind: 'printer.done', subject: deviceId, severity: 'info', dedupeKey: `printer:${jobKey}:done`, summary: `${name}: Druck ${current.job || ''} fertig.`.replace('  ', ' '), evidence, hint: { importance: 'normal', proposal: 'Druckteil entnehmen; nächsten Druck vorschlagen?', level: 'fragen' } })
    }
    if (changed && current.state === 'error') {
        events.push({ kind: 'printer.error', subject: deviceId, severity: 'urgent', dedupeKey: `printer:${jobKey}:error`, summary: `${name}: Druckerfehler${current.message ? ` — ${current.message}` : ''}.`, evidence, hint: { importance: 'dringend' } })
    }
    if (changed && current.state === 'paused') {
        events.push({ kind: 'printer.paused', subject: deviceId, severity: 'warning', dedupeKey: `printer:${jobKey}:paused:${pct ?? '-'}`, summary: `${name}: Druck pausiert${pct !== null ? ` bei ${pct} %` : ''}${current.message ? ` — ${current.message}` : ''}.`, evidence, hint: { importance: 'hoch' } })
    }
    latch.lastState = current.state
    latch.lastProgress = current.progress
    return { events, latch }
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; method: 'GET' }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

export interface PrinterTarget extends PrinterDeviceConfig { name?: string }

const PATHS: Record<PrinterDeviceConfig['type'], string> = {
    moonraker: '/printer/objects/query?print_stats&display_status&virtual_sdcard',
    octoprint: '/api/job',
    prusalink: '/api/v1/status',
}
const PARSERS: Record<PrinterDeviceConfig['type'], (json: any) => PrinterSnapshot> = { moonraker: parseMoonraker, octoprint: parseOctoPrint, prusalink: parsePrusaLink }

export function createPrinterAdapter(options: {
    targets: () => PrinterTarget[]
    intervalMs: number
    timeoutMs: number
    fetch?: FetchLike
    env?: NodeJS.ProcessEnv
}): SensingAdapter {
    const doFetch: FetchLike = options.fetch || ((url, init) => fetch(url, init) as any)
    const env = options.env || process.env
    return {
        id: 'printer', source: 'printer', intervalMs: options.intervalMs, timeoutMs: options.timeoutMs,
        async poll(ctx: AdapterContext): Promise<RawEvent[]> {
            const latches = (ctx.state.latches as Record<string, PrinterLatch>) || {}
            const events: RawEvent[] = []
            const failures: string[] = []
            for (const target of options.targets().slice(0, 20)) {
                const apiKey = target.apiKey || (target.apiKeyEnv ? env[target.apiKeyEnv] : undefined)
                if ((target.type === 'octoprint') && !apiKey) continue // owner step: no key, no polling
                const headers: Record<string, string> = { Accept: 'application/json' }
                if (apiKey) headers['X-Api-Key'] = apiKey
                try {
                    const res = await doFetch(`${target.url}${PATHS[target.type]}`, { method: 'GET', headers, signal: ctx.signal })
                    if (!res.ok) { failures.push(`${target.id}: HTTP ${res.status}`); continue }
                    const snapshot = PARSERS[target.type](await res.json())
                    const result = printerTransitions(target.id, target.name || target.id, latches[target.id], snapshot)
                    latches[target.id] = result.latch
                    events.push(...result.events)
                } catch (error) {
                    if (ctx.signal.aborted) throw error
                    failures.push(`${target.id}: ${error instanceof Error ? error.name : 'Fehler'}`)
                }
            }
            ctx.state.latches = latches
            if (failures.length && !events.length && failures.length === options.targets().length) throw new Error(`Drucker nicht erreichbar (${failures.join(', ').slice(0, 120)})`)
            return events
        },
    }
}
