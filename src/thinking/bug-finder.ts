/**
 * Phase 3 — Bug-Finder.
 *
 * Wiederkehrende Fehler (gleicher Fingerabdruck ≥ N-mal im Fenster, mit
 * Belegen) werden ein Doctor-Fall in der vorhandenen Warteschlange
 * (`FailureResearchCoordinator.ingest`). Von dort läuft alles über die
 * vorhandenen Wege: Doctor-Untersuchung (nur lesend) → bei `verified` die
 * Claude-Übergabe (`claude-handoff.ts`) → nach einem Rollout die vorhandene
 * Nachkontrolle (`reconcileAfterRollout`). Dieses Modul schreibt keinen Code,
 * sendet nichts und übergibt nichts selbst.
 *
 * 2.83.0 Punkt 1: Nachkontrolle mit Messung. Einen offenen eigenen Fall
 * schließt der Bug-Finder (`closeByMeasurement`), wenn im Fenster 0 Vorkommen
 * seines Fingerabdrucks und mindestens `minOccurrences` erfolgreiche Aufrufe
 * desselben Werkzeugs aus derselben Quelle gezählt wurden. Nicht genutzt heißt
 * nicht geheilt; „geschlossen“ heißt „nicht mehr beobachtet“, nie „repariert“.
 *
 * Fingerabdruck = `observationFingerprint` aus Stufe 1: Zahlen, Zeiten und
 * IDs sind Messung, kein neuer Fehler. Keine Doppelfälle: gleicher
 * Fingerabdruck oder gleiche Fall-ID in der Warteschlange = übersprungen.
 *
 * 2.86 Punkt 2: ein Bedarf, ein Empfänger. Vor dem Anlegen fragt der
 * Bug-Finder die eine Einordnung (`classifyNeed`, install/software-demand.ts):
 * fehlt eine Fähigkeit (Software-Scout), eine Verbindung (Verbindungen) oder
 * ein Werkzeug (Schmiede), ist das kein Code-Fehler und kein Doctor-Fall —
 * übersprungen mit Grund. Nur `code:*` wird ein Fall.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DoctorFinding } from '../core/self-doctor.js'
import { observationFingerprint, type FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { NeedClassification } from '../install/software-demand.js'
import { newThoughtId, type ThoughtSink, type ThinkingSettings } from './ports.js'

export interface ErrorOccurrence {
    source: string
    /** Werkzeug oder Bereich, z. B. "web_search". */
    subject: string
    message: string
    at: number
    /** Beleg-Verweis (Datei/Zeile, Trace-ID), keine Inhalte. */
    ref: string
}

export interface ErrorSourcePort {
    collect(sinceMs: number): Promise<ErrorOccurrence[]> | ErrorOccurrence[]
    /** Erfolgreiche Aufrufe je Subjekt seit `sinceMs` (dieselbe Quelle). Ohne: kein Schließen. */
    successes?(sinceMs: number): Promise<Record<string, number>> | Record<string, number>
}

const CASE_TITLE_PREFIX = 'Wiederkehrender Fehler: '

export interface RecurringGroup {
    fingerprint: string
    subject: string
    source: string
    count: number
    firstAt: number
    lastAt: number
    refs: string[]
    /** Zeitpunkte aller Vorkommen (für „nach dem Schließen wieder aufgetreten"). */
    times: number[]
    sample: string
    finding: DoctorFinding
}

const clean = (value: unknown, max: number) => redactSecrets(String(value ?? '')).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
/** Wie der Stufe-1-Fingerabdruck: Messwerte und IDs raus, das Fehlerbild bleibt. */
const shape = (value: string) => value.replace(/[0-9a-f]{12,}/gi, '<id>').replace(/\d+(?:[.,:]\d+)*/g, '<n>')

function findingFor(subject: string, source: string, sample: string, count: number, windowDays: number, at: string): DoctorFinding {
    return {
        id: '', title: `${CASE_TITLE_PREFIX}${subject}`,
        detail: `${count} Vorkommen in ${windowDays} Tagen. Fehlerbild: ${sample}`,
        category: 'tools', severity: 'warning', source: 'bug-finder', status: 'open',
        recommendation: 'Mit nur lesenden Diagnose-Werkzeugen Ursache belegen. Code-Änderungen nur über Claude-Übergabe, Sandbox, Regression und PATCH_GATE.',
        evidence: { subject, origin: source, count }, createdAt: at, updatedAt: at,
    }
}

