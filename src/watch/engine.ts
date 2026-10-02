/**
 * Wächter (Phase 7) — the engine: measure, probe, forecast, alarm.
 *
 * Runs only on the Main (with autonomy authority). Per tick:
 *   1. own sample → Messverlauf (workers' samples arrive via the signed mesh)
 *   2. Erreichbarkeit of the resolved target list, entprellt: alarm only after
 *      `failThreshold` failures in a row, recovery is reported once
 *   2b. Nachtwache-Prüfungen (2.82.0: der Wächter ist ihr einziger Ausführer;
 *      eigener Takt aus nightwatch.json, Journal bleibt): Alarm einmal je
 *      Ausfall, Erholung einmal
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
import type { NightwatchReport } from '../doctor/nightwatch.js'
import { probeTargets, readBackupAges, readCertificates, type ReachabilityResult, type WatchProbeDeps } from './probes.js'
import type { WatchSample } from './sample.js'
import { withoutOwnerDuplicates, type DerivedResult } from './derived.js'
import { normalizeWatchTarget, type WatchSettings, type WatchTarget, type WatchTlsHost } from './settings.js'
import { appendWatchSample, maintainWatchStore, readWatchSamples, watchStoreStats } from './store.js'
import { backupSeverity, certSeverity, DAY_MS, diskForecasts, diskSeverity, ramForecasts, TREND_WINDOW_DAYS, type Forecast, type TrendSeverity } from './trends.js'

export const THOUGHT_SOURCE = 'waechter'
const TLS_INTERVAL_MS = 6 * 60 * 60_000

// ---------------------------------------------------------------------------
// Ziele: Config-Liste + eigene Liste (/monitor, übernommene L19-Ziele) + eingerichtete Geräte
// + 2.85 selbst abgeleitete Ziele (watch/derived.ts; Owner-Ziele haben Vorrang)
// (2.82.0: kein Proxmox-Zweig — Gast-Status meldet allein der Proxmox-Sensing-Adapter)
// ---------------------------------------------------------------------------

export interface DeviceLike { name: string; host: string; port: number }

export function resolveWatchTargets(settings: WatchSettings, devices: readonly DeviceLike[], managed: readonly WatchTarget[] = [], derived: readonly WatchTarget[] = []): { targets: WatchTarget[]; rejected: string[] } {
    const targets = [...settings.targets]
    const rejected: string[] = []
    for (const target of managed.slice(0, 64)) if (!targets.some(existing => existing.id === target.id)) targets.push(target)
    if (settings.includeDevices) {
        for (const device of devices.slice(0, 64)) {
            const target = normalizeWatchTarget({ name: device.name, host: device.host, kind: 'tcp', port: device.port }, 'geraet')
            if (typeof target === 'string') rejected.push(target)
            else if (!targets.some(existing => existing.id === target.id)) targets.push(target)
        }
    }
    targets.push(...withoutOwnerDuplicates(derived, targets))
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
    /** 2.85: a self-derived target that failed before it was ever reachable — no alarm, no recovery message. */
    silent?: boolean
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
    // 2.85: a self-derived target (nobody set it up) is reported as an event
    // only — no restart suggestion, so no card.
    const derived = target.origin === 'selbst'
    if (event === 'erholt') {
        return { key: `erholt:${target.id}:${outage}`, title: `${target.name} wieder erreichbar`, evidence: `${label}: ${result.detail}${result.ms !== null ? `, ${result.ms} ms` : ''}; ausgefallen seit ${state.since ?? '?'}`, severity: 'warning' }
    }
    return {
        key: `ziel:${target.id}:${outage}`,
        title: `${target.name} nicht erreichbar`,
        evidence: `${label}: ${result.detail}; ${threshold}× in Folge seit ${state.since ?? result.at}`,
        severity: 'warning',
        ...(derived ? {} : { action: {
            kind: 'dienst-neustart', target: target.name,
            text: `${target.name} prüfen/neu starten. Ja vermerkt nur die Freigabe — einen Neustart-Ausführer für fremde Geräte gibt es nicht, ich starte nichts selbst neu.`,
        } }),
    }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface NightwatchState { alarmed: boolean; since: string; thoughtId?: string; label: string }

