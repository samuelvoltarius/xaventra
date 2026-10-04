/**
 * Laufzeit des Wahrnehmens: baut den Bus aus `autonomy.sensing`, startet ihn
 * nur am Main (nie mit NOVA_NODE_ONLY) und — P8 — ohne Config-Eintrag
 * (`enabled=false` schaltet ab). Die Geräte-Suche läuft von selbst (kurz nach
 * dem Start, dann alle `discovery.intervalHours`); Gefundenes wird sofort
 * lesend überwacht (L0, keine Karte), fehlt ein Zugang, gibt es genau eine
 * Bitte an den Owner. `/geraete` (Owner) bleibt ein reiner Einblick/Korrektur-
 * weg. Ausgabe ausschließlich über den Port (./ports.ts).
 *
 * Integration (Claude): `setSensingSinks({ eventSink, thoughtSink })` vor dem
 * Start hängt Gedanken-Speicher/Knopf-Karten an; ohne Aufruf: JSONL-Standard.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSensingConfig, type SensingConfig } from './config.js'
import { SensingBus, type RawEvent } from './event-bus.js'
import { JsonlEventSink, JsonlThoughtSink, cleanText, sensingLog, type EventSink, type ThoughtSink } from './ports.js'
import { createPrinterAdapter, type PrinterTarget } from './adapters/printer.js'
import { createHomeAssistantAdapter, resolveHaConnection } from './adapters/homeassistant.js'
import { createMailAdapter, resolveMailCredentials } from './adapters/mail.js'
import { createSystemAdapter } from './adapters/system.js'
import { createProxmoxAdapter } from './adapters/proxmox.js'
import { loadProxmoxRuntime, parseProxmoxConfig } from '../infra/proxmox.js'
import { approveDevice, autoMonitorDevices, claimOwnerAsk, credentialNeed, DEVICE_LABEL, formatDevices, loadDevices, monitoredDevices, recordCandidates, setDeviceStatus, type Approver, type DeviceRecord } from './device-registry.js'
import { discoverDevices, realMdnsBrowse, type DiscoveryDeps } from './discovery.js'
import { accountEvents, detectAccounts, readAuthProfileShapes } from './accounts.js'
import { learnQuietHours, readOwnerTimestamps } from './quiet-hours.js'
import { readDiscoveryCursor, recordDiscoveryObservation } from './awareness.js'
import { getServiceRuntime } from '../runtime/service-runtime.js'
import { HARDWARE_LABEL, HARDWARE_PROMPT, recognizeHardware, verifyHardwareConnection, type HardwareModel } from './hardware-recognition.js'
import { markHardwareAsked, sensingDeviceFingerprint, deviceId } from './device-registry.js'
import { createHardwareAdapter } from './adapters/hardware.js'

interface RuntimeState {
    raw: unknown
    rootConfig: any
    config: SensingConfig
    dataDir: string
    bus: SensingBus | null
    sinks: { eventSink?: EventSink; thoughtSink?: ThoughtSink }
    discoveryRunning: boolean
    timers: Array<ReturnType<typeof setTimeout>>
    continuation?: ReturnType<typeof setTimeout>
    discoveryAbort?: AbortController
}

const state: RuntimeState = {
    raw: undefined, rootConfig: {}, config: parseSensingConfig(undefined),
    dataDir: join(process.cwd(), '.nova-data'), bus: null, sinks: {}, discoveryRunning: false, timers: [],
}

export function setSensingConfig(raw: unknown, rootConfig: any = {}, dataDir?: string): SensingConfig {
    state.raw = raw
    state.rootConfig = rootConfig || {}
    state.config = parseSensingConfig(raw)
    if (dataDir) state.dataDir = dataDir
    return state.config
}

export function setSensingSinks(sinks: { eventSink?: EventSink; thoughtSink?: ThoughtSink }): void {
    state.sinks = { ...sinks }
}

function newBus(nodeId: string, role: 'main' | 'worker'): SensingBus {
    const cfg = state.config
    return new SensingBus({
        dataDir: state.dataDir,
        eventSink: state.sinks.eventSink || new JsonlEventSink(state.dataDir),
        thoughtSink: state.sinks.thoughtSink || new JsonlThoughtSink(state.dataDir),
        nodeId, role,
        notify: { quietHoursStart: cfg.notify.quietStart, quietHoursEnd: cfg.notify.quietEnd, dailyBudget: cfg.notify.maxPerDay, timezone: cfg.notify.timezone },
    })
}

function loadAuthProfiles(): Record<string, any> | null {
    const path = join(state.dataDir, 'auth.json')
    if (!existsSync(path)) return null
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        return parsed?.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : parsed
    } catch { return null }
}

function printerTargets(): PrinterTarget[] {
    const fromConfig = state.config.adapters.printer.devices
    const approved = monitoredDevices(state.dataDir)
        .filter(device => device.type === 'moonraker' || device.type === 'octoprint' || device.type === 'prusalink')
        .map(device => ({ id: device.id, name: device.name, type: device.type as PrinterTarget['type'], url: `http://${device.host}:${device.port}` }))
    return [...fromConfig, ...approved.filter(device => !fromConfig.some(item => item.id === device.id))]
}

/** Wächter (Phase 7): only devices the owner set up are watched (TCP reachability). */
export function listWatchableDevices(): Array<{ name: string; host: string; port: number }> {
    return monitoredDevices(state.dataDir).map(device => ({ name: device.name, host: device.host, port: device.port }))
}

