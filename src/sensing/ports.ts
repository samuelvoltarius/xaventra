/**
 * Wahrnehmen (Autonomie-Plan Phase 2) — der Ausgabe-Port.
 *
 * Der Ereignis-Bus und die Selbst-Erkennung schreiben NUR in diesen Port. Sie
 * senden nie selbst etwas an den Owner (kein Telegram, kein ProactiveMessenger,
 * keine Mesh-Nachricht). Zustellung, Knopf-Karten und der Gedanken-Speicher
 * hängen sich bei der Integration als eigene `EventSink`/`ThoughtSink` an.
 *
 * Port-Format (Schema-Version 1, ein JSON-Objekt pro Zeile):
 *
 *   EventSink.writeEvent(SensingEvent)
 *     { schema: "xaventra.sensing.event/1", id, at (ISO), source, kind, subject,
 *       summary, severity: "info"|"warning"|"urgent", dedupeKey,
 *       evidence: { key: string|number|boolean|null } }
 *
 *   ThoughtSink.writeThought(SensingThought)
 *     { schema: "xaventra.sensing.thought/1", id, at, source, eventId?, title,
 *       summary, evidence, importance: "niedrig"|"normal"|"hoch"|"dringend",
 *       proposal?, level: "selbst"|"fragen"|"nie", status: "neu",
 *       action?: { kind: "approveDevice", deviceId }
 *              | { kind: "connectAccount", accountId }
 *              | { kind: "applyQuietHours", start, end },
 *       delivery: { notify, urgent, reason: "ok"|"ruhezeit"|"tageslimit"|"nur-protokoll" },
 *       origin: { nodeId, role: "main"|"worker" }, dedupeKey }
 *
 * Regeln für Verbraucher:
 * - `delivery.notify=false` heißt: nur in die Liste (/gedanken), nicht melden.
 *   `ruhezeit` darf nach der Ruhezeit zugestellt werden, `tageslimit` am Folgetag.
 * - `action` beschreibt, was ein [Ja]-Knopf aufrufen würde. Die Freigabe erzeugt
 *   immer der Code (Karte → z. B. `approveDevice(id, owner)`), nie das Modell.
 * - Physische/nach außen wirkende Vorschläge haben immer `level: "fragen"`.
 * - `origin.role="worker"`: ein Mesh-Worker meldet nie selbst; der Main entscheidet.
 * - Felder enthalten nie Secrets und nie Mail-Volltext (nur Absender, gekürzter
 *   Betreff, erkannte Stichworte).
 *
 * Standard-Sinks: JSONL unter `<dataDir>/sensing/events.jsonl` bzw.
 * `<dataDir>/sensing/thoughts.jsonl` (Modus 0600).
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { redactSecrets } from '../security/secret-redaction.js'

export const EVENT_SCHEMA = 'xaventra.sensing.event/1' as const
export const THOUGHT_SCHEMA = 'xaventra.sensing.thought/1' as const

export type SensingSource = 'printer' | 'homeassistant' | 'mail' | 'system' | 'discovery' | 'accounts' | 'quiet-hours' | 'proxmox'
export type SensingSeverity = 'info' | 'warning' | 'urgent'
export type Importance = 'niedrig' | 'normal' | 'hoch' | 'dringend'
export type PermissionLevel = 'selbst' | 'fragen' | 'nie'
export type EvidenceValue = string | number | boolean | null
export type Evidence = Record<string, EvidenceValue>

export interface SensingEvent {
    schema: typeof EVENT_SCHEMA
    id: string
    at: string
    source: SensingSource
    /** e.g. printer.near-done, printer.done, ha.state, mail.new, system.nightwatch */
    kind: string
    /** device / entity / account the event is about (no secrets) */
    subject: string
    summary: string
    severity: SensingSeverity
    dedupeKey: string
    evidence: Evidence
    /** optional override of the bus dedupe window */
    dedupeWindowMs?: number
    /** rule hints from the adapter, used by the evaluator */
    hint?: { importance?: Importance; proposal?: string; level?: PermissionLevel; action?: ThoughtAction; title?: string }
}

export type ThoughtAction =
    | { kind: 'approveDevice'; deviceId: string; fingerprint?: string }
    | { kind: 'connectAccount'; accountId: string }
    | { kind: 'applyQuietHours'; start: number; end: number }

export interface ThoughtDelivery {
    notify: boolean
    urgent: boolean
    reason: 'ok' | 'ruhezeit' | 'tageslimit' | 'nur-protokoll'
}

export interface SensingThought {
    schema: typeof THOUGHT_SCHEMA
    id: string
    at: string
    source: SensingSource
    eventId?: string
    title: string
    summary: string
    evidence: Evidence
    importance: Importance
    proposal?: string
    level: PermissionLevel
    status: 'neu'
    action?: ThoughtAction
    delivery: ThoughtDelivery
    origin: { nodeId: string; role: 'main' | 'worker' }
    dedupeKey: string
}

export interface EventSink { writeEvent(event: SensingEvent): void | Promise<void> }
export interface ThoughtSink { writeThought(thought: SensingThought): void | Promise<void> }

export function newId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
}

const MAX_TEXT = 300

/** Defence in depth: every string that leaves the bus is redacted and capped. */
export function cleanText(value: unknown, max = MAX_TEXT): string {
    const text = redactSecrets(String(value ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
    if (text.length <= max) return text
    // 2.89.4: never a mid-word „…“ (live: „daraus fo…“). Keep whole sentences;
    // if none fits, keep whole words of the first one without a dangling cut mark.
    const head = text.slice(0, max)
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('.\n'))
    if (sentence >= 4) return head.slice(0, sentence + 1).trim()
    const word = head.lastIndexOf(' ')
    return (word >= 4 ? head.slice(0, word) : head).trim().replace(/[,;:–-]+$/, '')
}

export function cleanEvidence(evidence: Record<string, unknown> | undefined): Evidence {
    const out: Evidence = {}
    for (const [key, value] of Object.entries(evidence || {}).slice(0, 30)) {
        if (/pass(word)?|secret|token|api[-_]?key|authorization|cookie|body|text|snippet/i.test(key)) continue
        if (value === null || typeof value === 'boolean') out[key] = value as EvidenceValue
        else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null
        else if (value !== undefined) out[key] = cleanText(value, 200)
    }
    return out
}

function appendJsonl(path: string, dir: string, value: unknown): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

/** Default EventSink: `<dataDir>/sensing/events.jsonl`. */
export class JsonlEventSink implements EventSink {
    readonly path: string
    private readonly dir: string
    constructor(dataDir: string) {
        this.dir = join(dataDir, 'sensing')
        this.path = join(this.dir, 'events.jsonl')
    }
    writeEvent(event: SensingEvent): void {
        const { hint: _hint, dedupeWindowMs: _window, ...rest } = event
        appendJsonl(this.path, this.dir, rest)
    }
}

/** Default ThoughtSink: `<dataDir>/sensing/thoughts.jsonl`. */
export class JsonlThoughtSink implements ThoughtSink {
    readonly path: string
    private readonly dir: string
    constructor(dataDir: string) {
        this.dir = join(dataDir, 'sensing')
        this.path = join(this.dir, 'thoughts.jsonl')
    }
    writeThought(thought: SensingThought): void {
        appendJsonl(this.path, this.dir, thought)
    }
}

/** Small logger that never prints more than ids and counts (no mail text, no secrets). */
export function sensingLog(message: string): void {
    console.log(`[Sensing] ${cleanText(message, 200)}`)
}
