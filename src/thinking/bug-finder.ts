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
 * Fingerabdruck = `observationFingerprint` aus Stufe 1: Zahlen, Zeiten und
 * IDs sind Messung, kein neuer Fehler. Keine Doppelfälle: gleicher
 * Fingerabdruck oder gleiche Fall-ID in der Warteschlange = übersprungen.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DoctorFinding } from '../core/self-doctor.js'
import { observationFingerprint, type FailureResearchCoordinator } from '../doctor/failure-research-coordinator.js'
import { redactSecrets } from '../security/secret-redaction.js'
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
}

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
        id: '', title: `Wiederkehrender Fehler: ${subject}`,
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

/** Standard-Quelle: fehlgeschlagene Werkzeugaufrufe aus den Trace-Dateien (ohne Nachrichtentexte). */
export function tracesErrorSource(dir = join(process.cwd(), '.nova-data', 'traces')): ErrorSourcePort {
    return {
        collect(sinceMs) {
            const out: ErrorOccurrence[] = []
            if (!existsSync(dir)) return out
            const files = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-14)
            for (const file of files) {
                let lineNo = 0
                for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
                    lineNo++
                    if (!line.trim()) continue
                    try {
                        const trace = JSON.parse(line)
                        const at = Number(trace.timestamp)
                        if (!(at >= sinceMs)) continue
                        for (const call of Array.isArray(trace.toolCalls) ? trace.toolCalls : []) {
                            if (call?.success !== false) continue
                            out.push({ source: 'trace', subject: String(call.name || 'unbekannt'), message: String(call.errorMessage || trace.errorType || 'Fehler ohne Meldung'), at, ref: `traces/${file}:${lineNo}` })
                        }
                        if (out.length > 20_000) return out
                    } catch { /* kaputte Zeile */ }
                }
            }
            return out
        },
    }
}

export interface BugFinderDeps {
    settings: ThinkingSettings
    source: ErrorSourcePort
    doctor: Pick<FailureResearchCoordinator, 'list' | 'ingest'> & Partial<Pick<FailureResearchCoordinator, 'addEvidenceRefs'>>
    sink: ThoughtSink
    now?: Date
    importanceFactor?: (kind: string) => number
}

export async function runBugFinder(deps: BugFinderDeps): Promise<{ ran: boolean; created: string[]; skipped: Array<{ fingerprint: string; reason: string }> }> {
    const cfg = deps.settings.bugFinder
    if (!deps.settings.enabled || !cfg.enabled) return { ran: false, created: [], skipped: [] }
    const now = deps.now || new Date()
    const since = now.getTime() - cfg.windowDays * 24 * 60 * 60_000
    const occurrences = (await deps.source.collect(since)).filter(item => item.at >= since && item.at <= now.getTime() + 60_000)
    const groups = groupRecurring(occurrences, cfg.minOccurrences, cfg.windowDays)
    const created: string[] = []
    const skipped: Array<{ fingerprint: string; reason: string }> = []
    for (const group of groups) {
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
    return { ran: true, created, skipped }
}
