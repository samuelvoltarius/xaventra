/**
 * 2.85 — Bedarf für den Software-Scout (Alfred 02.10.: "nicht nur ‚viel RAM da, drück ich was rein‘").
 *
 * A missing capability only becomes a question (permission `fragen`) when there is a
 * recorded need in the last 14 days. Only existing signals, fixed rules, no model:
 *
 * 1. Outcome-Ledger: validated owner runs (`ownerKernelRun`, the one rule) in which a
 *    tool of that capability failed (e.g. `analyze_image` → vision). One run counts once.
 * 2. Werkzeug-Schmiede (`forge/bedarf.json`): a "fehlendes Werkzeug" need whose missing
 *    tool name matches a capability pattern (e.g. `ocr_*` → vision).
 * 3. Channel signals that never reach the ledger (Telegram: owner voice message while no
 *    speech recognition is available) — recorded here with capability, kind and time only.
 *
 * Nothing here stores request text, user ids or file contents.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import type { OutcomeRunView } from '../core/outcome-ledger.js'
import { ownerKernelRun } from '../core/validator-failure-escalation.js'
import { SOFTWARE_CAPABILITIES, type SoftwareCapability } from './software-candidates.js'

export const DEMAND_WINDOW_MS = 14 * 24 * 60 * 60_000

/** Known tools of the registry → the capability they need. */
const TOOL_CAPABILITY: Readonly<Record<string, SoftwareCapability>> = Object.freeze({
    analyze_image: 'vision', analyze_video: 'vision', transcribe_audio: 'stt', speak: 'tts', voice: 'tts',
})
/** Fixed name patterns for tools that are not (yet) in any register (forge "Tool nicht gefunden"). Order matters. */
const NAME_PATTERNS: ReadonlyArray<[RegExp, SoftwareCapability]> = [
    [/^browser_|playwright|chromium/, 'browser'],
    [/^desktop_/, 'desktop'],
    [/transcri|transkri|speech_?to_?text|\bstt\b|whisper|diktat/, 'stt'],
    [/text_?to_?speech|\btts\b|vorlesen|sprachausgabe|^speak/, 'tts'],
    [/vision|image|bild|ocr|foto|photo/, 'vision'],
    [/embed/, 'embedding'],
    [/ffmpeg|video_?(convert|cut|schnitt)|audio_?convert/, 'media'],
]

export function capabilityForTool(name: unknown): SoftwareCapability | null {
    const tool = String(name || '').toLowerCase()
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(tool)) return null
    if (TOOL_CAPABILITY[tool]) return TOOL_CAPABILITY[tool]
    // Producing an image is no recognition need.
    if (/generat|erzeug|zeichne|draw/.test(tool)) return null
    const words = tool.replace(/[_.-]+/g, ' ')
    for (const [pattern, capability] of NAME_PATTERNS) if (pattern.test(tool) || pattern.test(words)) return capability
    return null
}

export type DemandSource = 'owner-lauf' | 'schmiede' | 'kanal'
export interface DemandSignal { capability: SoftwareCapability; source: DemandSource; detail: string; at: number }
export interface CapabilityDemand { capability: SoftwareCapability; count: number; evidence: string[] }

const within = (at: number, now: number) => Number.isFinite(at) && at <= now + 60_000 && now - at <= DEMAND_WINDOW_MS

/** Signal 1: validated owner runs of the last 14 days that failed at a capability tool. */
export function demandFromRuns(runs: readonly OutcomeRunView[], now = Date.now()): DemandSignal[] {
    const out: DemandSignal[] = []
    for (const run of runs) {
        if (!run || !ownerKernelRun(run)) continue
        const at = Date.parse(run.updatedAt)
        if (!within(at, now)) continue
        const seen = new Set<SoftwareCapability>()
        for (const tool of run.tools || []) {
            if (tool?.success !== false) continue
            const name = String(tool.toolName || '')
            const capability = TOOL_CAPABILITY[name] || (name.startsWith('browser_') ? 'browser' : name.startsWith('desktop_') ? 'desktop' : null)
            if (!capability || seen.has(capability)) continue
            seen.add(capability)
            out.push({ capability, source: 'owner-lauf', detail: name, at })
        }
    }
    return out
}

