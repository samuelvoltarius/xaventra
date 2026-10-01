/**
 * Wächter (Phase 7) — the engine: measure, probe, forecast, alarm.
 *
 * Runs only on the Main (with autonomy authority). Per tick:
 *   1. own sample → Messverlauf (workers' samples arrive via the signed mesh)
 *   2. Erreichbarkeit of the resolved target list, entprellt: alarm only after
 *      `failThreshold` failures in a row, recovery is reported once
 *   3. Prognosen (Platte voll, RAM), TLS-Ablauf (alle 6 h), Backup-Alter
 *   4. findings become thoughts (fixed importance rules, quiet hours, dedupe
 *      and daily cap of the planner). The suggested action is judged by the
 *      one action policy: L0/L1 → no card (L1 only through the existing
 *      self-heal path), L2 → Knopf-Karte, L3 → never.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { evaluateAction, type PolicyVerdict } from '../core/action-policy.js'
import type { NewThought } from '../planner/thoughts.js'
import { probeTargets, readBackupAges, readCertificates, type ReachabilityResult, type WatchProbeDeps } from './probes.js'
import type { WatchSample } from './sample.js'
import { normalizeWatchTarget, type WatchSettings, type WatchTarget } from './settings.js'
import { appendWatchSample, maintainWatchStore, readWatchSamples, watchStoreStats } from './store.js'
import { backupSeverity, certSeverity, DAY_MS, diskForecasts, diskSeverity, ramForecasts, TREND_WINDOW_DAYS, type Forecast, type TrendSeverity } from './trends.js'

export const THOUGHT_SOURCE = 'waechter'
const TLS_INTERVAL_MS = 6 * 60 * 60_000

// ---------------------------------------------------------------------------
// Ziele: nur Liste + eingerichtete Geräte + Proxmox-Gäste
// ---------------------------------------------------------------------------

export interface DeviceLike { name: string; host: string; port: number }
export interface ProxmoxGuestLike { name: string; host: string; kind?: string; port?: number }
/** Read-only adapter interface; registered by a Proxmox module once it exists. */
export type ProxmoxGuestSource = () => Promise<ProxmoxGuestLike[]>

export function resolveWatchTargets(settings: WatchSettings, devices: readonly DeviceLike[], guests: readonly ProxmoxGuestLike[]): { targets: WatchTarget[]; rejected: string[] } {
    const targets = [...settings.targets]
    const rejected: string[] = []
    const add = (raw: unknown, origin: 'geraet' | 'proxmox') => {
        const target = normalizeWatchTarget(raw, origin)
        if (typeof target === 'string') rejected.push(target)
        else if (!targets.some(existing => existing.id === target.id)) targets.push(target)
    }
    if (settings.includeDevices) for (const device of devices.slice(0, 64)) add({ name: device.name, host: device.host, kind: 'tcp', port: device.port }, 'geraet')
    if (settings.includeProxmox) for (const guest of guests.slice(0, 64)) add({ name: guest.name, host: guest.host, kind: guest.kind || 'ping', port: guest.port }, 'proxmox')
    return { targets, rejected }
}

// ---------------------------------------------------------------------------
// Entprellen
// ---------------------------------------------------------------------------

export interface TargetState {
    fails: number
    alarmed: boolean
    since?: string
    lastOkAt?: string
    lastMs?: number | null
    lastDetail?: string
    thoughtId?: string
}

export type DebounceEvent = 'alarm' | 'erholt' | null

export function debounce(previous: TargetState | undefined, ok: boolean, threshold: number, at: string): { state: TargetState; event: DebounceEvent } {
    const state: TargetState = { fails: 0, alarmed: false, ...previous }
    if (ok) {
        const event: DebounceEvent = state.alarmed ? 'erholt' : null
        return { state: { fails: 0, alarmed: false, lastOkAt: at, ...(state.thoughtId ? { thoughtId: state.thoughtId } : {}) }, event }
    }
    const fails = state.fails + 1
    if (!state.alarmed && fails >= threshold) return { state: { ...state, fails, alarmed: true, since: state.since ?? at }, event: 'alarm' }
    return { state: { ...state, fails, since: state.since ?? at }, event: null }
}

