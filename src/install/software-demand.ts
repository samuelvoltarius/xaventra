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