/** Signal 2: forge needs "fehlendes Werkzeug" (tool name only). */
export function demandFromForgeNeeds(needs: ReadonlyArray<{ tool: string; at: string }>, now = Date.now()): DemandSignal[] {
    const out: DemandSignal[] = []
    for (const need of needs) {
        const capability = capabilityForTool(need?.tool)
        const at = Date.parse(String(need?.at || ''))
        if (capability && within(at, now)) out.push({ capability, source: 'schmiede', detail: String(need.tool).slice(0, 80), at })
    }
    return out
}

// Signal 3: channel signals ------------------------------------------------------------

export type ChannelNeedKind = 'sprachnachricht-ohne-stt'
const CHANNEL_KINDS: Readonly<Record<ChannelNeedKind, { capability: SoftwareCapability; label: string }>> = Object.freeze({
    'sprachnachricht-ohne-stt': { capability: 'stt', label: 'Sprachnachricht ohne Spracherkennung' },
})
const signalPath = (path?: string) => path || getNovaDataDir('software-scout', 'bedarf-signale.json')
interface SignalFile { version: 1; signals: Array<{ capability: SoftwareCapability; kind: ChannelNeedKind; at: number }> }

function readSignalFile(path?: string): SignalFile {
    try {
        const file = signalPath(path)
        if (!existsSync(file)) return { version: 1, signals: [] }
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        const signals = Array.isArray(raw?.signals) ? raw.signals.filter((item: any) => item && CHANNEL_KINDS[item.kind as ChannelNeedKind]
            && SOFTWARE_CAPABILITIES.includes(item.capability) && Number.isFinite(Number(item.at))) : []
        return { version: 1, signals: signals.map((item: any) => ({ capability: item.capability, kind: item.kind, at: Number(item.at) })) }
    } catch { return { version: 1, signals: [] } }
}

/** Record a channel signal (capability + kind + time only). Never throws. */
export function recordCapabilityNeed(capability: SoftwareCapability, kind: ChannelNeedKind, options: { path?: string; now?: number } = {}): void {
    try {
        if (!CHANNEL_KINDS[kind] || CHANNEL_KINDS[kind].capability !== capability) return
        const now = options.now ?? Date.now()
        const file = readSignalFile(options.path)
        file.signals = [...file.signals.filter(item => now - item.at <= 2 * DEMAND_WINDOW_MS), { capability, kind, at: now }].slice(-200)
        const target = signalPath(options.path)
        mkdirSync(dirname(target), { recursive: true })
        atomicWriteJsonSync(target, file)
    } catch { /* a missing signal only means: no card */ }
}

export function readCapabilityNeedSignals(options: { path?: string; now?: number } = {}): DemandSignal[] {
    const now = options.now ?? Date.now()
    return readSignalFile(options.path).signals.filter(item => within(item.at, now))
        .map(item => ({ capability: item.capability, source: 'kanal' as const, detail: CHANNEL_KINDS[item.kind].label, at: item.at }))
}

// Summary -----------------------------------------------------------------------------

export function summarizeDemand(signals: readonly DemandSignal[], now = Date.now()): Map<SoftwareCapability, CapabilityDemand> {
    const out = new Map<SoftwareCapability, CapabilityDemand>()
    for (const capability of SOFTWARE_CAPABILITIES) {
        const mine = signals.filter(item => item.capability === capability && within(item.at, now))
        if (!mine.length) continue
        const groups = new Map<string, number>()
        for (const item of mine) {
            const key = item.source === 'owner-lauf' ? `${item.detail} gescheitert (Owner-Läufe, 14 Tage)`
                : item.source === 'schmiede' ? `Schmiede-Bedarf: fehlt ${item.detail}` : `${item.detail} (14 Tage)`
            groups.set(key, (groups.get(key) || 0) + 1)
        }
        out.set(capability, { capability, count: mine.length, evidence: [...groups].map(([key, count]) => `${count}× ${key}`).slice(0, 4) })
    }
    return out
}

/** Production: ledger + forge + channel signals. A source that cannot be read adds nothing (= no card). */
export async function collectCapabilityDemand(now = Date.now()): Promise<Map<SoftwareCapability, CapabilityDemand>> {
    const signals: DemandSignal[] = []
    try {
        const { getOutcomeLedger } = await import('../core/outcome-ledger.js')
        signals.push(...demandFromRuns(getOutcomeLedger().listRuns(500), now))
    } catch { /* no ledger */ }
    try {
        const { forgeMissingToolNeeds } = await import('../tools/skill-builder.js')
        signals.push(...demandFromForgeNeeds(forgeMissingToolNeeds(), now))
    } catch { /* no forge */ }
    signals.push(...readCapabilityNeedSignals({ now }))
    return summarizeDemand(signals, now)
}