// ---------------------------------------------------------------------------
// Alarme → Gedanken
// ---------------------------------------------------------------------------

export interface WatchAction { kind: string; node?: string; target?: string; text: string }

export interface WatchAlarm {
    key: string
    title: string
    evidence: string
    severity: 'critical' | 'warning' | 'info'
    action?: WatchAction
}

export interface WatchThoughtPort {
    add(input: NewThought, action?: WatchAction & { verdict: PolicyVerdict }): { thought: { id: string }; deduped?: boolean }
    resolve?(thoughtId: string): void
}

/** Runs an L1 action through an existing path (self-heal). Optional. */
export type WatchL1Runner = (action: WatchAction) => Promise<{ ok: boolean; message: string }>

export function alarmToThought(alarm: WatchAlarm, localNodeId: string): { input: NewThought; verdict: PolicyVerdict | null } {
    const verdict = alarm.action ? evaluateAction({ kind: alarm.action.kind, node: alarm.action.node, target: alarm.action.target, origin: 'code' }, { localNodeId }) : null
    const permission = !verdict ? 'selbst' : verdict.decision === 'ask' ? 'fragen' : verdict.decision === 'auto' ? 'selbst' : 'nie'
    return {
        verdict,
        input: {
            source: THOUGHT_SOURCE,
            title: alarm.title,
            evidence: alarm.evidence,
            severity: alarm.severity,
            kind: verdict?.decision === 'ask' ? 'vorschlag' : 'ereignis',
            ...(alarm.action ? { proposal: `${alarm.action.text} [${verdict!.level}: ${verdict!.reason}]` } : {}),
            permission,
            // Stable key: changing numbers (days, ms) must not defeat dedupe.
            signature: `waechter:${alarm.key}`,
            ...(alarm.action?.node ? { node: alarm.action.node } : {}),
        },
    }
}

const fmtDays = (days: number) => days < 1 ? `${Math.max(0, Math.round(days * 24))} h` : `${days.toFixed(1).replace('.', ',')} Tagen`

export function forecastAlarm(forecast: Forecast, kind: 'platte' | 'ram', localNodeId: string): WatchAlarm {
    const own = forecast.nodeId === localNodeId
    if (kind === 'platte') {
        const severity = diskSeverity(forecast.daysLeft) === 'critical' ? 'critical' : 'warning'
        return {
            key: `platte:${forecast.nodeId}:${forecast.subject}`,
            title: `Platte ${forecast.subject} auf ${forecast.nodeId} voll in ca. ${fmtDays(forecast.daysLeft)}`,
            evidence: `jetzt ${forecast.current.toFixed(1)} %, +${forecast.perDay.toFixed(2)} %-Punkte/Tag (Regression über ${TREND_WINDOW_DAYS} Tage)`,
            severity,
            action: {
                kind: 'self-heal-zyklus', node: forecast.nodeId,
                text: own ? 'Selbstheilung: eigene Logs rotieren und eigene Caches leeren (nichts anderes wird gelöscht)' : `Selbstheilung auf ${forecast.nodeId} anstoßen bzw. dort Platz schaffen`,
            },
        }
    }
    return {
        key: `ram:${forecast.nodeId}`,
        title: `RAM auf ${forecast.nodeId} steigt: ${forecast.limit} % in ca. ${fmtDays(forecast.daysLeft)}`,
        evidence: `jetzt ${forecast.current.toFixed(1)} %, +${forecast.perDay.toFixed(2)} %-Punkte/Tag`,
        severity: 'warning',
        action: { kind: 'melden', node: forecast.nodeId, text: 'Speicherfresser prüfen (nur Meldung)' },
    }
}

