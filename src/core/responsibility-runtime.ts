/**
 * Phase 6b — Takt und Produktionsverdrahtung für Verantwortungen + Missionen.
 *
 * P8: am Main standardmäßig AN (`autonomy.responsibilities.enabled=false` schaltet ab). Nur am Main
 * (nie mit NOVA_NODE_ONLY, nur mit globaler Autonomie-Autorität/Fence).
 *
 * Takt: ereignisgetrieben (Wahrnehmen-Bus: Warnungen/Fehler stoßen eine
 * Prüfung an, entprellt) plus Planer-Job `sys-verantwortungen`; ohne Planer
 * ein Timer als Rückfall. Jede Prüfung: Messungen sammeln → Verantwortungen
 * ableiten → Kriterien messen → Missionen starten/fortsetzen.
 *
 *   autonomy.responsibilities.enabled          an (false = aus)
 *   autonomy.responsibilities.intervalMinutes  15     Planer-/Timer-Takt (Rückfall)
 *   autonomy.responsibilities.budgetMinutes    120    Zeitbudget je Mission
 *   autonomy.responsibilities.maxToolCalls     20     Tool-Call-Budget je Mission
 *   autonomy.responsibilities.ownerSessions    []     Session-Namen für „wiederholte Anfragen“ (Standard: Telegram allowFrom)
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { EventSink, SensingEvent } from '../sensing/ports.js'
import { promotedKinds, resetTrust, type PromotedKind } from './action-policy.js'
import { defaultOn } from './autonomy-defaults.js'
import { getNovaDataDir } from './data-root.js'
import { createMissionEngine, type Mission, type MissionCardPort, type MissionEngine, type StepExecutor } from './missions.js'
import {
    createResponsibilityManager, type Responsibility, type ResponsibilityManager, type ResponsibilitySignals, type ThoughtPort,
} from './responsibilities.js'

export interface ResponsibilitySettings {
    enabled: boolean
    intervalMinutes: number
    budgetMinutes: number
    maxToolCalls: number
    ownerSessions: string[]
}

export function parseResponsibilitySettings(autonomy: any, env: NodeJS.ProcessEnv = process.env): ResponsibilitySettings {
    const raw = autonomy?.responsibilities ?? {}
    const num = (value: unknown, fallback: number, min: number, max: number) => {
        const n = Number(value)
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
    }
    return {
        enabled: defaultOn(raw.enabled, env),
        intervalMinutes: num(raw.intervalMinutes, 15, 5, 24 * 60),
        budgetMinutes: num(raw.budgetMinutes, 120, 5, 24 * 60),
        maxToolCalls: num(raw.maxToolCalls, 20, 2, 200),
        ownerSessions: Array.isArray(raw.ownerSessions) ? raw.ownerSessions.map(String).filter((name: string) => /^[A-Za-z0-9_-]{1,64}$/.test(name)).slice(0, 5) : [],
    }
}

export interface ResponsibilityRuntimeDeps {
    dataDir: string
    now?: () => number
    localNodeId: string
    isMain: () => boolean
    collectSignals: () => Promise<ResponsibilitySignals>
    executors: readonly StepExecutor[]
    ports: { thoughts: ThoughtPort; cards: MissionCardPort }
    settings: ResponsibilitySettings
}

export interface TickResult {
    active: boolean
    reason: string
    aktiviert?: number
    vorgeschlagen?: number
    verletzt?: number
    gestartet?: number
}

export interface ResponsibilityRuntime {
    settings: ResponsibilitySettings
    responsibilities: ResponsibilityManager
    missions: MissionEngine
    tick(reason: string): Promise<TickResult>
    shouldTickForEvent(event: Pick<SensingEvent, 'severity' | 'kind'>): boolean
}

const EVENT_KIND = /error|fehler|offline|down|failed|nightwatch|paused/i

export function createResponsibilityRuntime(deps: ResponsibilityRuntimeDeps): ResponsibilityRuntime {
    const isMain = () => { try { return deps.isMain() === true } catch { return false } }
    const responsibilities = createResponsibilityManager({ dataDir: deps.dataDir, now: deps.now, localNodeId: deps.localNodeId, ports: deps.ports })
    let lastSignals: ResponsibilitySignals | null = null
    const missions = createMissionEngine({
        dataDir: deps.dataDir, now: deps.now, localNodeId: deps.localNodeId, isMain, responsibilities,
        // Steps re-measure through the same collector (fresh numbers after an action).
        signals: async () => (lastSignals = await deps.collectSignals()),
        executors: deps.executors, ports: deps.ports,
        budget: { minutes: deps.settings.budgetMinutes, maxToolCalls: deps.settings.maxToolCalls },
    })
    let running: Promise<TickResult> | null = null
    async function run(reason: string): Promise<TickResult> {
        if (!deps.settings.enabled) return { active: false, reason: 'aus (autonomy.responsibilities.enabled=false)' }
        if (!isMain()) return { active: false, reason: 'kein Main (Worker oder ohne Fence) — nichts geprüft' }
        const signals = await deps.collectSignals()
        lastSignals = signals
        const synced = responsibilities.sync(signals)
        const outcomes = responsibilities.check(signals)
        const started = missions.startForViolations(outcomes)
        await missions.tick()
        return {
            active: true, reason, aktiviert: synced.aktiviert.length, vorgeschlagen: synced.vorgeschlagen.length,
            verletzt: outcomes.filter(item => item.erfuellt === false).length, gestartet: started.length,
        }
    }
    return {
        settings: deps.settings,
        responsibilities,
        missions,
        tick(reason) {
            if (running) return running
            running = run(reason).finally(() => { running = null })
            return running
        },
        shouldTickForEvent(event) {
            return event?.severity === 'warning' || event?.severity === 'urgent' || EVENT_KIND.test(String(event?.kind || ''))
        },
    }
}

// ---------------------------------------------------------------------------
// /arbeit
// ---------------------------------------------------------------------------

const MISSION_SECTIONS: Array<[Mission['status'], string]> = [
    ['in-arbeit', 'In Arbeit'], ['geplant', 'Geplant'], ['wartet-auf-alfred', 'Wartet auf Alfred'], ['blockiert', 'Blockiert'],
]
const short = (value: unknown, max: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export function formatArbeit(missions: readonly Mission[], responsibilities: readonly Responsibility[], options: { enabled?: boolean; promoted?: readonly PromotedKind[] } = {}): string {
    const lines: string[] = []
    if (options.enabled === false) lines.push('Verantwortungen: AUS (autonomy.responsibilities.enabled=false)', '')
    const missionLine = (mission: Mission) => {
        const step = mission.steps.find(item => item.id === mission.waitingStepId) || mission.steps[Math.min(mission.cursor, mission.steps.length - 1)]
        const parts = [`- ${mission.titel} [${mission.id}]`, `Versuch ${Math.min(mission.versuche + 1, mission.maxVersuche)}/${mission.maxVersuche}`]
        if (mission.status === 'wartet-auf-alfred' && step) parts.push(`Knopf: ${step.titel}`)
        else if (mission.status === 'in-arbeit' && step) parts.push(`Schritt ${mission.cursor + 1}/${mission.steps.length}: ${step.titel}`)
        if (mission.handoff && (mission.status === 'blockiert' || mission.status === 'fehlgeschlagen')) parts.push(short(mission.handoff, 240))
        return parts.join(' · ')
    }
    for (const [status, label] of MISSION_SECTIONS) {
        const items = missions.filter(item => item.status === status)
        lines.push(`${label} (${items.length})`)
        for (const mission of items.slice(-8)) lines.push(missionLine(mission))
    }
    const finished = missions.filter(item => item.status === 'abgeschlossen' || item.status === 'fehlgeschlagen').slice(-5)
    lines.push(`Abgeschlossen (letzte ${finished.length})`)
    for (const mission of finished) lines.push(`- ${mission.status === 'abgeschlossen' ? '✅' : '❌'} ${mission.titel} · ${mission.updatedAt.slice(0, 16).replace('T', ' ')}${mission.status === 'fehlgeschlagen' && mission.handoff ? ` · ${short(mission.handoff, 200)}` : ''}`)
    const active = responsibilities.filter(item => item.status === 'aktiv' || item.status === 'pausiert')
    const proposed = responsibilities.filter(item => item.status === 'vorgeschlagen')
    lines.push('', `Verantwortungen (${active.length} aktiv/pausiert, ${proposed.length} vorgeschlagen)`)
    for (const item of active) {
        const check = item.lastCheck
        const state = item.status === 'pausiert' ? 'pausiert' : !check ? 'noch nicht gemessen' : check.erfuellt === true ? 'erfüllt' : check.erfuellt === false ? `verletzt: ${short(check.befunde.join('; '), 160)}` : 'unbekannt'
        lines.push(`- ${item.titel} [${item.id}] · ${state} · ${item.herkunft === 'owner' ? 'von Alfred' : 'selbst abgeleitet'} · bis ${item.maxLevel}`)
    }
    for (const item of proposed.slice(-5)) lines.push(`- (Vorschlag, wartet auf Knopf) ${item.titel} [${item.id}]`)
    const promoted = options.promoted || []
    lines.push('', `Vertrauensleiter: selbst statt fragen (${promoted.length})`)
    for (const item of promoted) lines.push(`- ${item.kind} · ${item.text} · seit ${item.promotedAt.slice(0, 16).replace('T', ' ')} UTC (${item.confirmedYes}× Ja ohne Rückweg) · zurück: /arbeit fragen ${item.kind}`)
    return lines.join('\n')
}

// ---------------------------------------------------------------------------
// production wiring
// ---------------------------------------------------------------------------

let settings: ResponsibilitySettings = parseResponsibilitySettings(undefined)
let nightwatchJournalDir: string | undefined
let ownerSessionFallback: string[] = []
let runtime: ResponsibilityRuntime | null = null
let timer: ReturnType<typeof setInterval> | null = null
let eventTimer: ReturnType<typeof setTimeout> | null = null

export function getResponsibilityRuntime(): ResponsibilityRuntime | null { return runtime }

/** Called once by the daemon with `autonomy` from the config. */
export function setResponsibilityConfig(autonomy: unknown, options: { nightwatchJournalDir?: string; ownerSessions?: string[] } = {}): ResponsibilitySettings {
    settings = parseResponsibilitySettings(autonomy)
    nightwatchJournalDir = options.nightwatchJournalDir
    ownerSessionFallback = (options.ownerSessions || []).map(String).filter(name => /^[A-Za-z0-9_-]{1,64}$/.test(name)).slice(0, 5)
    return settings
}