export interface WatchState {
    version: 1
    targets: Record<string, TargetState>
    /** Nachtwache-Prüfungen, Schlüssel `id@host` (2.82.0). */
    nightwatch?: Record<string, NightwatchState>
    lastTlsAt?: number
    certs?: Array<{ name: string; host: string; port: number; validTo: number | null; daysLeft: number | null; severity: TrendSeverity | 'unbekannt' }>
}

export interface WatchSnapshot {
    at: string
    /** `silent`: self-derived and never reached from here (no alarm, not counted as ok). */
    reachability: Array<{ id: string; name: string; kind: string; origin: string; ok: boolean; ms: number | null; detail: string; fails: number; alarmed: boolean; silent?: boolean }>
    forecasts: Array<Forecast & { kind: 'platte' | 'ram' }>
    certs: NonNullable<WatchState['certs']>
    backups: Array<{ name: string; ageHours: number | null; maxAgeHours: number; severity: TrendSeverity }>
    /** Letzter Nachtwache-Lauf (nur wenn die Nachtwache an ist). */
    nightwatch?: { at: string; total: number; failing: Array<{ id: string; label: string; host: string; status: string; message: string }>; error?: string }
    rejected: string[]
}

export interface WatchEngineDeps {
    settings: WatchSettings
    watchDir: string
    localNodeId: string
    isMain: () => boolean
    collect: () => Promise<WatchSample>
    devices: () => DeviceLike[]
    /** Targets from /monitor and the migrated L19 list (watch/targets.ts). */
    managedTargets?: () => WatchTarget[]
    /** 2.85: self-derived targets and TLS hosts (watch/derived.ts). */
    derivedTargets?: () => DerivedResult | Promise<DerivedResult>
    /** Nachtwache runner: a fresh report when due, else null (doctor/nightwatch.ts). */
    nightwatch?: () => Promise<NightwatchReport | null>
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

/**
 * Nachtwache-Befunde → Wächter-Alarme (2.82.0, ein Wächter): einmal je Ausfall,
 * die Erholung einmal. Vorher meldeten Planer-Job (`nachtwache:…`),
 * Wahrnehmen-system-Adapter (`nightwatch:…`) und die Schleife denselben Befund.
 */
export async function applyNightwatchReport(
    report: NightwatchReport,
    state: WatchState,
    raise: (alarm: WatchAlarm) => Promise<string>,
    thoughts: WatchThoughtPort,
): Promise<{ alarms: number; recovered: number; view: NonNullable<WatchSnapshot['nightwatch']> }> {
    const known = state.nightwatch ??= {}
    let alarms = 0, recovered = 0
    const recover = async (key: string, title: string, evidence: string) => {
        const previous = known[key]
        if (previous.thoughtId) thoughts.resolve?.(previous.thoughtId)
        await raise({ key: `nachtwache-erholt:${key}:${previous.since}`, title, evidence: `${evidence}; gestört seit ${previous.since}`, severity: 'warning' })
        delete known[key]
        recovered++
    }
    if (report.error) {
        if (!known.lauf) {
            const thoughtId = await raise({ key: `nachtwache:lauf:${report.startedAt}`, title: 'Nachtwache läuft nicht', evidence: report.error, severity: 'warning' })
            known.lauf = { alarmed: true, since: report.startedAt, thoughtId, label: 'Nachtwache' }
            alarms++
        }
        return { alarms, recovered, view: { at: report.startedAt, total: 0, failing: [], error: report.error.slice(0, 300) } }
    }
    if (known.lauf) await recover('lauf', 'Nachtwache läuft wieder', `${report.results.length} Prüfungen gelaufen`)
    const seen = new Set<string>()
    for (const result of report.results) {
        const key = `${result.id}@${result.host}`
        seen.add(key)
        const failing = result.status !== 'ok'
        if (failing && !known[key]) {
            const thoughtId = await raise({
                key: `nachtwache:${result.id}:${result.host}:${report.startedAt}`,
                title: `Nachtwache: ${result.label} (${result.host})`,
                evidence: `${result.status === 'unbekannt' ? 'nicht prüfbar – ' : ''}${result.message} — Beleg: ${JSON.stringify(result.evidence?.command ?? '')} → Exit ${result.evidence?.exitCode ?? '–'}`,
                severity: result.severity === 'critical' ? 'critical' : 'warning',
            })
            known[key] = { alarmed: true, since: report.startedAt, thoughtId, label: result.label }
            alarms++
        } else if (!failing && known[key]) {
            await recover(key, `Nachtwache: ${result.label} (${result.host}) wieder ok`, result.message)
        }
    }
    // A check removed from nightwatch.json: close its open alarm quietly.
    for (const key of Object.keys(known)) {
        if (key === 'lauf' || seen.has(key)) continue
        if (known[key].thoughtId) thoughts.resolve?.(known[key].thoughtId!)
        delete known[key]
    }
    const failing = report.results.filter(result => result.status !== 'ok').slice(0, 20)
        .map(result => ({ id: result.id, label: result.label, host: result.host, status: result.status, message: String(result.message || '').slice(0, 160) }))
    return { alarms, recovered, view: { at: report.startedAt, total: report.results.length, failing } }
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
        let devices: DeviceLike[] = []
        try { devices = deps.devices() } catch { devices = [] }
        let managed: WatchTarget[] = []
        try { managed = deps.managedTargets?.() ?? [] } catch { managed = [] }
        let derived: DerivedResult = { targets: [], tls: [] }
        try { derived = (await deps.derivedTargets?.()) ?? derived } catch { derived = { targets: [], tls: [] } }
        const { targets, rejected } = resolveWatchTargets(settings, devices, managed, derived.targets)
        const results = await probeTargets(targets, deps.probes, settings.timeoutMs)
        const nextTargets: Record<string, TargetState> = {}
        for (const result of results) {
            const previous = state.targets[result.target.id]
            const { state: next, event } = debounce(previous, result.ok, settings.failThreshold, result.at)
            next.lastMs = result.ms
            next.lastDetail = result.detail
            // 2.85: a self-derived target that was never reachable from here
            // stays silent (no guessing about addresses that may be private).
            if (event === 'alarm' && result.target.origin === 'selbst' && !next.lastOkAt) next.silent = true
            else if (event === 'alarm') { next.thoughtId = await raise(reachabilityAlarm(result, next, 'alarm', settings.failThreshold)); alarms++ }
            if (event === 'erholt' && previous?.silent) { /* first contact, nothing to report */ }
            else if (event === 'erholt') {
                if (next.thoughtId) deps.thoughts.resolve?.(next.thoughtId)
                await raise(reachabilityAlarm(result, state.targets[result.target.id] ?? next, 'erholt', settings.failThreshold))
                next.thoughtId = undefined
                recovered++
            }
            nextTargets[result.target.id] = next
        }
        state.targets = nextTargets

        // 2b. Nachtwache (only when due; its own interval from nightwatch.json)
        let nightwatchView: WatchSnapshot['nightwatch'] | undefined = loadWatchSnapshot(deps.watchDir)?.nightwatch
        if (deps.nightwatch) {
            let report: NightwatchReport | null = null
            try { report = await deps.nightwatch() } catch { report = null }
            if (report) {
                const outcome = await applyNightwatchReport(report, state, raise, deps.thoughts)
                alarms += outcome.alarms
                recovered += outcome.recovered
                nightwatchView = outcome.view
            }
        }

        // 3. Prognosen
        const samples = readWatchSamples(deps.watchDir, { sinceMs: now - TREND_WINDOW_DAYS * DAY_MS })
        const forecasts = [
            ...diskForecasts(samples, now).map(item => ({ ...item, kind: 'platte' as const })),
            ...ramForecasts(samples, now).map(item => ({ ...item, kind: 'ram' as const })),
        ]
        for (const forecast of forecasts) { await raise(forecastAlarm(forecast, forecast.kind, deps.localNodeId)); alarms++ }

        const tlsHosts: WatchTlsHost[] = [...settings.tls]
        for (const host of derived.tls) if (!tlsHosts.some(item => item.host === host.host && item.port === host.port)) tlsHosts.push(host)
        if (tlsHosts.length && (!state.lastTlsAt || now - state.lastTlsAt >= TLS_INTERVAL_MS)) {
            state.lastTlsAt = now
            state.certs = []
            for (const { host, validTo } of await readCertificates(tlsHosts, deps.probes, settings.timeoutMs)) {
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
                ok: result.ok, ms: result.ms, detail: result.detail, fails: nextTargets[result.target.id]?.fails ?? 0,
                alarmed: (nextTargets[result.target.id]?.alarmed ?? false) && !nextTargets[result.target.id]?.silent,
                ...(nextTargets[result.target.id]?.silent ? { silent: true } : {}),
            })),
            forecasts, certs: state.certs ?? [], backups,
            ...(nightwatchView ? { nightwatch: nightwatchView } : {}),
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
    /** 2.85: `messung` = Wächter-Messverlauf, `herzschlag` = Werte aus dem signierten Mesh-Herzschlag (keine eigene Messung). */
    source: 'messung' | 'herzschlag'
}