/** Gruppiert nach Stufe-1-Fingerabdruck; liefert nur Gruppen mit ≥ min Vorkommen. */
export function groupRecurring(occurrences: readonly ErrorOccurrence[], minOccurrences: number, windowDays = 7): RecurringGroup[] {
    const groups = new Map<string, { items: ErrorOccurrence[]; subject: string; source: string; sample: string }>()
    for (const item of occurrences) {
        const subject = clean(item.subject, 80) || 'unbekannt'
        const sample = shape(clean(item.message, 300)) || 'ohne Meldung'
        // Fingerabdruck über die Form des späteren Befunds — dieselbe Funktion wie der Doctor.
        const fingerprint = observationFingerprint(findingFor(subject, item.source, sample, 0, windowDays, ''))
        const group = groups.get(fingerprint) || { items: [], subject, source: item.source, sample }
        group.items.push(item)
        groups.set(fingerprint, group)
    }
    const out: RecurringGroup[] = []
    for (const [fingerprint, group] of groups) {
        if (group.items.length < minOccurrences) continue
        const times = group.items.map(item => item.at).sort((a, b) => a - b)
        const at = new Date(times[times.length - 1]).toISOString()
        const finding = findingFor(group.subject, group.source, group.sample, group.items.length, windowDays, at)
        finding.id = `bug-finder-${fingerprint.slice(0, 24)}`
        out.push({
            fingerprint, subject: group.subject, source: group.source, count: group.items.length, firstAt: times[0], lastAt: times[times.length - 1],
            refs: group.items.slice(-10).map(item => clean(item.ref, 120)), times, sample: group.sample, finding,
        })
    }
    return out.sort((a, b) => b.count - a.count)
}

/** Standard-Quelle: Werkzeugaufrufe aus den Trace-Dateien (ohne Nachrichtentexte). */
export function tracesErrorSource(dir = join(process.cwd(), '.nova-data', 'traces')): ErrorSourcePort {
    const each = (sinceMs: number, visit: (trace: any, call: any, ref: string) => boolean | void) => {
        if (!existsSync(dir)) return
        const files = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-14)
        for (const file of files) {
            let lineNo = 0
            for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
                lineNo++
                if (!line.trim()) continue
                try {
                    const trace = JSON.parse(line)
                    if (!(Number(trace.timestamp) >= sinceMs)) continue
                    for (const call of Array.isArray(trace.toolCalls) ? trace.toolCalls : []) {
                        if (visit(trace, call, `traces/${file}:${lineNo}`) === false) return
                    }
                } catch { /* kaputte Zeile */ }
            }
        }
    }
    return {
        collect(sinceMs) {
            const out: ErrorOccurrence[] = []
            each(sinceMs, (trace, call, ref) => {
                if (call?.success !== false) return
                out.push({ source: 'trace', subject: String(call.name || 'unbekannt'), message: String(call.errorMessage || trace.errorType || 'Fehler ohne Meldung'), at: Number(trace.timestamp), ref })
                return out.length <= 20_000
            })
            return out
        },
        successes(sinceMs) {
            const out: Record<string, number> = {}
            each(sinceMs, (_trace, call) => {
                if (call?.success !== true) return
                const name = String(call.name || 'unbekannt')
                out[name] = (out[name] || 0) + 1
            })
            return out
        },
    }
}

export interface BugFinderDeps {
    settings: ThinkingSettings
    source: ErrorSourcePort
    doctor: Pick<FailureResearchCoordinator, 'list' | 'ingest'> & Partial<Pick<FailureResearchCoordinator, 'addEvidenceRefs' | 'closeByMeasurement'>>
    sink: ThoughtSink
    now?: Date
    importanceFactor?: (kind: string) => number
    /** 2.84.0 Punkt 3: rollout time of a handed-over case (`rolloutMeasureSince`). Without: 7-day window. */
    measureSince?: (caseId: string) => number | undefined
    /** 2.86 Punkt 2: the one need classification. Default: `createNeedClassifier()` (scout view of the mesh). */
    classifyNeed?: (subject: string, message: string) => NeedClassification
}

/** 2.84.0 Punkt 3: a rollout is measured at least this long before a case closes. */
export const MIN_MEASURE_AFTER_ROLLOUT_MS = 24 * 60 * 60_000