/** Set in startResponsibilities (global autonomy authority = fenced Main lease). */
let mainAuthority: (() => boolean) | null = null
function productionIsMain(): boolean {
    if (String(process.env.NOVA_NODE_ONLY || '').toLowerCase() === 'true') return false
    try { return mainAuthority?.() === true } catch { return false }
}

function readTail(path: string, maxBytes: number): string {
    if (!existsSync(path)) return ''
    const fd = openSync(path, 'r')
    try {
        const size = fstatSync(fd).size
        const length = Math.min(size, maxBytes)
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, size - length)
        const text = buffer.toString('utf8')
        return length < size ? text.slice(text.indexOf('\n') + 1) : text
    } finally { closeSync(fd) }
}

const DEVICE_EVENT_WINDOW_MS = 6 * 60 * 60_000
const REQUEST_WINDOW_MS = 14 * 24 * 60 * 60_000

async function collectProductionSignals(): Promise<ResponsibilitySignals> {
    const dataDir = getNovaDataDir()
    const now = Date.now()
    const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
    const localNodeId = getLocalNodeId()
    const nodes: ResponsibilitySignals['nodes'] = []
    try {
        const { collectNodeProfile } = await import('./node-profile.js')
        const profile = await collectNodeProfile()
        nodes.push({ nodeId: localNodeId, lastSeen: now, profile: { version: profile.version, role: profile.role, selfCheck: profile.selfCheck } })
    } catch { /* profile optional */ }
    try {
        const { getMeshPeerStates } = await import('../mesh/mesh-transport-runtime.js')
        for (const peer of Object.values(getMeshPeerStates())) {
            if (!peer?.nodeId || !peer.profile || peer.nodeId === localNodeId) continue
            nodes.push({ nodeId: peer.nodeId, lastSeen: peer.profileSeen ?? peer.lastSeen, profile: { version: peer.profile.version, role: peer.profile.role, selfCheck: peer.profile.selfCheck } })
        }
    } catch { /* mesh optional */ }
    let nightwatch: ResponsibilitySignals['nightwatch'] = null
    if (nightwatchJournalDir) {
        try {
            const { readLatestNightwatchReport } = await import('../doctor/nightwatch.js')
            const report = readLatestNightwatchReport(nightwatchJournalDir)
            if (report && !report.error) nightwatch = { finishedAt: report.finishedAt, results: report.results.map(item => ({ id: item.id, label: item.label, host: item.host, status: item.status, message: item.message, severity: item.severity })) }
        } catch { /* optional */ }
    }
    const devices: ResponsibilitySignals['devices'] = []
    try {
        const { loadDevices } = await import('../sensing/device-registry.js')
        const latest = new Map<string, { kind: string; summary: string; at: number }>()
        for (const line of readTail(join(dataDir, 'sensing', 'events.jsonl'), 512 * 1024).split('\n')) {
            if (!line.trim()) continue
            try {
                const event = JSON.parse(line)
                const at = Date.parse(event.at)
                if (typeof event.subject === 'string' && Number.isFinite(at) && now - at <= DEVICE_EVENT_WINDOW_MS) latest.set(event.subject, { kind: String(event.kind || ''), summary: String(event.summary || ''), at })
            } catch { /* partial line */ }
        }
        for (const device of loadDevices(dataDir)) {
            const event = latest.get(device.id)
            devices.push({ id: device.id, name: device.name, type: device.type, status: device.status, ok: event ? !/error|offline/.test(event.kind) : null, detail: event?.summary.slice(0, 160) })
        }
    } catch { /* sensing optional */ }
    let release: ResponsibilitySignals['release'] = null
    try {
        const { listThoughts } = await import('../planner/index.js')
        for (const thought of listThoughts({ source: 'selbst-update', limit: 50 }).slice().reverse()) {
            const match = /^Xaventra (\d+\.\d+\.\d+[0-9A-Za-z.-]*) verfügbar$/.exec(thought.title)
            if (match) { release = { version: match[1] }; break }
        }
    } catch { /* planner optional */ }
    const ownerRequests: ResponsibilitySignals['ownerRequests'] = []
    for (const name of [...new Set([...settings.ownerSessions, ...ownerSessionFallback])].slice(0, 5)) {
        // Only owner messages of the last 14 days; their text is classified in memory and never stored.
        for (const line of readTail(join(dataDir, 'sessions', `${name}.jsonl`), 1024 * 1024).split('\n')) {
            if (!line.includes('"role":"user"')) continue
            try {
                const entry = JSON.parse(line)
                const at = Date.parse(entry.ts)
                if (entry.role === 'user' && Number.isFinite(at) && now - at <= REQUEST_WINDOW_MS) ownerRequests.push({ at, text: String(entry.content ?? '').slice(0, 300) })
            } catch { /* partial line */ }
        }
    }
    return { now, localNodeId, nodes, nightwatch, devices, release, ownerRequests }
}

