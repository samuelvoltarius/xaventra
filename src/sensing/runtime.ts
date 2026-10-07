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
import { effectiveProxmoxConfig, loadProxmoxRuntime } from '../infra/proxmox.js'
import { confirmedProxmoxApp } from '../infra/proxmox-app-store.js'
import { approveDevice, autoMonitorDevices, claimOwnerAsk, credentialNeed, DEVICE_LABEL, formatDevices, loadDevices, monitoredDevices, recordCandidates, setDeviceStatus, type Approver, type DeviceRecord } from './device-registry.js'
import { discoverDevices, realMdnsBrowse, type DiscoveryDeps } from './discovery.js'
import { accountEvents, detectAccounts, readAuthProfileShapes } from './accounts.js'
import { learnQuietHours, readOwnerTimestamps } from './quiet-hours.js'
import { readDiscoveryCursor, recordDiscoveryObservation } from './awareness.js'
import { getServiceRuntime } from '../runtime/service-runtime.js'
import { HARDWARE_LABEL, HARDWARE_PROMPT, recognizeHardware, verifyHardwareConnection, type HardwareModel } from './hardware-recognition.js'
import { markHardwareAsked, sensingDeviceFingerprint, deviceId } from './device-registry.js'
import { createHardwareAdapter } from './adapters/hardware.js'
import { refreshHaInventory, haInventoryEvents } from './ha-inventory.js'
import { realSsdpBrowse } from './ssdp.js'
import { realTuyaBrowse } from './tuya-discovery.js'
import { createDirectSmartAdapter, requestHuePairing } from './direct-smart-devices.js'
import { chooseSmartRoute, selectedSmartRoute, approveSmartRoute, smartRouteEvents } from './smart-device-route.js'
import { proposeSmartSwitch, confirmSmartSwitch } from './smart-control.js'
import { executeSmartSwitch } from './smart-control-http.js'
import { nutzenSatz } from './device-words.js'
import { connectionState, recordFrageKey, standKontext, verbindungsFrageOffen } from '../connections/connection-state.js'

const PRINTER_TYPES: ReadonlySet<string> = new Set(['moonraker', 'octoprint', 'prusalink', 'bambu'])