/**
 * Wächter 2.85 (selbst abgeleitete Ziele): every known device with its status.
 * `abgelehnt`/`aus` are filtered by the Wächter (owner decisions); no credential.
 */
export function listDerivableDevices(): Array<{ type: string; name: string; host: string; port: number; status: string }> {
    return loadDevices(state.dataDir).map(device => ({ type: device.type, name: device.name, host: device.host, port: device.port, status: device.status }))
}

/** Builds the bus with every enabled adapter (does not start timers). */
export function buildSensingBus(options: { nodeId?: string; role?: 'main' | 'worker' } = {}): SensingBus {
    const cfg = state.config
    const bus = newBus(options.nodeId || 'local', options.role || 'main')
    const a = cfg.adapters
    if (cfg.discovery.enabled) bus.register(createHardwareAdapter(() => monitoredDevices(state.dataDir)))
    if (a.printer.enabled) bus.register(createPrinterAdapter({ targets: printerTargets, intervalMs: a.printer.intervalSec * 1000, timeoutMs: a.printer.timeoutSec * 1000 }))
    if (a.homeassistant.enabled) bus.register(createHomeAssistantAdapter({ connection: () => resolveHaConnection(a.homeassistant, state.rootConfig), entities: a.homeassistant.entities, intervalMs: a.homeassistant.intervalSec * 1000, timeoutMs: a.homeassistant.timeoutSec * 1000 }))
    if (a.mail.enabled) bus.register(createMailAdapter({ config: a.mail, credentials: () => resolveMailCredentials(a.mail, { env: process.env, authProfiles: loadAuthProfiles() }) }))
    if (a.system.enabled) bus.register(createSystemAdapter({ dataDir: state.dataDir, intervalMs: a.system.intervalSec * 1000, timeoutMs: a.system.timeoutSec * 1000 }))
    // Phase 6c: Proxmox (read only) when infra.proxmox is on and watch is not false.
    const pveRaw = state.rootConfig?.infra?.proxmox
    const pve = parseProxmoxConfig(pveRaw)
    if (pve.enabled && pve.watch) {
        bus.register(createProxmoxAdapter({
            client: async () => { const runtime = await loadProxmoxRuntime({ rawConfig: pveRaw }); return runtime.ok ? runtime.client : null },
            ramWarnPercent: pve.ramWarnPercent, limits: pve.limits,
        }))
    }
    return bus
}

/**
 * Starts sensing when enabled. Mesh workers never start it: they would only
 * duplicate the main's observations, and they never talk to the owner.
 */
