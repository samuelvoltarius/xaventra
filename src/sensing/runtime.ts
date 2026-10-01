/**
 * Laufzeit des Wahrnehmens: baut den Bus aus `autonomy.sensing`, startet ihn
 * nur am Main (nie mit NOVA_NODE_ONLY) und nur wenn `enabled=true`, und stellt
 * `/geraete` (Owner) bereit. Ausgabe ausschließlich über den Port (./ports.ts).
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
import { approveDevice, formatDevices, loadDevices, monitoredDevices, recordCandidates, setDeviceStatus, type Approver } from './device-registry.js'
import { candidateThoughtText, discoverDevices, realMdnsBrowse, type DiscoveryDeps } from './discovery.js'
import { accountEvents, detectAccounts, readAuthProfileShapes } from './accounts.js'
import { learnQuietHours, readOwnerTimestamps } from './quiet-hours.js'

interface RuntimeState {
    raw: unknown
    rootConfig: any
    config: SensingConfig
    dataDir: string
    bus: SensingBus | null
    sinks: { eventSink?: EventSink; thoughtSink?: ThoughtSink }
    discoveryRunning: boolean
}

const state: RuntimeState = {
    raw: undefined, rootConfig: {}, config: parseSensingConfig(undefined),
    dataDir: join(process.cwd(), '.nova-data'), bus: null, sinks: {}, discoveryRunning: false,
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

/** Builds the bus with every enabled adapter (does not start timers). */
export function buildSensingBus(options: { nodeId?: string; role?: 'main' | 'worker' } = {}): SensingBus {
    const cfg = state.config
    const bus = newBus(options.nodeId || 'local', options.role || 'main')
    const a = cfg.adapters
    if (a.printer.enabled) bus.register(createPrinterAdapter({ targets: printerTargets, intervalMs: a.printer.intervalSec * 1000, timeoutMs: a.printer.timeoutSec * 1000 }))
    if (a.homeassistant.enabled) bus.register(createHomeAssistantAdapter({ connection: () => resolveHaConnection(a.homeassistant, state.rootConfig), entities: a.homeassistant.entities, intervalMs: a.homeassistant.intervalSec * 1000, timeoutMs: a.homeassistant.timeoutSec * 1000 }))
    if (a.mail.enabled) bus.register(createMailAdapter({ config: a.mail, credentials: () => resolveMailCredentials(a.mail, { env: process.env, authProfiles: loadAuthProfiles() }) }))
    if (a.system.enabled) bus.register(createSystemAdapter({ dataDir: state.dataDir, intervalMs: a.system.intervalSec * 1000, timeoutMs: a.system.timeoutSec * 1000 }))
    return bus
}

/**
 * Starts sensing when enabled. Mesh workers never start it: they would only
 * duplicate the main's observations, and they never talk to the owner.
 */
export function startSensing(options: { nodeOnly: boolean; nodeId?: string }): { started: boolean; reason: string } {
    if (!state.config.enabled) return { started: false, reason: 'autonomy.sensing.enabled=false' }
    if (options.nodeOnly) return { started: false, reason: 'Mesh-Worker: Wahrnehmen läuft nur am Main' }
    if (state.bus) return { started: true, reason: 'läuft bereits' }
    state.bus = buildSensingBus({ nodeId: options.nodeId, role: 'main' })
    state.bus.start()
    const active = state.bus.getStatus().map(item => item.id)
    sensingLog(`gestartet, Adapter: ${active.join(', ') || 'keine'}`)
    return { started: true, reason: `Adapter: ${active.join(', ') || 'keine'}` }
}

export function stopSensing(): void {
    state.bus?.stop()
    state.bus = null
}

function busForPublish(): SensingBus {
    return state.bus || newBus('local', 'main')
}

export async function runDiscoveryNow(deps: DiscoveryDeps = {}): Promise<string> {
    const cfg = state.config
    if (!cfg.enabled || !cfg.discovery.enabled) return 'Geräte-Suche ist aus. Einschalten: autonomy.sensing.enabled=true und autonomy.sensing.discovery.enabled=true.'
    if (state.discoveryRunning) return 'Geräte-Suche läuft bereits.'
    state.discoveryRunning = true
    try {
        const report = await discoverDevices({
            deadlineMs: cfg.discovery.deadlineSec * 1000, ratePerSec: cfg.discovery.ratePerSec, concurrency: cfg.discovery.concurrency,
            maxHosts: cfg.discovery.maxHosts, mdns: cfg.discovery.mdns, tailnetHosts: cfg.discovery.tailnetHosts,
        }, { mdnsBrowse: cfg.discovery.mdns ? realMdnsBrowse : undefined, ...deps })
        const fresh = recordCandidates(state.dataDir, report.candidates)
        const events: RawEvent[] = fresh.map(device => {
            const text = candidateThoughtText(device)
            return {
                kind: 'discovery.device', subject: device.id, severity: 'info', dedupeKey: `device:${device.id}`, dedupeWindowMs: 30 * 24 * 60 * 60_000,
                summary: text.summary,
                evidence: { geraet: device.id, typ: device.type, adresse: `${device.host}:${device.port}`, gefunden_ueber: device.via },
                hint: { importance: 'normal', title: text.title, proposal: text.proposal, action: { kind: 'approveDevice', deviceId: device.id } },
            }
        })
        if (events.length) await busForPublish().publish('discovery', events)
        return [
            `Suche fertig in ${Math.round(report.durationMs / 100) / 10} s: ${report.scannedHosts} Adressen, ${report.probes} Proben${report.timedOut ? ' (Zeitlimit erreicht)' : ''}.`,
            `Netze: ${report.scope.subnets.join(', ') || 'keine privaten'}${report.scope.hasTailnet ? ' + Tailnet' : ''}.`,
            report.rejected.length ? `Abgelehnt (fremd/öffentlich): ${report.rejected.length}.` : '',
            fresh.length ? `Neu gefunden: ${fresh.map(device => `${device.name} (${device.id})`).join('; ')} — einrichten mit /geraete ja <id>.` : 'Keine neuen Geräte.',
        ].filter(Boolean).join('\n')
    } finally {
        state.discoveryRunning = false
    }
}

/** The card's [Ja] calls this. Only the owner. */
export function approveSensingDevice(id: string, approver: Approver): { ok: boolean; message: string } {
    const result = approveDevice(state.dataDir, id, approver)
    return { ok: result.ok, message: result.message }
}

export async function proposeAccounts(): Promise<string> {
    const accounts = detectAccounts(state.config, readAuthProfileShapes(state.dataDir))
    if (!accounts.length) return 'Keine E-Mail-/Kalender-Konten in eigener Config oder eigenem Auth-Speicher gefunden. (Fremde Profile werden nicht gelesen.)'
    const events = accountEvents(accounts)
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
            return id ? approveSensingDevice(id, approver).message : 'Usage: /geraete ja <id>'
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