interface RuntimeState {
    raw: unknown
    rootConfig: any
    config: SensingConfig
    dataDir: string
    bus: SensingBus | null
    sinks: { eventSink?: EventSink; thoughtSink?: ThoughtSink }
    discoveryRunning: boolean
    discoveryInFlight?: Promise<string>
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
    if (cfg.discovery.enabled) bus.register(createDirectSmartAdapter(state.dataDir))
    if (a.printer.enabled) bus.register(createPrinterAdapter({ targets: printerTargets, intervalMs: a.printer.intervalSec * 1000, timeoutMs: a.printer.timeoutSec * 1000 }))
    if (a.homeassistant.enabled) bus.register(createHomeAssistantAdapter({ connection: () => resolveHaConnection(a.homeassistant, state.rootConfig), entities: a.homeassistant.entities, intervalMs: a.homeassistant.intervalSec * 1000, timeoutMs: a.homeassistant.timeoutSec * 1000 }))
    if (a.homeassistant.enabled) bus.register({ id: 'homeassistant-inventory', source: 'homeassistant', intervalMs: 120_000, timeoutMs: 25_000,
        async poll(ctx) {
            const sources = await refreshHaInventory(state.dataDir, resolveHaConnection(a.homeassistant, state.rootConfig), ctx.signal)
            if (ctx.signal.aborted) return []
            const previous = (ctx.state.functions || {}) as Record<string, string[]>
            const events = haInventoryEvents(sources, previous); ctx.state.functions = previous
            return events
        } })
    if (a.mail.enabled) bus.register(createMailAdapter({ config: a.mail, credentials: () => resolveMailCredentials(a.mail, { env: process.env, authProfiles: loadAuthProfiles() }) }))
    if (a.system.enabled) bus.register(createSystemAdapter({ dataDir: state.dataDir, intervalMs: a.system.intervalSec * 1000, timeoutMs: a.system.timeoutSec * 1000 }))
    // Phase 6c: Proxmox (read only) when infra.proxmox is on and watch is not false.
    const pveRaw = state.rootConfig?.infra?.proxmox
    // 2.88: also the app setup (token + confirmed fingerprint), not only infra.proxmox.
    const pve = effectiveProxmoxConfig(pveRaw, () => confirmedProxmoxApp())
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
        // 2.86 Paket N: the result as a benefit sentence (no address, no command); details stay in the evidence.
        summary: `${PRINTER_TYPES.has(device.type) ? nutzenSatz({ drucker: 1 }) : `${DEVICE_LABEL[device.type]} sehe ich jetzt.`} Ich lese nur; abschalten geht unter „Geräte“.`,
        evidence: { geraet: device.id, typ: device.type, adresse: `${device.host}:${device.port}`, gefunden_ueber: device.via, status: 'eingerichtet (selbst, lesend)' },
        hint: { importance: 'normal' as const, title: `Gefunden + überwacht: ${PRINTER_TYPES.has(device.type) ? '3D-Drucker' : DEVICE_LABEL[device.type]}` },
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

type RunDeps = DiscoveryDeps & { hardwareModel?: HardwareModel; consolidation?: import('./device-consolidation.js').KonsolidierungsKontext; cardOpts?: import('../core/approval-cards.js').CardStoreOptions }

export function runDiscoveryNow(deps: RunDeps = {}, signal?: AbortSignal): Promise<string> {
    // A foreground fresh inventory must wait for the current bounded scan,
    // not mistake "already running" for fresh observations or start a rival scan.
    signal?.throwIfAborted()
    if (state.discoveryInFlight) {
        // Cancelling a subscriber must not stop an already running background scan.
        if (!signal) return state.discoveryInFlight
        return waitForDiscovery(state.discoveryInFlight, signal)
    }
    const operation = performDiscovery(deps, signal).finally(() => {
        if (state.discoveryInFlight === operation) state.discoveryInFlight = undefined
    })
    state.discoveryInFlight = operation
    return operation
}

function waitForDiscovery(work: Promise<string>, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        const stop = () => reject(signal.reason || new Error('Discovery cancelled'))
        signal.addEventListener('abort', stop, { once: true })
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
        if (signal.aborted) stop()
    })
}