export function startSensing(options: { nodeOnly: boolean; nodeId?: string; autoDiscovery?: boolean; discoveryRunner?: () => Promise<unknown> }): { started: boolean; reason: string } {
    if (!state.config.enabled) return { started: false, reason: 'autonomy.sensing.enabled=false' }
    if (options.nodeOnly) return { started: false, reason: 'Mesh-Worker: Wahrnehmen läuft nur am Main' }
    if (state.bus) return { started: true, reason: 'läuft bereits' }
    state.bus = buildSensingBus({ nodeId: options.nodeId, role: 'main' })
    state.bus.start()
    const active = state.bus.getStatus().map(item => item.id)
    const auto = options.autoDiscovery !== false && state.config.discovery.enabled
    if (auto) scheduleAutoDiscovery(options.discoveryRunner)
    sensingLog(`gestartet, Adapter: ${active.join(', ') || 'keine'}${auto ? `, Suche selbst alle ${state.config.discovery.intervalHours} h` : ''}`)
    return { started: true, reason: `Adapter: ${active.join(', ') || 'keine'}${auto ? ' · Geräte-Suche selbstständig' : ''}` }
}

/** P8: discovery + account check without any command — shortly after start, then every `intervalHours`. */
function scheduleAutoDiscovery(runner?: () => Promise<unknown>): void {
    const bus = state.bus
    const run = () => {
        if (runner) { void runner().catch(() => undefined); return }
        void runDiscoveryNow().then(text => {
            sensingLog(`Suche (selbst): ${text.split('\n')[0]}`)
            const cursor = readDiscoveryCursor(state.dataDir)
            if (state.bus === bus && bus && cursor && (cursor.hostOffset > 0 || cursor.portIndex > 0) && !state.continuation) {
                state.continuation = setTimeout(() => { state.continuation = undefined; run() }, 5 * 60_000)
                state.continuation.unref?.()
            }
        }).catch(error => sensingLog(`Suche (selbst) fehlgeschlagen: ${cleanText(String((error as Error)?.message || error), 160)}`))
        void proposeAccounts().catch(() => undefined)
    }
    const first = setTimeout(run, state.config.discovery.firstRunDelaySec * 1000)
    first.unref?.()
    const every = setInterval(run, state.config.discovery.intervalHours * 60 * 60_000)
    every.unref?.()
    state.timers.push(first, every)
}

export function stopSensing(): void {
    state.discoveryAbort?.abort()
    if (state.continuation) clearTimeout(state.continuation)
    state.continuation = undefined
    for (const timer of state.timers.splice(0)) { clearTimeout(timer); clearInterval(timer) }
    state.bus?.stop()
    state.bus = null
}

/** Thought events for devices watched right away / waiting for one owner credential. No action → no card. */
export function deviceEvents(result: { monitored: DeviceRecord[]; asked: DeviceRecord[] }): RawEvent[] {
    const month = 30 * 24 * 60 * 60_000
    const watched: RawEvent[] = result.monitored.map(device => ({
        kind: 'discovery.device', subject: device.id, severity: 'info' as const, dedupeKey: `device:${device.id}:ueberwacht`, dedupeWindowMs: month,
        summary: `${DEVICE_LABEL[device.type]} gefunden (${device.host}:${device.port}) und ab jetzt nur lesend überwacht (Fortschritt, fertig, Fehler, pausiert). Abschalten: /geraete aus ${device.id}.`,
        evidence: { geraet: device.id, typ: device.type, adresse: `${device.host}:${device.port}`, gefunden_ueber: device.via, status: 'eingerichtet (selbst, lesend)' },
        hint: { importance: 'normal' as const, title: `Gefunden + überwacht: ${DEVICE_LABEL[device.type]} (${device.host})` },
    }))
    const asks: RawEvent[] = result.asked.map(device => ({
        kind: 'discovery.device', subject: device.id, severity: 'info' as const, dedupeKey: `device:${device.id}:zugang`, dedupeWindowMs: 365 * 24 * 60 * 60_000,
        summary: `${DEVICE_LABEL[device.type]} gefunden (${device.host}:${device.port}). Zum lesenden Überwachen fehlt ${credentialNeed(device.type)}.`,
        evidence: { geraet: device.id, typ: device.type, adresse: `${device.host}:${device.port}`, gefunden_ueber: device.via, status: 'gefunden, Zugang fehlt' },
        hint: {
            importance: 'normal' as const,
            title: `Gefunden: ${DEVICE_LABEL[device.type]} (${device.host}) — brauche einmal den Zugang`,
            proposal: `Bitte einmal ${credentialNeed(device.type)} eintragen; danach überwache ich selbst, nur lesend. Ich frage nicht noch einmal.`,
        },
    }))
    return [...watched, ...asks]
}