/** A peer as the mesh transport knows it (signed heartbeat/capabilities, mesh-peer-state.json). */
export interface WatchPeerHeartbeat { nodeId: string; lastSeen: number; hardware?: Record<string, unknown> | null }

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * Werte eines Knotens aus seinem Herzschlag (2.85): RAM, Last je Kern,
 * Temperatur, Platte (Stand Anmeldung). Keine neue Verbindung — nur was der
 * Knoten ohnehin alle 30 s signiert sendet. Ohne RAM-Wert: kein Eintrag.
 */
export function heartbeatNodeView(peer: WatchPeerHeartbeat, now: number): WatchNodeView | null {
    const hw = peer.hardware ?? {}
    const ram = num(hw.ram_used_percent)
    if (ram === null || !Number.isFinite(peer.lastSeen)) return null
    const cores = Math.max(1, num(hw.cores) ?? 1)
    const load = num(hw.cpu_load)
    const diskTotal = num(hw.disk_gb), diskFree = num(hw.disk_free_gb)
    const disks = diskTotal && diskTotal > 0 && diskFree !== null
        ? [{ mount: '/ (beim Start)', usedPct: Math.round(Math.max(0, Math.min(100, (1 - diskFree / diskTotal) * 100)) * 10) / 10, totalGB: diskTotal, freeGB: diskFree }]
        : []
    return {
        nodeId: String(peer.nodeId).slice(0, 80), at: new Date(peer.lastSeen).toISOString(), ageMinutes: Math.max(0, Math.round((now - peer.lastSeen) / 60_000)),
        cpuLoad: load === null ? null : Math.round(load / cores * 100) / 100, ramUsedPct: Math.max(0, Math.min(100, ram)), disks,
        tempC: num(hw.temp), responseMs: null, servicesDown: [], source: 'herzschlag',
    }
}