async function performDiscovery(deps: RunDeps, signal?: AbortSignal): Promise<string> {
    const cfg = state.config
    if (!cfg.enabled || !cfg.discovery.enabled) return 'Geräte-Suche ist aus (autonomy.sensing.enabled bzw. autonomy.sensing.discovery.enabled steht auf false).'
    state.discoveryRunning = true
    const controller = new AbortController()
    const stop = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    state.discoveryAbort = controller
    const dataDir = state.dataDir
    try {
        const report = await discoverDevices({
            deadlineMs: signal ? Math.min(cfg.discovery.deadlineSec * 1000, 60_000) : cfg.discovery.deadlineSec * 1000, ratePerSec: cfg.discovery.ratePerSec, concurrency: cfg.discovery.concurrency,
            maxHosts: cfg.discovery.maxHosts, mdns: cfg.discovery.mdns, tailnetHosts: cfg.discovery.tailnetHosts,
            cursor: readDiscoveryCursor(dataDir), signal: controller.signal,
        }, { mdnsBrowse: cfg.discovery.mdns ? realMdnsBrowse : undefined, ssdpBrowse: cfg.discovery.mdns ? ms => realSsdpBrowse(ms, deps.interfaces) : undefined,
            tuyaBrowse: cfg.discovery.mdns ? ms => realTuyaBrowse(ms, deps.interfaces, controller.signal) : undefined, ...deps })
        if (controller.signal.aborted) return 'Geräte-Suche beim Stoppen abgebrochen.'
        const known = loadDevices(dataDir)
        const attempted = (host: string) => Math.max(0, ...known.filter(d => d.host === host).map(d => Date.parse(d.hardware?.observedAt || '') || 0))
        const eligible = report.candidates.filter(c => !known.some(d => d.host === c.host && ['abgelehnt', 'aus'].includes(d.status)))
            .sort((a, b) => {
                const rank = (c: typeof a) => c.port > 0 && c.via !== 'neighbor' ? 0 : 1
                return rank(a) - rank(b) || attempted(a.host) - attempted(b.host)
            })
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
        // Paket L: container bridges, the own machine and unidentified ports of own mesh
        // nodes are noise — not recorded at all. Tailnet/LAN twins are remembered.
        const { defaultConsolidationContext, isNoiseCandidate, recordHostAliases } = await import('./device-consolidation.js')
        recordHostAliases(dataDir, report.aliases || {})
        const scopeCtx = deps.consolidation || await defaultConsolidationContext(dataDir, deps.interfaces)
        const all = [...enriched, ...report.candidates.filter(c => !eligible.includes(c))]
        const fresh = recordCandidates(dataDir, all.filter(c => !isNoiseCandidate(c, scopeCtx)))
        recordDiscoveryObservation(dataDir, report)
        // P8: watching is L0 — found devices are monitored right away, no card.
        const handled = autoMonitorDevices(dataDir)
        // Paket L: no silent „brauche Zugang“ thoughts — connectable devices get ONE card in
        // the bundled device message (device-connect.ts); only watched devices are reported.
        const events = deviceEvents({ monitored: handled.monitored, asked: [] })
        if (events.length) await busForPublish().publish('discovery', events)
        if (process.env.NOVA_NODE_ONLY !== 'true') {
            const found = loadDevices(dataDir)
            // Shelly/Tasmota/ESPHome keep their existing connect offer; HA, Hue, Tuya and
            // Matter are asked through the device bundle (no second question).
            const bundled = (d: DeviceRecord) => d.type === 'homeassistant' || ['hue', 'tuya', 'matter'].includes(String(d.hardware?.ecosystem)) || d.hardware?.connector === 'matter-ip'
            const offers: RawEvent[] = []
            for (const offer of hardwareConnectionEvents(found, { dataDir })) {
                const d = found.find(d => d.id === offer.subject)!
                if (bundled(d)) continue
                const route = selectedSmartRoute(dataDir, d)
                if (!(!d.hardware?.connector || route === 'local' || (route === 'cloud' && ['tuya-announcements', 'shelly-readonly'].includes(d.hardware.connector)))) continue
                // 2.89: never a second question about the same thing (card or thought with the same key).
                if (await verbindungsFrageOffen(offer.dedupeKey, { dataDir })) continue
                offers.push(offer)
            }
            if (offers.length) {
                await busForPublish().publish('discovery', offers)
                for (const offer of offers) markHardwareAsked(dataDir, offer.subject, String(offer.evidence.fingerprint))
            }
            try {
                const { offerDeviceConnections } = await import('./device-connect.js')
                const { migrateDeviceRegistry } = await import('./device-consolidation.js')
                migrateDeviceRegistry(dataDir, scopeCtx)
                // The card loop (every minute) delivers them as ONE bundled message.
                await offerDeviceConnections({ dataDir, ctx: scopeCtx, ...(deps.cardOpts ? { cardOpts: deps.cardOpts } : {}) })
            } catch (error) { sensingLog(`Geräte-Fragen nicht erstellt: ${cleanText(String((error as Error)?.message || error), 160)}`) }
        }
        const watchedIds = new Set(handled.monitored.map(device => device.id))
        return [
            `Suche fertig in ${Math.round(report.durationMs / 100) / 10} s: ${report.scannedHosts} Adressen, ${report.probes} Proben${report.timedOut ? ' (Zeitlimit erreicht)' : ''}.`,
            `Netze: ${report.scope.subnets.join(', ') || 'keine privaten'}${report.scope.hasTailnet ? ' + Tailnet' : ''}.`,
            report.rejected.length ? `Abgelehnt (fremd/öffentlich): ${report.rejected.length}.` : '',
            fresh.length ? `Neu gefunden: ${fresh.map(device => `${device.name} (${device.id}, ${watchedIds.has(device.id) ? 'überwacht, nur lesend' : handled.asked.some(asked => asked.id === device.id) ? (device.type === 'homeassistant' ? 'Verbinden-Frage in der Geräte-Nachricht' : 'Zugang fehlt, in der App unter Verbindungen eintragen') : 'beobachtet, Steuerung nicht geprüft'})`).join('; ')}.` : 'Keine neuen Geräte.',
            handled.monitored.some(device => !fresh.some(item => item.id === device.id)) ? `Jetzt überwacht (früher gefunden): ${handled.monitored.filter(device => !fresh.some(item => item.id === device.id)).map(device => device.name).join('; ')}.` : '',
        ].filter(Boolean).join('\n')
    } finally {
        signal?.removeEventListener('abort', stop)
        state.discoveryRunning = false
        if (state.discoveryAbort === controller) state.discoveryAbort = undefined
    }
}