function busForPublish(): SensingBus {
    return state.bus || newBus('local', 'main')
}

export async function runDiscoveryNow(deps: DiscoveryDeps & { hardwareModel?: HardwareModel } = {}): Promise<string> {
    const cfg = state.config
    if (!cfg.enabled || !cfg.discovery.enabled) return 'Geräte-Suche ist aus (autonomy.sensing.enabled bzw. autonomy.sensing.discovery.enabled steht auf false).'
    if (state.discoveryRunning) return 'Geräte-Suche läuft bereits.'
    state.discoveryRunning = true
    const controller = new AbortController()
    state.discoveryAbort = controller
    const dataDir = state.dataDir
    try {
        const report = await discoverDevices({
            deadlineMs: cfg.discovery.deadlineSec * 1000, ratePerSec: cfg.discovery.ratePerSec, concurrency: cfg.discovery.concurrency,
            maxHosts: cfg.discovery.maxHosts, mdns: cfg.discovery.mdns, tailnetHosts: cfg.discovery.tailnetHosts,
            cursor: readDiscoveryCursor(dataDir), signal: controller.signal,
        }, { mdnsBrowse: cfg.discovery.mdns ? realMdnsBrowse : undefined, ...deps })
        if (controller.signal.aborted) return 'Geräte-Suche beim Stoppen abgebrochen.'
        const known = loadDevices(dataDir)
        const attempted = (host: string) => Math.max(0, ...known.filter(d => d.host === host).map(d => Date.parse(d.hardware?.observedAt || '') || 0))
        const eligible = report.candidates.filter(c => !known.some(d => d.host === c.host && ['abgelehnt', 'aus'].includes(d.status)))
            .sort((a, b) => attempted(a.host) - attempted(b.host))
        // The monitored local learning facade owns privacy, health and token budget.
        // Never fall back to the cloud Main client for private network observations.
        const serviceRuntime = getServiceRuntime()
        const llm = serviceRuntime.getStatus().learning?.profile.localOnly === true ? serviceRuntime.getClient('learning') : null
        const model: HardwareModel | undefined = deps.hardwareModel || (llm?.complete ? async (observations, signal) => {
            if (signal.aborted) throw new Error('aborted')
            const result = await llm.complete([{ role: 'system', content: HARDWARE_PROMPT }, { role: 'user', content: observations }], [],
                { maxTokens: 220, reasoningEffort: 'none', timeoutMs: 3000, maxAttempts: 1, signal })
            return typeof result === 'string' ? result : String(result?.content || '')
        } : undefined)
        const enriched = await recognizeHardware(eligible, model, deps, controller.signal)
        if (controller.signal.aborted) return 'Geräte-Suche beim Stoppen abgebrochen.'
        const fresh = recordCandidates(dataDir, [...enriched, ...report.candidates.filter(c => !eligible.includes(c))])
        recordDiscoveryObservation(dataDir, report)
        // P8: watching is L0 — found devices are monitored right away, no card.
        const handled = autoMonitorDevices(dataDir)
        const events = deviceEvents({ ...handled, asked: handled.asked.filter(d => d.type !== 'homeassistant') })
        if (events.length) await busForPublish().publish('discovery', events)
        if (process.env.NOVA_NODE_ONLY !== 'true') {
            const haConfigured = resolveHaConnection(cfg.adapters.homeassistant, state.rootConfig)
            const offers = hardwareConnectionEvents(loadDevices(dataDir), Boolean(haConfigured))
            if (offers.length) {
                await busForPublish().publish('discovery', offers)
                for (const offer of offers) markHardwareAsked(dataDir, offer.subject, String(offer.evidence.fingerprint))
            }
        }
        const watchedIds = new Set(handled.monitored.map(device => device.id))
        return [
            `Suche fertig in ${Math.round(report.durationMs / 100) / 10} s: ${report.scannedHosts} Adressen, ${report.probes} Proben${report.timedOut ? ' (Zeitlimit erreicht)' : ''}.`,
            `Netze: ${report.scope.subnets.join(', ') || 'keine privaten'}${report.scope.hasTailnet ? ' + Tailnet' : ''}.`,
            report.rejected.length ? `Abgelehnt (fremd/öffentlich): ${report.rejected.length}.` : '',
            fresh.length ? `Neu gefunden: ${fresh.map(device => `${device.name} (${device.id}, ${watchedIds.has(device.id) ? 'überwacht, nur lesend' : handled.asked.some(asked => asked.id === device.id) ? 'Zugang fehlt, einmal beim Owner angefragt' : 'beobachtet, Steuerung nicht geprüft'})`).join('; ')}.` : 'Keine neuen Geräte.',
            handled.monitored.some(device => !fresh.some(item => item.id === device.id)) ? `Jetzt überwacht (früher gefunden): ${handled.monitored.filter(device => !fresh.some(item => item.id === device.id)).map(device => device.name).join('; ')}.` : '',
        ].filter(Boolean).join('\n')
    } finally {
        state.discoveryRunning = false
        if (state.discoveryAbort === controller) state.discoveryAbort = undefined
    }
}