// ---------------------------------------------------------------------------------------
// 2.86 Punkt 2 — ein Bedarf, ein Empfänger (Alfred 02.10.: „einbauen“)
// ---------------------------------------------------------------------------------------
//
// One failed tool call used to feed up to four paths that knew nothing of each other
// (Software-Scout, Werkzeug-Schmiede, Bug-Finder, Ideen-Lauf). `classifyNeed` is the one
// place that decides; every other path asks it instead of reacting on its own:
//
//   faehigkeit:<cap>  → Software-Scout    (a capability is missing in the mesh: install question)
//   dienst:<name>     → Verbindungen      (2.85 Paket A: a service is not connected)
//   werkzeug:<name>   → Werkzeug-Schmiede (a tool is missing that sandbox JS can build)
//   code:<name>       → Bug-Finder        (the tool exists and its capability is there: a fault)
//
// Fixed rules, no model, no request text. "Fähigkeit fehlt" needs evidence: either the
// tool's own error text says so, or the Software-Scout's last run listed the capability as
// missing in the whole mesh (`readScoutMissingCapabilities`). A capability tool that fails
// while the capability is present stays a Bug-Finder matter.

export type NeedKind = 'faehigkeit' | 'dienst' | 'werkzeug' | 'code'
export type NeedRecipient = 'software-scout' | 'verbindungen' | 'schmiede' | 'bug-finder'
export interface NeedClassification {
    kind: NeedKind
    /** Stable key, e.g. `faehigkeit:vision`, `dienst:home-assistant`, `werkzeug:ocr_image`, `code:web_search`. */
    key: string
    recipient: NeedRecipient
    capability?: SoftwareCapability
    service?: string
    /** Short German reason for logs and `skipped` entries (no request text). */
    reason: string
}
/** A service rule (2.85 Paket A docks here): returns the service name when the failure means "not connected". */
export type ServiceNeedRule = (toolName: string, errorText: string) => string | null | undefined
export interface ClassifyNeedOptions {
    /** Capabilities missing in the whole mesh (Software-Scout). Without: only the error text proves "fehlt". */
    missingCapabilities?: ReadonlySet<SoftwareCapability>
    /** Additional service rules for this call (registered rules always apply). */
    serviceRules?: readonly ServiceNeedRule[]
}

const RECIPIENT: Readonly<Record<NeedKind, NeedRecipient>> = Object.freeze({ faehigkeit: 'software-scout', dienst: 'verbindungen', werkzeug: 'schmiede', code: 'bug-finder' })
const RECIPIENT_LABEL: Readonly<Record<NeedRecipient, string>> = Object.freeze({ 'software-scout': 'Software-Scout', verbindungen: 'Verbindungen', schmiede: 'Werkzeug-Schmiede', 'bug-finder': 'Bug-Finder' })

/** Error texts that state a capability is missing (media-providers.ts, whisper, ffmpeg, playwright …). */
const MISSING_CAPABILITY_TEXT: ReadonlyArray<[RegExp, SoftwareCapability]> = [
    [/kein(?:en)? provider f(?:ü|ue)r (?:image|video)|unterst(?:ü|ue)tzt keine (?:bildanalyse|videoanalyse)|kein(?:e|en)? (?:vision|bild)[- ]?(?:modell|model|pfad)|no (?:vision|image) (?:model|provider)|vision (?:model )?(?:not available|unavailable|nicht verf(?:ü|ue)gbar)/i, 'vision'],
    [/kein(?:en)? provider f(?:ü|ue)r audio|unterst(?:ü|ue)tzt keine audio-transkription|whisper(?:-cli)?(?:\/whisper)? nicht gefunden|whisper not found|kein(?:e|en)? (?:stt|spracherkennung)|no stt\b|speech recognition (?:not available|unavailable)/i, 'stt'],
    [/kein(?:e|en)? (?:tts|sprachausgabe)|no tts\b|text[- ]to[- ]speech (?:not available|unavailable)/i, 'tts'],
    [/kein(?:e|en)? (?:embedding|einbett)[- ]?(?:modell|model|er)|no embedding (?:model|provider)/i, 'embedding'],
    [/ffmpeg(?: ist)? (?:nicht gefunden|not found|nicht installiert|not installed)|spawn ffmpeg enoent/i, 'media'],
    [/playwright[^.]{0,40}(?:nicht installiert|not installed|executable doesn.?t exist)|chromium[^.]{0,40}(?:nicht gefunden|not found)/i, 'browser'],
]
const MISSING_TOOL_TEXT = /Tool nicht gefunden: ?([A-Za-z0-9_.-]{2,80})|unknown tool:? ?([A-Za-z0-9_.-]{2,80})/i