/** The card's [Ja] calls this. Only the owner. */
export async function approveSensingDevice(id: string, approver: Approver, fingerprint?: string, deps: DiscoveryDeps = {}): Promise<{ ok: boolean; message: string }> {
    if (approver.permission !== 'owner' || !String(approver.principalId || '').trim()) return { ok: false, message: 'Nur der Owner kann Geräte verbinden.' }
    const dataDir = state.dataDir
    const device = loadDevices(dataDir).find(d => d.id === id)
    const route = device?.hardware?.connector ? selectedSmartRoute(dataDir, device) : undefined
    if (device?.hardware?.connector && !route) return { ok: false, message: `Bitte zuerst gemeinsam den Zugriffsweg wählen: /geraete weg ${id} lokal oder /geraete weg ${id} cloud. Noch nichts verbunden.` }
    if (route === 'cloud' && !['tuya-announcements', 'shelly-readonly'].includes(device?.hardware?.connector)) return { ok: false, message: 'Für dieses Gerät ist der Hersteller-Cloud-Zugang noch nicht implementiert. Keine Verbindung und kein stiller Wechsel auf lokal.' }
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
            if (existing && connectionState(dataDir, { verbindung: existing }).zustand === 'verbunden' && existing.basis !== basis) return { ok: false, message: 'Bereits mit einer anderen Home-Assistant-Zentrale verbunden. Kein automatischer Wechsel.' }
            return connectFromApproval('home-assistant', approver.principalId, { ...defaultDeps(), dataDir, foundHomeAssistant: () => [basis] })
        }
        if (!await verifyHardwareConnection(device, deps)) return { ok: false, message: 'Gerätekennung oder unterstützte lesende Verbindung nicht bestätigt. Nichts verbunden.' }
        const latest = loadDevices(dataDir).find(d => d.id === id)
        if (!latest || sensingDeviceFingerprint(latest) !== sensingDeviceFingerprint(device) || ['abgelehnt', 'aus'].includes(latest.status)) {
            return { ok: false, message: 'Gerätefund während der Prüfung geändert. Nichts verbunden.' }
        }
    }
    const result = approveDevice(dataDir, id, approver)
    if (result.ok && route && !approveSmartRoute(dataDir, loadDevices(dataDir).find(d => d.id === id)!, route, approver.principalId)) return { ok: false, message: 'Zugriffsweg während der Prüfung geändert. Keine neue Zugriffsfreigabe; bitte erneut bestätigen.' }
    if (result.ok && device?.hardware?.access === 'hue-pairing-v1') {
        requestHuePairing(dataDir, loadDevices(dataDir).find(d => d.id === id)!, approver.principalId)
        return { ok: true, message: 'Lokales Hue-Pairing freigegeben. Bitte innerhalb von zwei Minuten die Taste der gefundenen Bridge drücken. Nova registriert dann nur diesen lokalen Zugang und liest die Lampen direkt, ohne Home Assistant oder Hersteller-Cloud. Kein Schalten freigegeben.' }
    }
    if (result.ok && route === 'cloud') return { ok: true, message: 'Lesendes Hersteller-Cloud-Funktionsinventar für genau dieses Gerät freigegeben. Privaten Herstellerzugang unter Verbindungen im Desktop eintragen, nicht im Chat. Fehlender Zugang ist kein Verbindungserfolg. Kein lokaler Ersatzweg und kein Schalten.' }
    if (result.ok && device?.hardware?.connector === 'matter-ip') return { ok: true, message: 'Matter-Verbindungsweg freigegeben, noch kein Pairing. Im Desktop den privaten manuellen Code und das gesonderte Pairing-Ja eingeben. Bestehendes Gerät: Multi-Admin-Fenster am bisherigen Controller öffnen, nicht zurücksetzen. Thread benötigt Border-Router und IPv6-Erreichbarkeit. Kein Schalten.' }
    if (result.ok && ['tuya-announcements', 'esphome-native'].includes(device?.hardware?.connector)) return { ok: true,
        message: 'Lokaler lesender Gerätezugriff freigegeben. Den privaten Local-Key beziehungsweise ESPHome Encryption-Key unter Verbindungen im Desktop eintragen, nicht im Chat. Tatsächliches Abfrageergebnis folgt separat; keine Schaltfreigabe und kein bereits bestätigter Gerätezugang.' }
    return { ok: result.ok, message: result.message }
}