/** The card's [Ja] calls this. Only the owner. */
export async function approveSensingDevice(id: string, approver: Approver, fingerprint?: string, deps: DiscoveryDeps = {}): Promise<{ ok: boolean; message: string }> {
    if (approver.permission !== 'owner' || !String(approver.principalId || '').trim()) return { ok: false, message: 'Nur der Owner kann Geräte verbinden.' }
    const dataDir = state.dataDir
    const device = loadDevices(dataDir).find(d => d.id === id)
    if (fingerprint || device?.hardware || device?.type === 'homeassistant') {
        if (!device || (fingerprint && fingerprint !== sensingDeviceFingerprint(device)) || ['abgelehnt', 'aus'].includes(device.status)
            || Date.now() - Date.parse(device.lastSeenAt) > 24 * 60 * 60_000 || !Number.isFinite(Date.parse(device.lastSeenAt))) {
            return { ok: false, message: 'Der Fund ist veraltet, geändert oder abgelehnt. Nichts verbunden; bitte erneut prüfen.' }
        }
        if (device.type === 'homeassistant') {
            const { ownSubnets, scanTargetAllowed } = await import('./net-scope.js')
            const { realHttpProbe, identifyHttp } = await import('./discovery.js')
            if (!scanTargetAllowed(device.host, ownSubnets(deps.interfaces)).allowed) return { ok: false, message: 'Ziel liegt nicht mehr im eigenen Netz.' }
            const result = await (deps.httpProbe || realHttpProbe)(`http://${device.host}:${device.port}/manifest.json`, 1200)
            if (identifyHttp(device.port, '/manifest.json', result) !== 'homeassistant') return { ok: false, message: 'Home-Assistant-Kennung nicht mehr bestätigt. Nichts verbunden.' }
            const latest = loadDevices(dataDir).find(d => d.id === id)
            if (!latest || sensingDeviceFingerprint(latest) !== sensingDeviceFingerprint(device) || ['abgelehnt', 'aus'].includes(latest.status)) return { ok: false, message: 'Gerätefund während der Prüfung geändert. Nichts verbunden.' }
            const { connectFromApproval, defaultDeps } = await import('../connections/connect-flow.js')
            const { getConnection, connectionIdFor } = await import('../connections/connection-store.js')
            const basis = `http://${device.host}:${device.port}`
            const existing = getConnection(connectionIdFor('home-assistant'), { dataDir })
            if (existing?.status === 'verbunden' && existing.basis !== basis) return { ok: false, message: 'Bereits mit einer anderen Home-Assistant-Zentrale verbunden. Kein automatischer Wechsel.' }
            return connectFromApproval('home-assistant', approver.principalId, { ...defaultDeps(), dataDir, foundHomeAssistant: () => [basis] })
        }
        if (!await verifyHardwareConnection(device, deps)) return { ok: false, message: 'Gerätekennung oder unterstützte lesende Verbindung nicht bestätigt. Nichts verbunden.' }
        const latest = loadDevices(dataDir).find(d => d.id === id)
        if (!latest || sensingDeviceFingerprint(latest) !== sensingDeviceFingerprint(device) || ['abgelehnt', 'aus'].includes(latest.status)) {
            return { ok: false, message: 'Gerätefund während der Prüfung geändert. Nichts verbunden.' }
        }
    }
    const result = approveDevice(dataDir, id, approver)
    return { ok: result.ok, message: result.message }
}