const serviceRules = new Set<ServiceNeedRule>()
/** 2.85 Paket A (Verbindungen) docks here instead of adding a second need rule. Returns an unregister function. */
export function registerServiceNeedRule(rule: ServiceNeedRule): () => void {
    serviceRules.add(rule)
    return () => { serviceRules.delete(rule) }
}

const serviceName = (value: unknown) => {
    const name = String(value || '').toLowerCase().trim()
    return /^[a-z0-9][a-z0-9._-]{0,60}$/.test(name) ? name : null
}

/** The one need classification. Pure apart from registered service rules. */
export function classifyNeed(toolName: unknown, errorText: unknown = '', options: ClassifyNeedOptions = {}): NeedClassification {
    const tool = String(toolName || '').trim().slice(0, 80) || 'unbekannt'
    const text = String(errorText ?? '').slice(0, 2_000)
    const make = (kind: NeedKind, id: string, reason: string, extra: Partial<NeedClassification> = {}): NeedClassification =>
        ({ kind, key: `${kind}:${id}`, recipient: RECIPIENT[kind], reason, ...extra })

    for (const rule of [...(options.serviceRules || []), ...serviceRules]) {
        let service: string | null = null
        try { service = serviceName(rule(tool, text)) } catch { service = null }
        if (service) return make('dienst', service, `Verbindung fehlt (${service}) → ${RECIPIENT_LABEL.verbindungen}`, { service })
    }
    for (const [pattern, capability] of MISSING_CAPABILITY_TEXT) {
        if (pattern.test(text)) return make('faehigkeit', capability, `Fähigkeit fehlt (${capability}) → ${RECIPIENT_LABEL['software-scout']}`, { capability })
    }
    const byName = capabilityForTool(tool)
    if (byName && options.missingCapabilities?.has(byName)) {
        return make('faehigkeit', byName, `Fähigkeit fehlt (${byName}) → ${RECIPIENT_LABEL['software-scout']}`, { capability: byName })
    }
    const missingTool = MISSING_TOOL_TEXT.exec(text)
    if (missingTool) {
        const name = missingTool[1] || missingTool[2] || tool
        return make('werkzeug', name, `Werkzeug fehlt (${name}) → ${RECIPIENT_LABEL.schmiede}`)
    }
    return make('code', tool, `Fehler in ${tool} → ${RECIPIENT_LABEL['bug-finder']}`)
}

// The Software-Scout's view "fehlt im ganzen Mesh" ------------------------------------
// Written by the scout on every run into its state file (`missing`: capability → time of
// the run). Read here so forge and Bug-Finder ask the same place. Older than two demand
// windows = no statement (then only the error text counts).

export const SCOUT_MISSING_TTL_MS = 2 * DEMAND_WINDOW_MS
const scoutStatePath = (path?: string) => path || getNovaDataDir('software-scout', 'state.json')

export function readScoutMissingCapabilities(options: { statePath?: string; now?: number } = {}): Set<SoftwareCapability> {
    const now = options.now ?? Date.now()
    try {
        const file = scoutStatePath(options.statePath)
        if (!existsSync(file)) return new Set()
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        const missing = raw?.missing && typeof raw.missing === 'object' && !Array.isArray(raw.missing) ? raw.missing as Record<string, unknown> : {}
        return new Set(Object.entries(missing)
            .filter(([capability, at]) => SOFTWARE_CAPABILITIES.includes(capability as SoftwareCapability) && Number.isFinite(Number(at))
                && Number(at) <= now + 60_000 && now - Number(at) <= SCOUT_MISSING_TTL_MS)
            .map(([capability]) => capability as SoftwareCapability))
    } catch { return new Set() }
}

/** Production: the classification with the scout's current view (read once per factory call). */
export function createNeedClassifier(options: { statePath?: string; now?: number } = {}): (toolName: unknown, errorText?: unknown) => NeedClassification {
    const missingCapabilities = readScoutMissingCapabilities(options)
    return (toolName, errorText) => classifyNeed(toolName, errorText, { missingCapabilities })
}