export interface WatchOverview {
    enabled: boolean
    generatedAt: string
    nodes: WatchNodeView[]
    snapshot: WatchSnapshot | null
    store: { days: number; bytes: number; oldest: string | null; retentionDays: number; maxBytes: number }
}

export function buildWatchOverview(settings: WatchSettings, watchDir: string, now = Date.now(), peers: readonly WatchPeerHeartbeat[] = []): WatchOverview {
    const latest = new Map<string, WatchSample>()
    for (const sample of readWatchSamples(watchDir, { sinceMs: now - DAY_MS })) latest.set(sample.nodeId, sample)
    const nodes: WatchNodeView[] = [...latest.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(sample => ({
        nodeId: sample.nodeId, at: sample.at, ageMinutes: Math.max(0, Math.round((now - Date.parse(sample.at)) / 60_000)),
        cpuLoad: sample.cpuLoad, ramUsedPct: sample.ramUsedPct, disks: sample.disks, tempC: sample.tempC, responseMs: sample.responseMs,
        servicesDown: sample.services.filter(service => service.status !== 'running').map(service => service.name),
        source: 'messung' as const,
    }))
    // 2.85: nodes without an own sample (watch off on the worker) still show
    // up with the values of their signed heartbeat (last 24 h).
    for (const peer of peers) {
        if (!peer?.nodeId || latest.has(peer.nodeId) || nodes.some(node => node.nodeId === peer.nodeId) || now - peer.lastSeen > DAY_MS) continue
        const view = heartbeatNodeView(peer, now)
        if (view) nodes.push(view)
    }
    nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    return {
        enabled: settings.enabled,
        generatedAt: new Date(now).toISOString(),
        nodes,
        snapshot: loadWatchSnapshot(watchDir),
        store: { ...watchStoreStats(watchDir), retentionDays: settings.retentionDays, maxBytes: settings.maxBytes },
    }
}

/** The real number of watched targets: the targets of the last round (2.85; was config + /monitor only). */
export function countWatchTargets(overview: Pick<WatchOverview, 'snapshot'>, beforeFirstRound = 0): number {
    return overview.snapshot?.reachability.length ?? beforeFirstRound
}

const pctText = (value: number | null | undefined) => value === null || value === undefined ? '–' : `${Math.round(value)} %`

export function formatWaechter(overview: WatchOverview, principal?: { permission?: string }): string {
    if (principal?.permission !== 'owner') return 'Der Wächter ist nur für den Owner verfügbar.'
    const lines = [`*Wächter* — ${overview.enabled ? 'AN' : 'AUS (autonomy.watch.enabled ist nicht true)'} · nur lesend`]
    if (!overview.nodes.length) lines.push('', 'Noch keine Messwerte (letzte 24 h).')
    for (const node of overview.nodes) {
        const stale = node.ageMinutes > 15
        const disks = node.disks.map(disk => `${disk.mount} ${pctText(disk.usedPct)} (${disk.freeGB} GB frei)`).join(', ') || '–'
        lines.push('', `${stale ? '❔' : '•'} *${node.nodeId}* (vor ${node.ageMinutes} min${stale ? ', veraltet' : ''}${node.source === 'herzschlag' ? ', aus dem Herzschlag' : ''})`,
            `  Last ${node.cpuLoad ?? '–'} je Kern · RAM ${pctText(node.ramUsedPct)} · ${node.tempC !== null ? `${node.tempC} °C · ` : ''}Antwort ${node.responseMs ?? '–'} ms`,
            `  Platten: ${disks}`)
        if (node.servicesDown.length) lines.push(`  Dienste nicht laufend: ${node.servicesDown.join(', ')}`)
    }
    const snap = overview.snapshot
    if (snap) {
        const down = snap.reachability.filter(item => !item.ok)
        lines.push('', `*Erreichbarkeit* (${snap.reachability.length - down.length}/${snap.reachability.length} ok, Stand ${snap.at})`)
        for (const item of snap.reachability) lines.push(`  ${item.ok ? '✅' : item.silent ? '❔' : item.alarmed ? '❌' : '⚠️'} ${JSON.stringify(item.name)} ${item.kind}${item.origin === 'selbst' ? ' [selbst abgeleitet]' : item.origin !== 'config' ? ` [${item.origin}]` : ''}: ${item.detail}${item.ms !== null ? `, ${item.ms} ms` : ''}${item.fails ? ` (${item.fails}× Fehler${item.silent ? ', von hier nie erreicht' : ''})` : ''}`)
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
        if (snap.nightwatch) {
            const nw = snap.nightwatch
            lines.push('', `*Nachtwache* (Stand ${nw.at})${nw.error ? `: läuft nicht — ${nw.error}` : `: ${nw.total - nw.failing.length}/${nw.total} ok`}`)
            for (const item of nw.failing) lines.push(`  ${item.status === 'unbekannt' ? '❔' : '❌'} ${JSON.stringify(item.label)} auf ${item.host}: ${item.message}`)
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
    const notOk = snap?.reachability.filter(item => item.alarmed || item.silent).length ?? 0
    const lines = [`Wächter: ${overview.nodes.length} Knoten, ${snap ? `${(snap.reachability.length - notOk)}/${snap.reachability.length} Ziele ok` : 'noch kein Lauf'}${worstDisk ? `, volleste Platte ${worstDisk.node} ${worstDisk.mount} ${pctText(worstDisk.usedPct)}` : ''}`]
    if (down.length) lines.push(`  ❌ nicht erreichbar: ${down.slice(0, 5).join(', ')}`)
    const soon = snap?.forecasts.filter(item => item.kind === 'platte') ?? []
    if (soon.length) lines.push(`  ⏳ Platte voll: ${soon.slice(0, 3).map(item => `${item.nodeId} ${item.subject} in ${fmtDays(item.daysLeft)}`).join(', ')}`)
    return lines
}