export function declineSensingDevice(id: string, approver: Approver, fingerprint?: string): { ok: boolean; message: string } {
    if (fingerprint) {
        const device = loadDevices(state.dataDir).find(d => d.id === id)
        if (!device || sensingDeviceFingerprint(device) !== fingerprint) return { ok: false, message: 'Der Gerätefund hat sich geändert; alte Antwort nicht angewendet.' }
    }
    return setDeviceStatus(state.dataDir, id, 'abgelehnt', approver)
}

/** Only supported, protocol-verified endpoints become actionable questions. */
export function hardwareConnectionEvents(devices: DeviceRecord[], haConfigured = false, now = Date.now()): RawEvent[] {
    return devices.filter(d => d.status === 'gefunden' && Number.isFinite(Date.parse(d.lastSeenAt)) && now - Date.parse(d.lastSeenAt) <= 24 * 60 * 60_000
        && ((d.type === 'homeassistant' && d.via === 'http' && !haConfigured) || (d.hardware?.certainty === 'confirmed' && d.hardware.connector === 'shelly-readonly')))
        .filter(d => d.hardwareAskedFingerprint !== sensingDeviceFingerprint(d)).map(d => {
            const fingerprint = sensingDeviceFingerprint(d)
            const label = d.hardware ? `${HARDWARE_LABEL[d.hardware.kind]}: ${d.hardware.label}` : 'Home Assistant (Smart-Home-Zentrale; angeschlossene Geräte noch nicht ausgelesen)'
            return { kind: 'discovery.connection-offer', subject: d.id, severity: 'info', dedupeKey: `hardware-offer:${d.id}:${fingerprint}`, dedupeWindowMs: 365 * 24 * 60 * 60_000,
                summary: `${label} bei ${d.host} erkannt. Soll ich mich damit verbinden?`, evidence: { geraet: d.id, fingerprint, adresse: d.host, kennung: d.hardware?.identity || 'Home-Assistant-Manifest' },
                hint: { importance: 'normal', title: `Gefunden: ${label}`, level: 'fragen', proposal: d.type === 'homeassistant'
                    ? 'Ja = Home Assistant an dieser Adresse einrichten, danach einmal anmelden und Verbindung testen. Schalten fragt weiterhin separat.'
                    : 'Ja = Gerätekennung erneut prüfen und nur lesende Verbindung überwachen. Kein Schalten und keine Konfigurationsänderung am Gerät.',
                    action: { kind: 'approveDevice', deviceId: d.id, fingerprint } },
            }
        })
}

export async function proposeAccounts(): Promise<string> {
    const accounts = detectAccounts(state.config, readAuthProfileShapes(state.dataDir))
    if (!accounts.length) return 'Keine E-Mail-/Kalender-Konten in eigener Config oder eigenem Auth-Speicher gefunden. (Fremde Profile werden nicht gelesen.)'
    // P8: exactly one request per missing login, never repeated (persisted).
    const events = accountEvents(accounts).filter(event => claimOwnerAsk(state.dataDir, `account:${event.subject}`))
    if (events.length) await busForPublish().publish('accounts', events)
    return ['Konten (nur eigene Quellen):', ...accounts.map(account => `${account.connected ? '✅' : '❔'} ${account.label} — ${account.note}`)].join('\n')
}