export function reachabilityAlarm(result: ReachabilityResult, state: TargetState, event: 'alarm' | 'erholt', threshold: number): WatchAlarm {
    const { target } = result
    const label = `${target.name} (${target.kind}${target.port ? ` ${target.host}:${target.port}` : ` ${target.host}`})`
    // One key per outage: the debounce already alarms once per outage, and a
    // new outage after a recovery must not be swallowed by the dedupe window.
    const outage = state.since ?? result.at
    if (event === 'erholt') {
        return { key: `erholt:${target.id}:${outage}`, title: `${target.name} wieder erreichbar`, evidence: `${label}: ${result.detail}${result.ms !== null ? `, ${result.ms} ms` : ''}; ausgefallen seit ${state.since ?? '?'}`, severity: 'warning' }
    }
    return {
        key: `ziel:${target.id}:${outage}`,
        title: `${target.name} nicht erreichbar`,
        evidence: `${label}: ${result.detail}; ${threshold}× in Folge seit ${state.since ?? result.at}`,
        severity: 'warning',
        action: {
            kind: 'dienst-neustart', target: target.name,
            text: `${target.name} prüfen/neu starten. Ja vermerkt nur die Freigabe — einen Neustart-Ausführer für fremde Geräte gibt es nicht, ich starte nichts selbst neu.`,
        },
    }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface WatchState {
    version: 1
    targets: Record<string, TargetState>
    lastTlsAt?: number
    certs?: Array<{ name: string; host: string; port: number; validTo: number | null; daysLeft: number | null; severity: TrendSeverity | 'unbekannt' }>
}

export interface WatchSnapshot {
    at: string
    reachability: Array<{ id: string; name: string; kind: string; origin: string; ok: boolean; ms: number | null; detail: string; fails: number; alarmed: boolean }>
    forecasts: Array<Forecast & { kind: 'platte' | 'ram' }>
    certs: NonNullable<WatchState['certs']>
    backups: Array<{ name: string; ageHours: number | null; maxAgeHours: number; severity: TrendSeverity }>
    rejected: string[]
}

export interface WatchEngineDeps {
    settings: WatchSettings
    watchDir: string
    localNodeId: string
    isMain: () => boolean
    collect: () => Promise<WatchSample>
    devices: () => DeviceLike[]
    proxmox?: ProxmoxGuestSource
    probes: WatchProbeDeps
    thoughts: WatchThoughtPort
    runL1?: WatchL1Runner
}

export interface WatchTickResult { active: boolean; reason: string; alarms?: number; recovered?: number; targets?: number }

export function loadWatchState(watchDir: string): WatchState {
    try {
        const raw = JSON.parse(readFileSync(join(watchDir, 'state.json'), 'utf8'))
        if (raw?.version === 1 && raw.targets && typeof raw.targets === 'object') return raw as WatchState
    } catch { /* fresh */ }
    return { version: 1, targets: {} }
}

export function loadWatchSnapshot(watchDir: string): WatchSnapshot | null {
    try { return JSON.parse(readFileSync(join(watchDir, 'snapshot.json'), 'utf8')) as WatchSnapshot } catch { return null }
}

function save(watchDir: string, name: string, value: unknown): void {
    if (!existsSync(watchDir)) mkdirSync(watchDir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(join(watchDir, name), value)
}

export function createWatchEngine(deps: WatchEngineDeps) {
    const { settings } = deps
    let running: Promise<WatchTickResult> | null = null

    const raise = async (alarm: WatchAlarm): Promise<string> => {
        const { input, verdict } = alarmToThought(alarm, deps.localNodeId)
        const { thought, deduped } = deps.thoughts.add(input, alarm.action && verdict ? { ...alarm.action, verdict } : undefined)
        // L1 on the own node runs once per new alarm through the existing
        // self-heal path; never anything above L1.
        if (!deduped && alarm.action && verdict && verdict.decision === 'auto' && verdict.level === 'L1' && deps.runL1) {
            await deps.runL1(alarm.action).catch(() => undefined)
        }
        return thought.id
    }

    async function run(): Promise<WatchTickResult> {
        if (!settings.enabled) return { active: false, reason: 'aus (autonomy.watch.enabled ist nicht true)' }
        let main = false
        try { main = deps.isMain() === true } catch { main = false }
        if (!main) return { active: false, reason: 'kein Main — Worker melden nur ihre Messwerte über das Mesh' }
        const now = deps.probes.now()
        const at = new Date(now).toISOString()
        const state = loadWatchState(deps.watchDir)
        let alarms = 0, recovered = 0

        // 1. Messverlauf
        try { appendWatchSample(deps.watchDir, { ...(await deps.collect()), nodeId: deps.localNodeId }, settings.maxBytes) } catch { /* sample optional */ }
        try { maintainWatchStore(deps.watchDir, { retentionDays: settings.retentionDays, maxBytes: settings.maxBytes, now }) } catch { /* next tick */ }

        // 2. Erreichbarkeit
        let guests: Awaited<ReturnType<ProxmoxGuestSource>> = []
        if (settings.includeProxmox && deps.proxmox) { try { guests = await deps.proxmox() } catch { guests = [] } }
        let devices: DeviceLike[] = []
        try { devices = deps.devices() } catch { devices = [] }
        const { targets, rejected } = resolveWatchTargets(settings, devices, guests)
        const results = await probeTargets(targets, deps.probes, settings.timeoutMs)
        const nextTargets: Record<string, TargetState> = {}
        for (const result of results) {
            const { state: next, event } = debounce(state.targets[result.target.id], result.ok, settings.failThreshold, result.at)
            next.lastMs = result.ms
            next.lastDetail = result.detail
            if (event === 'alarm') { next.thoughtId = await raise(reachabilityAlarm(result, next, 'alarm', settings.failThreshold)); alarms++ }
            if (event === 'erholt') {
                if (next.thoughtId) deps.thoughts.resolve?.(next.thoughtId)
                await raise(reachabilityAlarm(result, state.targets[result.target.id] ?? next, 'erholt', settings.failThreshold))
                next.thoughtId = undefined
                recovered++
            }
            nextTargets[result.target.id] = next
        }
        state.targets = nextTargets

        // 3. Prognosen
        const samples = readWatchSamples(deps.watchDir, { sinceMs: now - TREND_WINDOW_DAYS * DAY_MS })
        const forecasts = [
            ...diskForecasts(samples, now).map(item => ({ ...item, kind: 'platte' as const })),
            ...ramForecasts(samples, now).map(item => ({ ...item, kind: 'ram' as const })),
        ]
        for (const forecast of forecasts) { await raise(forecastAlarm(forecast, forecast.kind, deps.localNodeId)); alarms++ }

        if (settings.tls.length && (!state.lastTlsAt || now - state.lastTlsAt >= TLS_INTERVAL_MS)) {
            state.lastTlsAt = now
            state.certs = []
            for (const { host, validTo } of await readCertificates(settings.tls, deps.probes, settings.timeoutMs)) {
                if (validTo === null) {
                    state.certs.push({ ...host, validTo: null, daysLeft: null, severity: 'unbekannt' })
                    continue
                }
                const { severity, daysLeft } = certSeverity(validTo, now, settings.tlsWarnDays)
                state.certs.push({ ...host, validTo, daysLeft: Math.round(daysLeft * 10) / 10, severity })
                if (severity === 'ok') continue
                alarms++
                await raise({
                    key: `tls:${host.host}:${host.port}`,
                    title: daysLeft < 0 ? `TLS-Zertifikat von ${host.name} abgelaufen` : `TLS-Zertifikat von ${host.name} läuft in ${Math.max(0, Math.floor(daysLeft))} Tagen ab`,
                    evidence: `${host.host}:${host.port}, gültig bis ${new Date(validTo).toISOString().slice(0, 10)}`,
                    severity: severity === 'critical' ? 'critical' : 'warning',
                    action: { kind: 'melden', text: 'Zertifikat erneuern (Alfred; ich ändere keine Zertifikate)' },
                })
            }
        }

        const backups: WatchSnapshot['backups'] = []
        for (const { backup, newest } of readBackupAges(settings.backups, deps.probes)) {
            const { severity, ageHours } = backupSeverity(newest, now, backup.maxAgeHours)
            backups.push({ name: backup.name, ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10, maxAgeHours: backup.maxAgeHours, severity })
            if (severity === 'ok') continue
            alarms++
            await raise({
                key: `backup:${backup.name}`,
                title: ageHours === null ? `Backup ${backup.name}: nichts gefunden` : `Backup ${backup.name} ist ${Math.round(ageHours)} h alt`,
                evidence: `${backup.path}${backup.pattern ? ` (${backup.pattern})` : ''}: erlaubt ${backup.maxAgeHours} h; nur Dateialter geprüft, kein Inhalt gelesen`,
                severity: severity === 'critical' ? 'critical' : 'warning',
                action: { kind: 'melden', text: 'Backup-Job prüfen (nur Meldung)' },
            })
        }

        save(deps.watchDir, 'state.json', state)
        const snapshot: WatchSnapshot = {
            at,
            reachability: results.map(result => ({
                id: result.target.id, name: result.target.name, kind: result.target.kind, origin: result.target.origin,
                ok: result.ok, ms: result.ms, detail: result.detail, fails: nextTargets[result.target.id]?.fails ?? 0, alarmed: nextTargets[result.target.id]?.alarmed ?? false,
            })),
            forecasts, certs: state.certs ?? [], backups,
            rejected: [...settings.rejected, ...rejected],
        }
        save(deps.watchDir, 'snapshot.json', snapshot)
        return { active: true, reason: 'gemessen', alarms, recovered, targets: targets.length }
    }

    return {
        settings,
        tick(): Promise<WatchTickResult> {
            if (running) return running
            running = run().finally(() => { running = null })
            return running
        },
    }
}

// ---------------------------------------------------------------------------
// Übersicht (Datenquelle für /waechter, /status, Dashboard, G2-HUD)
// ---------------------------------------------------------------------------

export interface WatchNodeView {
    nodeId: string
    at: string
    ageMinutes: number
    cpuLoad: number | null
    ramUsedPct: number
    disks: WatchSample['disks']
    tempC: number | null
    responseMs: number | null
    servicesDown: string[]
}

export interface WatchOverview {
    enabled: boolean
    generatedAt: string
    nodes: WatchNodeView[]
    snapshot: WatchSnapshot | null
    store: { days: number; bytes: number; oldest: string | null; retentionDays: number; maxBytes: number }
}

export function buildWatchOverview(settings: WatchSettings, watchDir: string, now = Date.now()): WatchOverview {
    const latest = new Map<string, WatchSample>()
    for (const sample of readWatchSamples(watchDir, { sinceMs: now - DAY_MS })) latest.set(sample.nodeId, sample)
    const nodes = [...latest.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(sample => ({
        nodeId: sample.nodeId, at: sample.at, ageMinutes: Math.max(0, Math.round((now - Date.parse(sample.at)) / 60_000)),
        cpuLoad: sample.cpuLoad, ramUsedPct: sample.ramUsedPct, disks: sample.disks, tempC: sample.tempC, responseMs: sample.responseMs,
        servicesDown: sample.services.filter(service => service.status !== 'running').map(service => service.name),
    }))
    return {
        enabled: settings.enabled,
        generatedAt: new Date(now).toISOString(),
        nodes,
        snapshot: loadWatchSnapshot(watchDir),
        store: { ...watchStoreStats(watchDir), retentionDays: settings.retentionDays, maxBytes: settings.maxBytes },
    }
}

const pctText = (value: number | null | undefined) => value === null || value === undefined ? '–' : `${Math.round(value)} %`

export function formatWaechter(overview: WatchOverview, principal?: { permission?: string }): string {
    if (principal?.permission !== 'owner') return 'Der Wächter ist nur für den Owner verfügbar.'
    const lines = [`*Wächter* — ${overview.enabled ? 'AN' : 'AUS (autonomy.watch.enabled ist nicht true)'} · nur lesend`]
    if (!overview.nodes.length) lines.push('', 'Noch keine Messwerte (letzte 24 h).')
    for (const node of overview.nodes) {
        const stale = node.ageMinutes > 15
        const disks = node.disks.map(disk => `${disk.mount} ${pctText(disk.usedPct)} (${disk.freeGB} GB frei)`).join(', ') || '–'
        lines.push('', `${stale ? '❔' : '•'} *${node.nodeId}* (vor ${node.ageMinutes} min${stale ? ', veraltet' : ''})`,
            `  Last ${node.cpuLoad ?? '–'} je Kern · RAM ${pctText(node.ramUsedPct)} · ${node.tempC !== null ? `${node.tempC} °C · ` : ''}Antwort ${node.responseMs ?? '–'} ms`,
            `  Platten: ${disks}`)
        if (node.servicesDown.length) lines.push(`  Dienste nicht laufend: ${node.servicesDown.join(', ')}`)
    }
    const snap = overview.snapshot
    if (snap) {
        const down = snap.reachability.filter(item => !item.ok)
        lines.push('', `*Erreichbarkeit* (${snap.reachability.length - down.length}/${snap.reachability.length} ok, Stand ${snap.at})`)
        for (const item of snap.reachability) lines.push(`  ${item.ok ? '✅' : item.alarmed ? '❌' : '⚠️'} ${JSON.stringify(item.name)} ${item.kind}${item.origin !== 'config' ? ` [${item.origin}]` : ''}: ${item.detail}${item.ms !== null ? `, ${item.ms} ms` : ''}${item.fails ? ` (${item.fails}× Fehler)` : ''}`)
        if (snap.forecasts.length) {
            lines.push('', '*Prognosen*')
            for (const item of snap.forecasts) lines.push(`  ⏳ ${item.nodeId} ${item.subject}: ${item.limit} % in ${fmtDays(item.daysLeft)} (+${item.perDay.toFixed(2)}/Tag)`)
        }
        if (snap.certs.length) {
            lines.push('', '*TLS*')
            for (const cert of snap.certs) lines.push(`  ${cert.severity === 'ok' ? '✅' : cert.severity === 'unbekannt' ? '❔' : '⚠️'} ${cert.name}: ${cert.daysLeft === null ? 'nicht lesbar' : `${Math.floor(cert.daysLeft)} Tage`}`)
        }
        if (snap.backups.length) {
            lines.push('', '*Backups*')
            for (const backup of snap.backups) lines.push(`  ${backup.severity === 'ok' ? '✅' : '⚠️'} ${backup.name}: ${backup.ageHours === null ? 'nichts gefunden' : `${Math.round(backup.ageHours)} h alt`} (erlaubt ${backup.maxAgeHours} h)`)
        }
        if (snap.rejected.length) lines.push('', `Ausgelassen: ${snap.rejected.slice(0, 8).join('; ')}`)
    }
    lines.push('', `Verlauf: ${overview.store.days} Tage, ${Math.round(overview.store.bytes / 1024)} KB (max. ${overview.store.retentionDays} Tage / ${Math.round(overview.store.maxBytes / 1024 / 1024)} MB)`)
    return lines.join('\n')
}

/** Two or three compact lines for /status (owner only). */
export function formatWatchStatusLines(overview: WatchOverview): string[] {
    if (!overview.enabled) return ['Wächter: aus']
    const snap = overview.snapshot
    const down = snap?.reachability.filter(item => item.alarmed).map(item => item.name) ?? []
    const worstDisk = overview.nodes.flatMap(node => node.disks.map(disk => ({ node: node.nodeId, ...disk }))).sort((a, b) => b.usedPct - a.usedPct)[0]
    const lines = [`Wächter: ${overview.nodes.length} Knoten, ${snap ? `${(snap.reachability.length - down.length)}/${snap.reachability.length} Ziele ok` : 'noch kein Lauf'}${worstDisk ? `, volleste Platte ${worstDisk.node} ${worstDisk.mount} ${pctText(worstDisk.usedPct)}` : ''}`]
    if (down.length) lines.push(`  ❌ nicht erreichbar: ${down.slice(0, 5).join(', ')}`)
    const soon = snap?.forecasts.filter(item => item.kind === 'platte') ?? []
    if (soon.length) lines.push(`  ⏳ Platte voll: ${soon.slice(0, 3).map(item => `${item.nodeId} ${item.subject} in ${fmtDays(item.daysLeft)}`).join(', ')}`)
    return lines
}