export async function runBugFinder(deps: BugFinderDeps): Promise<{ ran: boolean; created: string[]; closed: string[]; skipped: Array<{ fingerprint: string; reason: string }> }> {
    const cfg = deps.settings.bugFinder
    if (!deps.settings.enabled || !cfg.enabled) return { ran: false, created: [], closed: [], skipped: [] }
    const now = deps.now || new Date()
    const since = now.getTime() - cfg.windowDays * 24 * 60 * 60_000
    const occurrences = (await deps.source.collect(since)).filter(item => item.at >= since && item.at <= now.getTime() + 60_000)
    const groups = groupRecurring(occurrences, cfg.minOccurrences, cfg.windowDays)
    const closed = await closeHealedCases(deps, occurrences, since, now)
    const created: string[] = []
    const skipped: Array<{ fingerprint: string; reason: string }> = []
    let classify = deps.classifyNeed
    if (!classify && groups.length) {
        try { classify = (await import('../install/software-demand.js')).createNeedClassifier({ now: now.getTime() }) } catch { classify = undefined }
    }
    for (const group of groups) {
        // 2.86 Punkt 2: a missing capability/connection/tool belongs to its one recipient, not to the Doctor.
        let need: NeedClassification | undefined
        try { need = classify?.(group.subject, group.sample) } catch { need = undefined }
        if (need && need.kind !== 'code') { skipped.push({ fingerprint: group.fingerprint, reason: `${need.reason}, kein Code-Fehler` }); continue }
        const existing = deps.doctor.list().find(item => item.findingId === group.finding.id || item.observationHash === group.fingerprint)
        if (existing) {
            // Geschlossen und danach wieder ≥ N-mal aufgetreten: derselbe Fall geht
            // wieder auf (ingest setzt ihn zurück), es entsteht kein zweiter.
            const closedAt = Date.parse(existing.updatedAt)
            const freshAfterClose = existing.findingOpen === false ? group.times.filter(at => at > closedAt).length : 0
            if (!(existing.findingOpen === false && freshAfterClose >= cfg.minOccurrences)) {
                skipped.push({ fingerprint: group.fingerprint, reason: `Fall ${existing.id} gibt es schon` })
                continue
            }
        }
        // Der Self-Doctor (L15) führt schon einen offenen Fall für dieses Werkzeug: kein zweiter Fall.
        const sameTool = deps.doctor.list().find(item => item.findingOpen !== false && item.title.startsWith(`Tool ${group.subject} is `))
        if (sameTool) { skipped.push({ fingerprint: group.fingerprint, reason: `Self-Doctor-Fall ${sameTool.id} deckt ${group.subject} schon ab` }); continue }
        if (created.length >= cfg.maxNewCasesPerRun) { skipped.push({ fingerprint: group.fingerprint, reason: 'Obergrenze pro Lauf' }); continue }
        const item = deps.doctor.ingest({ ...group.finding, evidence: { ...group.finding.evidence, refs: group.refs } })
        deps.doctor.addEvidenceRefs?.(item.id, group.refs)
        created.push(item.id)
        const factor = deps.importanceFactor ? deps.importanceFactor('bug-finder') : 1
        await deps.sink.emit({
            id: newThoughtId('bug-finder', now), createdAt: now.toISOString(), source: 'bug-finder', kind: 'bug-finder',
            title: `Fehler in mir gefunden: ${group.subject}`,
            text: `${group.count}× gleiches Fehlerbild in ${cfg.windowDays} Tagen („${group.sample.slice(0, 160)}"). Doctor-Fall ${item.id} angelegt; nach verifizierter Diagnose geht er an Claude, nach dem Rollout prüfe ich nach.`,
            evidence: [
                { metric: 'Vorkommen', value: group.count, source: `${group.source}, ${cfg.windowDays} Tage` },
                { metric: 'Belege', value: group.refs.slice(0, 3).join(', '), source: group.source },
            ],
            importance: Math.min(1, 0.4 + group.count / 50) * factor, stufe: 'selbst', status: 'info', dedupeKey: `bug-finder:${group.fingerprint}`,
        })
    }
    return { ran: true, created, closed, skipped }
}

/**
 * Punkt 1: eigene offene Fälle schließen, deren Fehlerbild im Fenster nicht
 * mehr vorkam und deren Werkzeug in derselben Zeit oft genug erfolgreich lief.
 */
async function closeHealedCases(deps: BugFinderDeps, occurrences: readonly ErrorOccurrence[], since: number, now: Date): Promise<string[]> {
    const cfg = deps.settings.bugFinder
    if (!deps.doctor.closeByMeasurement || !deps.source.successes) return []
    const open = deps.doctor.list().filter(item => item.findingId.startsWith('bug-finder-') && item.findingOpen !== false && item.title.startsWith(CASE_TITLE_PREFIX))
    if (!open.length) return []
    // 2.84.0 Punkt 3: a handed-over case is measured from its rollout (at
    // least 24 h), not 7 days after its last fault. Cached per start time.
    const seenFrom = new Map<number, Set<string>>()
    const okFrom = new Map<number, Record<string, number> | null>()
    const seen = (from: number) => seenFrom.get(from) || seenFrom.set(from,
        new Set(groupRecurring(occurrences.filter(item => item.at >= from), 1, cfg.windowDays).map(group => group.fingerprint))).get(from)!
    const successes = async (from: number) => {
        if (!okFrom.has(from)) {
            try { okFrom.set(from, (await deps.source.successes!(from)) || {}) } catch { okFrom.set(from, null) }
        }
        return okFrom.get(from)
    }
    const closed: string[] = []
    for (const item of open) {
        let rollout: number | undefined
        try { rollout = deps.measureSince?.(item.id) } catch { rollout = undefined }
        const fromRollout = typeof rollout === 'number' && Number.isFinite(rollout)
        if (fromRollout && now.getTime() - rollout! < MIN_MEASURE_AFTER_ROLLOUT_MS) continue
        const from = fromRollout ? Math.max(since, rollout!) : since
        if (item.observationHash && seen(from).has(item.observationHash)) continue
        const counts = await successes(from)
        if (!counts) continue
        const subject = item.title.slice(CASE_TITLE_PREFIX.length)
        const ok = Number(counts[subject]) || 0
        if (ok < cfg.minOccurrences) continue
        const result = deps.doctor.closeByMeasurement(item.id, `messung:${subject}:0-fehler:${ok}-ok:${fromRollout ? 'seit-rollout' : `${cfg.windowDays}d`}`, now)
        if (result) closed.push(item.id)
    }
    return closed
}