export function declineSensingDevice(id: string, approver: Approver, fingerprint?: string): { ok: boolean; message: string } {
    if (fingerprint) {
        const device = loadDevices(state.dataDir).find(d => d.id === id)
        if (!device || sensingDeviceFingerprint(device) !== fingerprint) return { ok: false, message: 'Der Gerätefund hat sich geändert; alte Antwort nicht angewendet.' }
    }
    return setDeviceStatus(state.dataDir, id, 'abgelehnt', approver)
}

/**
 * Only supported, protocol-verified endpoints become actionable questions. 2.89: only what
 * the one connection truth calls „gefunden“ (a connected or configured Home Assistant, a
 * paired bridge … is never offered again); the question key is the shared
 * `verbindung:<connector|Gerät>` of every connection question.
 */
export function hardwareConnectionEvents(devices: DeviceRecord[], options: { dataDir?: string; now?: number; konfiguriertesHa?: string | null } = {}): RawEvent[] {
    const now = options.now ?? Date.now()
    const dataDir = options.dataDir || state.dataDir
    const kontext = standKontext(dataDir, { devices, ...(options.konfiguriertesHa !== undefined ? { konfiguriertesHa: options.konfiguriertesHa } : {}) })
    return devices.filter(d => d.status === 'gefunden' && Number.isFinite(Date.parse(d.lastSeenAt)) && now - Date.parse(d.lastSeenAt) <= 24 * 60 * 60_000
        && ((d.type === 'homeassistant' && d.via === 'http') || ['esphome-native', 'matter-ip'].includes(d.hardware?.connector) || (d.hardware?.certainty === 'confirmed' && ['shelly-readonly', 'hue-readonly', 'tasmota-readonly', 'tuya-announcements'].includes(d.hardware.connector))))
        .filter(d => d.hardwareAskedFingerprint !== sensingDeviceFingerprint(d))
        .filter(d => connectionState(dataDir, { record: d }, kontext).zustand === 'gefunden').map(d => {
            const fingerprint = sensingDeviceFingerprint(d)
            const compatible = [...new Set(devices.filter(other => other.status === 'gefunden' && other.hardware?.certainty === 'confirmed' && other.hardware.ecosystem
                && now - Date.parse(other.lastSeenAt) <= 24 * 60 * 60_000).map(other => other.hardware.ecosystem))].join(', ')
            const label = d.hardware ? `${HARDWARE_LABEL[d.hardware.kind]}: ${d.hardware.label}` : 'Home Assistant (Smart-Home-Zentrale; angeschlossene Geräte noch nicht ausgelesen)'
            return { kind: 'discovery.connection-offer', subject: d.id, severity: 'info', dedupeKey: recordFrageKey(dataDir, d, kontext), dedupeWindowMs: 365 * 24 * 60 * 60_000,
                summary: `${label} bei ${d.host} erkannt. ${d.hardware?.connector === 'tuya-announcements' ? 'Soll ich den gewählten lesenden Gerätezugriff einrichten? Lokal braucht der direkte Zugriff deinen privaten Local-Key; Geräteart und Zugang sind noch ungeprüft.' : 'Soll ich mich damit verbinden?'}${d.type === 'homeassistant' && compatible ? ` Weitere Protokollfunde: ${compatible}; ob diese dort eingebunden sind, prüfe ich erst nach Anmeldung.` : ''}`, evidence: { geraet: d.id, fingerprint, adresse: d.host, kennung: d.hardware?.identity || 'Home-Assistant-Manifest' },
                hint: { importance: 'normal', title: `Gefunden: ${label}`, level: 'fragen', proposal: d.hardware?.connector === 'tuya-announcements'
                    ? `Zuerst /geraete weg ${d.id} lokal oder /geraete weg ${d.id} cloud wählen. Ja bestätigt danach nur den gewählten lesenden Weg: lokal direkte verschlüsselte Abfragen nach separater privater Local-Key-Eingabe im Desktop; Cloud Funktionsschema mit gesondertem API-Zugang. Kein Schalten und kein automatischer Wechsel; Geräteart bleibt bis zu Belegen unbekannt.` : d.type === 'homeassistant'
                    ? 'Ja = Home Assistant an dieser Adresse einrichten, danach einmal anmelden und Verbindung testen. Schalten fragt weiterhin separat.'
                    : `Zuerst gemeinsam wählen: /geraete weg ${d.id} lokal oder /geraete weg ${d.id} cloud. Ja bestätigt erst danach den gewählten unterstützten Zugang. Lokal bei Hue: Bridge-Taste für Pairing erforderlich. Kein Schalten und kein stiller Wechsel auf den anderen Weg.`,
                    action: { kind: 'approveDevice', deviceId: d.id, fingerprint } },
            }
        })
}