/** Registered step executors: only existing, fenced paths. No free command path. */
function productionExecutors(): StepExecutor[] {
    return [
        {
            kind: 'diagnose',
            async run(_step, mission, ctx) {
                const signals = await ctx.signals()
                const responsibility = runtime?.responsibilities.get(mission.responsibilityId)
                if (!responsibility) return { ok: true, message: 'Verantwortung nicht mehr vorhanden' }
                const measured = runtime!.responsibilities.measure(responsibility, signals)
                let heal = ''
                try {
                    const { readHealJournal } = await import('../doctor/self-heal.js')
                    const last = readHealJournal(getNovaDataDir(), 3)
                    if (last.length) heal = ` · Heilungs-Journal: ${last.map(entry => `${entry.recipe}=${entry.ergebnis}`).join(', ')}`
                } catch { /* optional */ }
                return { ok: true, message: `${measured.ergebnisse.map(item => item.befund).join('; ') || 'keine Messwerte'}${heal}` }
            },
        },
        {
            kind: 'self-heal-zyklus',
            async run() {
                const { getSelfHealSettings, runSelfHealCycle } = await import('../doctor/self-heal-runtime.js')
                if (!getSelfHealSettings().enabled) return { ok: false, message: 'Selbstheilung ist aus (autonomy.selfHeal.enabled ist nicht true)' }
                const checks = await runSelfHealCycle({ isMain: true, nightwatchJournalDir })
                const { readHealJournal } = await import('../doctor/self-heal.js')
                const last = readHealJournal(getNovaDataDir(), 3)
                const rolledBack = last.some(entry => entry.ergebnis === 'zurueckgerollt' || entry.ergebnis === 'rueckweg-gescheitert')
                return { ok: !rolledBack, rolledBack, message: `Selbstheilung gelaufen (${checks.length} Meldungen${last.length ? `, zuletzt ${last[last.length - 1].recipe}: ${last[last.length - 1].ergebnis}` : ''})` }
            },
        },
        {
            kind: 'geraet-einrichten',
            async run(step, _mission, ctx) {
                // P8: an owner Ja, or the owner's standing trust (3× Ja without rollback) for this kind.
                const by = ctx.approvedBy || ctx.trustedBy
                if (!by || !step.ref) return { ok: false, message: 'ohne Owner-Freigabe oder Gerät — nichts eingerichtet' }
                const { approveSensingDevice } = await import('../sensing/runtime.js')
                return approveSensingDevice(step.ref, { principalId: by, permission: 'owner' })
            },
        },
        {
            kind: 'install-katalog',
            async run(step, _mission, ctx) {
                const by = ctx.approvedBy || ctx.trustedBy
                if (!by || !step.ref) return { ok: false, message: 'ohne Owner-Freigabe oder Warteschlangen-Eintrag — nichts installiert' }
                const { approveQueuedInstall, defaultInstallDeps } = await import('../install/install-queue.js')
                const result = await approveQueuedInstall(step.ref, { permission: 'owner', principalId: by, channel: ctx.approvedBy ? 'mission-karte' : 'vertrauensleiter' }, defaultInstallDeps())
                return { ok: result.ok, message: result.message }
            },
        },
        // Bewusst KEIN Ausführer für dienst-neustart / release-ausrollen: dafür gibt es
        // (noch) keinen registrierten, gefencten Weg — die Mission übergibt an Alfred.
    ]
}