export async function proposeQuietHours(sessionNames: string[]): Promise<string> {
    const configured = Array.isArray((state.raw as any)?.quietHours?.ownerSessions) ? (state.raw as any).quietHours.ownerSessions : []
    const proposal = learnQuietHours(readOwnerTimestamps(state.dataDir, [...configured, ...sessionNames]), state.config.notify.timezone)
    const current = `${state.config.notify.quietStart}–${state.config.notify.quietEnd} Uhr`
    if (!proposal.learned) return `Ruhezeit bleibt ${current} (nur Dringendes, max. ${state.config.notify.maxPerDay}/Tag): ${proposal.reason}.`
    const text = `Ruhe ${proposal.start}–${proposal.end} Uhr? (${proposal.reason}; aktuell ${current})`
    await busForPublish().publish('quiet-hours', [{
        kind: 'quiet-hours.proposal', subject: 'owner', severity: 'info', dedupeKey: `quiet:${proposal.start}-${proposal.end}`, dedupeWindowMs: 7 * 24 * 60 * 60_000,
        summary: text, evidence: { start: proposal.start, ende: proposal.end, nachrichten: proposal.samples, tage: proposal.days },
        hint: { importance: 'normal', title: `Ruhezeiten-Vorschlag ${proposal.start}–${proposal.end} Uhr`, proposal: 'Als Ruhezeit übernehmen?', action: { kind: 'applyQuietHours', start: proposal.start, end: proposal.end } },
    }])
    return text
}

function formatStatus(): string {
    const cfg = state.config
    const lines = [`Wahrnehmen: ${cfg.enabled ? 'an' : 'aus'} · Suche: ${cfg.discovery.enabled ? 'an' : 'aus'} · Ruhe ${cfg.notify.quietStart}–${cfg.notify.quietEnd} Uhr, max. ${cfg.notify.maxPerDay}/Tag`]
    for (const [id, adapter] of Object.entries(cfg.adapters)) lines.push(`- ${id}: ${adapter.enabled ? 'an' : 'aus'}`)
    for (const item of state.bus?.getStatus() || []) {
        lines.push(`  ${item.id}: ${item.runs} Läufe, ${item.errors} Fehler${item.lastError ? ` (zuletzt: ${item.lastError})` : ''}`)
    }
    return lines.join('\n')
}

/** /geraete [suchen|ja <id>|nein <id>|aus <id>|konten|ruhe|status] — owner only (slash-commands default). */
export async function handleGeraeteCommand(args: string, principal: { principalId?: string; rawUserId?: string; permission?: string } | undefined, from = ''): Promise<string> {
    if (principal?.permission !== 'owner') return '⛔ /geraete ist nur für den Owner.'
    const [sub = '', id = ''] = args.trim().split(/\s+/)
    const approver: Approver = { principalId: principal.principalId || principal.rawUserId || from, permission: principal.permission }
    switch (sub.toLowerCase()) {
        case '':
        case 'liste':
            return `${formatDevices(loadDevices(state.dataDir))}\n\n${formatStatus()}`
        case 'suchen':
        case 'scan':
            return runDiscoveryNow()
        case 'ja':
        case 'einrichten':
            return id ? (await approveSensingDevice(id, approver)).message : 'Usage: /geraete ja <id>'
        case 'nein':
            return id ? setDeviceStatus(state.dataDir, id, 'abgelehnt', approver).message : 'Usage: /geraete nein <id>'
        case 'aus':
            return id ? setDeviceStatus(state.dataDir, id, 'aus', approver).message : 'Usage: /geraete aus <id>'
        case 'konten':
            return proposeAccounts()
        case 'ruhe':
            return proposeQuietHours([principal.principalId, principal.rawUserId, from].filter((item): item is string => Boolean(item)))
        case 'status':
            return formatStatus()
        default:
            return `Unbekannt: ${cleanText(sub, 20)}. /geraete [suchen|ja <id>|nein <id>|aus <id>|konten|ruhe|status]`
    }
}