/** Inform automatically when a protocol was identified but no credentialed
 * executor exists. Do not turn an unsupported connection into a fake Ja card. */
export function unsupportedHardwareEvents(devices: DeviceRecord[], now = Date.now()): RawEvent[] {
    return devices.filter(d => d.status === 'gefunden' && d.hardware?.ecosystem === 'tuya' && !d.hardware.connector && d.hardware.certainty === 'confirmed'
        && Number.isFinite(Date.parse(d.lastSeenAt)) && now - Date.parse(d.lastSeenAt) >= 0 && now - Date.parse(d.lastSeenAt) <= 24 * 3600_000).slice(0, 16).map(d => ({
        kind: 'discovery.hardware-protocol', subject: d.id, severity: 'info', dedupeKey: `hardware-protocol:${d.id}:${sensingDeviceFingerprint(d)}`, dedupeWindowMs: 30 * 24 * 3600_000,
        summary: `Tuya-kompatibles Gerät bei ${d.host} erkannt. Ob Lampe, Steckdose oder anderes, ist noch unbekannt. Eine vorhandene Home-Assistant-Zentrale kann nach deiner Anmeldung ihren eingebundenen Bestand liefern. Direkter Tuya-Zugriff braucht autorisierten Zugang; derzeit nicht verbunden oder steuerbar.`,
        evidence: { geraet: d.id, adresse: d.host, protokoll: 'Tuya', kennung: d.hardware.identity },
        hint: { title: 'Tuya-Gerät gefunden — Geräteart/Zugang noch offen', importance: 'normal', level: 'selbst' },
    }))
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
    const [sub = '', id = '', route = ''] = args.trim().split(/\s+/)
    const approver: Approver = { principalId: principal.principalId || principal.rawUserId || from, permission: principal.permission }
    switch (sub.toLowerCase()) {
        case '':
        case 'liste': {
            if (id === 'roh') return `${formatDevices(loadDevices(state.dataDir))}\n\n${formatStatus()}`
            const { loadConsolidatedDevices, formatGeraete } = await import('./device-consolidation.js')
            return formatGeraete(await loadConsolidatedDevices(state.dataDir))
        }
        case 'suchen':
        case 'scan':
            return runDiscoveryNow()
        case 'weg':
            if (!id) return 'Usage: /geraete weg <id> lokal|cloud'
            {
                const result = chooseSmartRoute(state.dataDir, id, route === 'lokal' ? 'local' : route.toLowerCase(), approver)
                if (result.ok && state.bus) {
                    const devices = loadDevices(state.dataDir), chosen = devices.find(d => d.id === id)!
                    const selected = selectedSmartRoute(state.dataDir, chosen)
                    const offers = hardwareConnectionEvents(devices, { dataDir: state.dataDir }).filter(offer => offer.subject === id && (selected === 'local' || (selected === 'cloud' && ['tuya-announcements', 'shelly-readonly'].includes(chosen.hardware?.connector))))
                    if (offers.length) {
                        await busForPublish().publish('discovery', offers)
                        for (const offer of offers) markHardwareAsked(state.dataDir, id, String(offer.evidence.fingerprint))
                    }
                }
                return result.message
            }
        case 'ja':
        case 'einrichten':
            return id ? (await approveSensingDevice(id, approver)).message : 'Usage: /geraete ja <id>'
        case 'schalten': {
            const { getServiceFencingToken, MAIN_SERVICE } = await import('../mesh/leader-election.js')
            if (!getServiceFencingToken(MAIN_SERVICE)) return 'Nur der autoritative Main kann konkrete Geräteaktionen vorbereiten.'
            const parts = args.trim().split(/\s+/), target = parts[3]
            if (parts.length !== 4 || !['ein', 'aus'].includes(target)) return 'Usage: /geraete schalten <id> <funktion> ein|aus — bereitet nur vor, schaltet noch nicht.'
            const result = proposeSmartSwitch(state.dataDir, { deviceId: id, functionId: route, on: target === 'ein' }, approver)
            return result.message + (result.proposal ? `\nSeparat genau diese physische Aktion bestätigen: /geraete bestaetigen ${result.proposal.id}` : '')
        }
        case 'bestaetigen': {
            const { getServiceFencingToken, MAIN_SERVICE } = await import('../mesh/leader-election.js')
            const result = await confirmSmartSwitch(state.dataDir, id, approver, () => Boolean(getServiceFencingToken(MAIN_SERVICE)),
                (d, a, signal, authorize) => executeSmartSwitch(state.dataDir, d, a, signal, authorize))
            return result.message
        }
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
        // 2.86 Paket N: „Licht im Wohnzimmer aus“ / „Jeden Abend um 23 Uhr alles aus“ → preview card ('' = not a device sentence).
        case 'sag': {
            const { sagSchalten, productionSchaltDeps } = await import('./device-switch.js')
            return sagSchalten({ ...(await productionSchaltDeps()), dataDir: state.dataDir }, args.trim().slice(sub.length).trim(), approver.principalId)
        }
        case 'stand': {
            const { vorgangsStand } = await import('./connect-progress.js')
            return vorgangsStand(state.dataDir)
        }
        case 'routinen': {
            const { routinenListe, productionSchaltDeps } = await import('./device-switch.js')
            return routinenListe({ ...(await productionSchaltDeps()), dataDir: state.dataDir }, approver.principalId)
        }
        default:
            return `Unbekannt: ${cleanText(sub, 20)}. /geraete [suchen|weg <id> lokal|cloud|ja <id>|nein <id>|aus <id>|schalten <id> <funktion> ein|aus|bestaetigen <aktions-id>|konten|ruhe|status]`
    }
}