/** Starts the runtime on the Main when enabled. Workers never start it. */
export async function startResponsibilities(options: { nodeOnly: boolean }): Promise<{ started: boolean; reason: string }> {
    stopResponsibilities()
    if (!settings.enabled) return { started: false, reason: 'autonomy.responsibilities.enabled=false' }
    if (options.nodeOnly) return { started: false, reason: 'Mesh-Worker: Verantwortungen laufen nur am Main' }
    const { hasGlobalAutonomyAuthority } = await import('./autonomy-authority.js')
    mainAuthority = () => hasGlobalAutonomyAuthority()
    const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
    const { addThought } = await import('../planner/index.js')
    const { createApprovalCard, listApprovalCards } = await import('./approval-cards.js')
    runtime = createResponsibilityRuntime({
        dataDir: getNovaDataDir(),
        localNodeId: getLocalNodeId(),
        isMain: productionIsMain,
        collectSignals: collectProductionSignals,
        executors: productionExecutors(),
        ports: {
            thoughts: { add: input => addThought(input) },
            cards: {
                create: input => createApprovalCard(input),
                status: id => listApprovalCards().find(card => card.id === id)?.status,
            },
        },
        settings,
    })
    const tick = (reason: string) => runtime?.tick(reason).catch(error => {
        console.warn('[Verantwortungen] Prüfung fehlgeschlagen:', String((error as Error)?.message || error).slice(0, 200))
        return { active: false, reason: 'fehler' } as TickResult
    })
    let via = 'Timer'
    try {
        const { getPlannerRuntime } = await import('../planner/index.js')
        const planner = getPlannerRuntime()?.planner
        if (planner) {
            planner.register('verantwortungen', {
                async run() {
                    const result = await tick('planer')
                    return { summary: result?.active ? `${result.verletzt ?? 0} verletzt, ${result.gestartet ?? 0} Missionen gestartet` : `nicht aktiv: ${result?.reason || '?'}` }
                },
            })
            planner.upsertSystemJob({ id: 'sys-verantwortungen', kind: 'verantwortungen', title: 'Verantwortungen prüfen', schedule: { type: 'intervall', minutes: settings.intervalMinutes }, mainOnly: true, enabled: true })
            via = 'Planer'
        }
    } catch { /* planner optional */ }
    if (via === 'Timer') {
        timer = setInterval(() => { void tick('timer') }, settings.intervalMinutes * 60_000)
        timer.unref?.()
    }
    const first = setTimeout(() => { void tick('start') }, 60_000)
    first.unref?.()
    return { started: true, reason: `Takt: Ereignisse + ${via} alle ${settings.intervalMinutes} min` }
}

export function stopResponsibilities(): void {
    if (timer) clearInterval(timer)
    if (eventTimer) clearTimeout(eventTimer)
    timer = null
    eventTimer = null
    runtime = null
}

/** Sensing events trigger a (debounced) check. */
export function noteSensingEvent(event: Pick<SensingEvent, 'severity' | 'kind'>): void {
    const current = runtime
    if (!current || !current.shouldTickForEvent(event) || eventTimer) return
    eventTimer = setTimeout(() => {
        eventTimer = null
        void current.tick('ereignis').catch(() => undefined)
    }, 5_000)
    eventTimer.unref?.()
}

/** Wraps the sensing event sink: write first, then maybe trigger a check. */
export function createResponsibilityEventSink(inner: EventSink): EventSink {
    return {
        async writeEvent(event) {
            await inner.writeEvent(event)
            try { noteSensingEvent(event) } catch { /* never break sensing */ }
        },
    }
}

/** P8: „das wieder fragen“ — takes a trust-ladder promotion back (exported for text commands). */
export function askAgainFor(kind: string, dataDir: string = getNovaDataDir()): string {
    const result = resetTrust(kind, { dataDir })
    return result.wasPromoted ? `Verstanden: „${result.kind}“ frage ich ab jetzt wieder.` : `„${result.kind}“ war nicht hochgestuft; ich frage dort ohnehin.`
}

/** /arbeit [pause <id>|weiter <id>|fragen <art>] — owner only. */
export async function handleArbeitCommand(args: string, principal: { permission?: string; principalId?: string; rawUserId?: string } | undefined): Promise<string> {
    if (principal?.permission !== 'owner') return '⛔ /arbeit ist nur für den Owner.'
    const [sub = '', id = ''] = String(args || '').trim().split(/\s+/)
    const current = runtime
    if (!current) {
        // Read-only view of what is persisted, even while off.
        const dataDir = getNovaDataDir()
        const noPorts = { thoughts: { add: () => undefined }, cards: { create: () => ({ ok: false as const, reason: 'aus' }) } }
        const manager = createResponsibilityManager({ dataDir, localNodeId: 'lokal', ports: noPorts })
        const engine = createMissionEngine({ dataDir, localNodeId: 'lokal', isMain: () => false, responsibilities: manager, signals: () => collectProductionSignals(), executors: [], ports: noPorts })
        return formatArbeit(engine.list(), manager.list(), { enabled: settings.enabled, promoted: promotedKinds({ dataDir }) })
    }
    const by = `owner:${principal.principalId || principal.rawUserId || '?'}`
    if (sub === 'pause' || sub === 'weiter') {
        if (!/^[A-Za-z0-9_.:@-]{2,120}$/.test(id)) return 'Nutzung: /arbeit pause <id> | /arbeit weiter <id>'
        return current.responsibilities.setPaused(id, sub === 'pause', by).message
    }
    if (sub === 'fragen') {
        if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) return 'Nutzung: /arbeit fragen <aktionsart>'
        return askAgainFor(id)
    }
    if (sub) return 'Nutzung: /arbeit | /arbeit pause <id> | /arbeit weiter <id> | /arbeit fragen <aktionsart>'
    return formatArbeit(current.missions.list(), current.responsibilities.list(), { enabled: settings.enabled, promoted: promotedKinds({ dataDir: getNovaDataDir() }) })
}
