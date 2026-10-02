/**
 * Der eine Prozedur-Speicher (P9, 01.10.2026).
 *
 * Früher gab es drei Stellen, die aus verifizierten Werkzeug-Ergebnissen
 * „Gelerntes“ ableiteten: L17 (`.nova-learning/learned-solutions.json`),
 * L8 (`%USERPROFILE%/.nova/skills/*.json`, außerhalb von `.nova-data`) und
 * der Lern-Koordinator (`.nova-learning/verified-procedures.json`, nur
 * Zähler). Jetzt gibt es genau diesen Speicher:
 *
 *   <runtime>/.nova-data/learning/procedures.json
 *
 * Regeln (Code, nicht Config):
 * - Eine Prozedur entsteht nur aus einem verifizierten Werkzeug-Ergebnis, und
 *   erst wenn dieselbe Form (Benutzer, Werkzeug, Parameter-Namen) zweimal
 *   verifiziert gelang. Ein Fehlschlag setzt die Zählung zurück.
 * - Der Abruf ist pro Benutzer; nie werden Prozeduren eines anderen Benutzers
 *   oder unbenutzerte Altdaten geliefert.
 * - Übernommene Altdaten ohne Beleg (L8-Code, alte L17-Einträge, die die
 *   Prüfung nicht bestehen) bleiben sichtbar, werden aber nie abgerufen.
 * - Alte Dateien werden beim Start einmal übernommen und als `*.migriert`
 *   umbenannt, nie gelöscht.
 * - 2.83.0 (lernen aus Misserfolg, wie die Routine-Skills): Eine Prozedur
 *   kennt die Läufe, aus denen sie gelernt wurde. Weist der Validator oder
 *   der Owner einen solchen Lauf zurück, verliert sie den Beleg; ohne Beleg
 *   wird sie nicht mehr abgerufen. Jeder Lauf mit abgerufener Prozedur meldet
 *   das Validator-Ergebnis zurück; nach zwei Fehlschlägen in Folge ist sie
 *   ausgesetzt (bleibt sichtbar, wird nicht mehr abgerufen).
 * - 2.84 (Punkt 9): Ein neuer Beleg — zwei frische verifizierte Erfolge
 *   derselben Form nach der Aussetzung — hebt sie wieder auf (Gedanke
 *   „Prozedur wieder aktiv“). Der Owner schaltet mit /prozeduren an|aus;
 *   „an“ hebt nur die Aussetzung auf (ohne Beleg bleibt sie aus), „aus“
 *   wirkt stärker als jeder Beleg und hebt nur der Owner wieder auf.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir, getNovaLearningDir } from '../core/data-root.js'
import { toolProvidesActionEvidence } from '../core/action-intent.js'
import { isSuccessfulToolResult } from '../tools/tool-result-quality.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { sideEffectsDisabled } from '../core/side-effects.js'

export type ProcedureSource = 'verifiziert' | 'migriert-l17' | 'migriert-l8'

export interface Procedure {
    userId?: string
    problem: string
    solution: string
    code?: string
    toolName?: string
    learnedAt: number
    successCount: number
    source: ProcedureSource
    /** Nur verifizierte Prozeduren werden je abgerufen. */
    verified: boolean
    /** 2.83.0: Läufe, aus denen sie gelernt wurde (höchstens 10). Altbestand hat keine. */
    runIds?: string[]
    /** 2.83.0: Läufe mit abgerufener Prozedur, die der Validator angenommen hat (höchstens 10). */
    usedRunIds?: string[]
    /** 2.83.0: Abrufe mit Validator-Ergebnis, davon Fehlschläge, Fehlschläge in Folge. */
    uses?: number
    failures?: number
    consecutiveFailures?: number
    /** Zeichen der Form (Benutzer, Werkzeug, Parameter-Namen), damit eine Rücknahme die Zählung zurücksetzt. */
    signature?: string
    /** Gesetzt, wenn der letzte Beleg zurückgenommen wurde. */
    retractedAt?: number
    /** 2.84: vom Owner abgeschaltet (/prozeduren aus) — stärker als jeder Beleg. */
    disabledByOwner?: boolean
    disabledByOwnerAt?: number
}

/** 2.84: Ereignis für den Gedanken-Speicher (Abendbericht). */
export interface ProcedureEvent {
    kind: 'wieder-aktiv'
    procedure: Procedure
    detail: string
}

export interface ProcedureStoreOptions {
    /** Standard: Gedanke im Planer (ohne Seiteneffekte in Tests). */
    notify?: (event: ProcedureEvent) => void
}

export interface VerifiedProcedureOutcome {
    userId?: string
    /** Lauf (Outcome-Ledger), in dem das Ergebnis entstand. */
    runId?: string
    toolName: string
    request: string
    params: Record<string, unknown>
    result: unknown
    success: boolean
    verified: true
}

interface ProcedureFile {
    version: 1
    updatedAt: string
    signatures: Array<[string, number]>
    procedures: Procedure[]
}

const MAX_PROCEDURES = 1_000
const MAX_SIGNATURES = 2_000
const MAX_RUN_IDS = 10
/** Wie die Routine-Skills: zwei Fehlschläge in Folge setzen eine Prozedur aus. */
export const SUSPEND_AFTER_FAILURES = 2
const META_ONLY = /^Tool\s+(nova_capabilities|find_capability|resolve_capability|load_skill_pack|build_skill|create_skill):/i
const STOP_WORDS = new Set([
    'aber', 'also', 'bitte', 'das', 'dann', 'der', 'die', 'ein', 'eine',
    'es', 'ich', 'ist', 'ja', 'kannst', 'mach', 'mal', 'mir', 'nein',
    'noch', 'sie', 'so', 'und', 'warum', 'was', 'wie', 'wieso', 'du',
])

export function defaultProcedurePath(): string {
    return getNovaDataDir('learning', 'procedures.json')
}

/** Kurze oder allgemeine Nachfragen („warum?“, „ja“) sind nie ein Lernschlüssel. */
export function isLearnableProblem(problem: string): boolean {
    const text = String(problem || '').trim()
    if (text.length < 12 || /^\d+$/.test(text)) return false
    const meaningful = text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || []
    return meaningful.length >= 3
}

function tokenize(value: string): string[] {
    return value.toLowerCase()
        .replace(/[^\p{L}\p{N}:/._-]+/gu, ' ')
        .split(/\s+/)
        .filter(token => token.length >= 3 && !STOP_WORDS.has(token))
}

function suspended(entry: Procedure): boolean {
    return (entry.consecutiveFailures || 0) >= SUSPEND_AFTER_FAILURES
}

function usable(entry: Procedure): boolean {
    return entry.verified === true && !suspended(entry) && entry.disabledByOwner !== true && isLearnableProblem(entry.problem) && !META_ONLY.test(entry.solution) && isSuccessfulToolResult(entry.solution)
}

const addRun = (list: string[] | undefined, runId: string) => [...(list || []).filter(item => item !== runId), runId].slice(-MAX_RUN_IDS)

/** Gedanke „Prozedur wieder aktiv (neuer Beleg)“ — erledigt, nur Abendbericht. */
function defaultNotify(event: ProcedureEvent): void {
    if (sideEffectsDisabled()) return
    void import('../planner/index.js').then(({ addThought, setThoughtStatus }) => {
        const { thought } = addThought({
            source: 'prozeduren', kind: 'ereignis', permission: 'selbst',
            title: `Prozedur wieder aktiv (neuer Beleg): ${event.procedure.problem.slice(0, 80)}`,
            evidence: event.detail,
        })
        setThoughtStatus(thought.id, 'erledigt', 'selbst')
    }).catch(() => { /* Gedanken sind optional */ })
}

export class ProcedureStore {
    private signatures = new Map<string, number>()
    private procedures: Procedure[] = []
    private readonly notify: (event: ProcedureEvent) => void

    constructor(readonly path: string = defaultProcedurePath(), options: ProcedureStoreOptions = {}) {
        this.notify = options.notify ?? defaultNotify
        this.load()
    }

    /**
     * Ein Fehlschlag mit abgerufener Prozedur. Wird sie dadurch ausgesetzt,
     * beginnt die Zählung ihrer Form neu: Zurück kommt sie nur mit zwei
     * frischen verifizierten Erfolgen (neuer Beleg) oder per Owner.
     */
    private countFailure(entry: Procedure): void {
        entry.failures = (entry.failures || 0) + 1
        entry.consecutiveFailures = (entry.consecutiveFailures || 0) + 1
        if (entry.consecutiveFailures === SUSPEND_AFTER_FAILURES) {
            console.log(`[Prozeduren] ausgesetzt nach ${SUSPEND_AFTER_FAILURES} Fehlschlägen in Folge: ${entry.problem.slice(0, 60)}`)
            if (entry.signature && this.signatures.has(entry.signature)) this.signatures.set(entry.signature, 0)
        }
    }

    private load(): void {
        if (!existsSync(this.path)) return
        try {
            const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ProcedureFile>
            this.signatures = new Map((raw.signatures || []).filter(([key, runs]) => typeof key === 'string' && Number.isFinite(runs) && runs >= 0))
            this.procedures = Array.isArray(raw.procedures) ? raw.procedures.filter(item => item && typeof item.problem === 'string' && typeof item.solution === 'string') : []
        } catch (error) {
            // Never overwrite unreadable learning data with an empty list.
            console.error('[Prozeduren] Datei unlesbar - wird gesichert statt überschrieben:', error)
            try { renameSync(this.path, `${this.path}.kaputt-${Date.now()}`) } catch { /* best effort */ }
        }
    }

    private persist(): void {
        atomicWriteJsonSync(this.path, {
            version: 1,
            updatedAt: new Date().toISOString(),
            signatures: [...this.signatures.entries()].slice(-MAX_SIGNATURES),
            procedures: this.procedures.slice(-MAX_PROCEDURES),
        } satisfies ProcedureFile)
    }

    /**
     * Ein verifiziertes Werkzeug-Ergebnis zählen. Beim zweiten verifizierten
     * Erfolg derselben Form wird die Lösung als Prozedur gemerkt.
     */
    recordVerifiedOutcome(outcome: VerifiedProcedureOutcome): { runs: number; remembered: boolean } {
        if (outcome?.verified !== true || !outcome.toolName) return { runs: 0, remembered: false }
        const signature = JSON.stringify([outcome.userId ?? null, outcome.toolName, Object.keys(outcome.params || {}).sort()])
        const runs = outcome.success ? (this.signatures.get(signature) || 0) + 1 : 0
        this.signatures.delete(signature)
        this.signatures.set(signature, runs)
        let remembered = false
        if (outcome.success && runs >= 2) {
            const summary = typeof outcome.result === 'string' ? outcome.result.slice(0, 500) : JSON.stringify(outcome.result ?? null).slice(0, 500)
            remembered = this.remember(outcome.request, `Tool ${outcome.toolName}: ${summary}`, { toolName: outcome.toolName, result: outcome.result }, outcome.userId, false, outcome.runId, signature)
        }
        this.persist()
        return { runs, remembered }
    }

    /** Eine verifizierte Lösung merken (nur mit erfüllendem Werkzeug-Beleg). */
    remember(problem: string, solution: string, evidence: { toolName: string; result: unknown }, userId?: string, persist = true, runId?: string, signature?: string): boolean {
        if (!isLearnableProblem(problem)) return false
        if (!evidence?.toolName || !toolProvidesActionEvidence(evidence.toolName) || !isSuccessfulToolResult(evidence.result)) return false
        const cleanSolution = redactSecrets(String(solution)).slice(0, 600)
        const existing = this.procedures.find(item => item.userId === userId && item.problem.toLowerCase() === problem.toLowerCase())
        if (existing) {
            // 2.84: frischer Beleg (zweimal verifiziert über recordVerifiedOutcome) hebt die Aussetzung auf.
            const revived = signature !== undefined && existing.verified === true && suspended(existing)
            existing.successCount++
            existing.solution = cleanSolution
            existing.toolName = evidence.toolName
            existing.verified = true
            existing.source = 'verifiziert'
            delete existing.retractedAt
            if (runId) existing.runIds = addRun(existing.runIds, runId)
            if (signature) existing.signature = signature
            if (revived) {
                existing.consecutiveFailures = 0
                this.notify({ kind: 'wieder-aktiv', procedure: { ...existing }, detail: `neuer Beleg: Lauf ${runId || 'ohne ID'} (zweimal verifiziert)${existing.disabledByOwner ? '; bleibt aus, bis der Owner sie einschaltet' : ''}` })
            }
        } else {
            this.procedures.push({
                userId, problem: redactSecrets(problem).slice(0, 300), solution: cleanSolution, toolName: evidence.toolName,
                learnedAt: Date.now(), successCount: 1, source: 'verifiziert', verified: true,
                ...(runId ? { runIds: [runId] } : {}), ...(signature ? { signature } : {}),
            })
        }
        if (persist) this.persist()
        return true
    }

    /**
     * Ein Lauf wurde zurückgewiesen (Validator oder Owner): Prozeduren, die aus
     * ihm gelernt wurden, verlieren den Beleg — ohne Beleg nie mehr abgerufen,
     * die Zählung der Form beginnt neu. Hatte der Lauf eine Prozedur abgerufen
     * und galt als Erfolg, zählt das jetzt als Fehlschlag. true bei Änderung.
     */
    retractRun(runId: string): boolean {
        const id = String(runId || '').trim()
        if (!id) return false
        let changed = false
        for (const entry of this.procedures) {
            if (entry.runIds?.includes(id)) {
                entry.runIds = entry.runIds.filter(item => item !== id)
                if (entry.runIds.length === 0) {
                    entry.verified = false
                    entry.retractedAt = Date.now()
                    if (entry.signature && this.signatures.has(entry.signature)) this.signatures.set(entry.signature, 0)
                }
                changed = true
            }
            if (entry.usedRunIds?.includes(id)) {
                entry.usedRunIds = entry.usedRunIds.filter(item => item !== id)
                // Der Erfolg zählte schon als Abruf; jetzt wird er ein Fehlschlag.
                this.countFailure(entry)
                changed = true
            }
        }
        if (changed) this.persist()
        return changed
    }

    /**
     * Ergebnis eines Laufs, in dem diese Prozedur abgerufen wurde (Validator).
     * `problem` ist das der abgerufenen Prozedur. Nur derselbe Benutzer.
     */
    recordProcedureOutcome(problem: string, userId: string | undefined, success: boolean, runId?: string): Procedure | null {
        if (!userId) return null
        const key = String(problem || '').trim().toLowerCase()
        const entry = this.procedures.find(item => item.userId === userId && item.problem.trim().toLowerCase() === key)
        if (!entry) return null
        entry.uses = (entry.uses || 0) + 1
        if (success) {
            entry.consecutiveFailures = 0
            if (runId) entry.usedRunIds = addRun(entry.usedRunIds, runId)
        } else {
            this.countFailure(entry)
        }
        this.persist()
        return { ...entry }
    }

    /** Bekannte, verifizierte Lösung für eine ähnliche Aufgabe desselben Benutzers. */
    recall(problem: string, userId?: string): Procedure | null {
        if (!userId) return null
        const candidates = this.procedures.filter(entry => entry.userId === userId && usable(entry))
        const normalized = String(problem || '').trim().toLowerCase()
        if (!normalized) return null
        const exact = candidates.find(entry => entry.problem.trim().toLowerCase() === normalized)
        if (exact) return { ...exact }
        const words = tokenize(normalized)
        if (words.length < 3 || normalized.length < 20) return null
        let best: Procedure | null = null
        let bestScore = 0
        for (const entry of candidates) {
            const entryWords = tokenize(entry.problem)
            if (entryWords.length < 3) continue
            const matches = words.filter(word => entryWords.includes(word)).length
            const score = matches / Math.max(words.length, entryWords.length)
            if (matches >= 2 && score > bestScore && score >= 0.65) { best = entry; bestScore = score }
        }
        return best ? { ...best } : null
    }

    /** Prompt-Block (oder null) für den Agenten-Lauf. */
    promptBlock(problem: string, userId?: string): string | null {
        const known = this.recall(problem, userId)
        if (!known) return null
        return `## 🧠 Bekannte Lösung für ähnliche Aufgabe:\n${known.solution}\n\nNutze diese als Ausgangspunkt, passe sie aber an die aktuelle Anfrage an.`
    }

    list(userId?: string): Procedure[] {
        return this.procedures.filter(entry => userId === undefined || entry.userId === userId).map(entry => ({ ...entry }))
    }

    /**
     * 2.84 Owner-Schalter (/prozeduren an|aus <nr>; Nummer wie in der Liste
     * des Owners). „an“ hebt Aussetzung und Owner-Aus auf, setzt aber nie
     * `verified`: ohne Beleg bleibt eine zurückgenommene Prozedur aus.
     */
    setOwnerSwitch(userId: string, index: number, on: boolean): { procedure: Procedure; recallable: boolean } | null {
        const mine = this.procedures.filter(entry => entry.userId === userId)
        const entry = Number.isInteger(index) && index >= 1 ? mine[index - 1] : undefined
        if (!entry) return null
        if (on) {
            entry.consecutiveFailures = 0
            delete entry.disabledByOwner
            delete entry.disabledByOwnerAt
        } else {
            entry.disabledByOwner = true
            entry.disabledByOwnerAt = Date.now()
        }
        this.persist()
        return { procedure: { ...entry }, recallable: usable(entry) }
    }

    getStats(): { procedures: number; verifiedProcedures: number; reusableProcedures: number; legacy: number; suspended: number; retracted: number } {
        const isSuspended = (entry: Procedure) => entry.verified === true && (suspended(entry) || entry.disabledByOwner === true)
        const isRetracted = (entry: Procedure) => entry.verified !== true && entry.retractedAt !== undefined
        return {
            procedures: this.procedures.filter(usable).length,
            verifiedProcedures: this.signatures.size,
            reusableProcedures: [...this.signatures.values()].filter(runs => runs >= 2).length,
            legacy: this.procedures.filter(entry => !usable(entry) && !isSuspended(entry) && !isRetracted(entry)).length,
            suspended: this.procedures.filter(isSuspended).length,
            retracted: this.procedures.filter(isRetracted).length,
        }
    }

    /** Nur für die Übernahme alter Dateien. */
    importLegacy(entries: Procedure[], signatures: Array<[string, number]>): void {
        for (const entry of entries) {
            if (this.procedures.some(item => item.userId === entry.userId && item.problem === entry.problem && item.source === entry.source)) continue
            this.procedures.push(entry)
        }
        for (const [key, runs] of signatures) {
            if (!this.signatures.has(key)) this.signatures.set(key, runs)
        }
        this.persist()
    }
}

// ---------------------------------------------------------------------------
// Übernahme der alten Dateien (einmal, beim Start)
// ---------------------------------------------------------------------------

export function defaultL8SkillsDir(): string {
    return join(process.env.USERPROFILE || process.env.HOME || '', '.nova', 'skills')
}

function readJson(path: string): unknown {
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function retire(path: string): void {
    try { renameSync(path, `${path}.migriert`) } catch (error) { console.warn(`[Prozeduren] ${path} konnte nicht umbenannt werden: ${String(error).slice(0, 120)}`) }
}

export function migrateLegacyProcedures(options: { store?: ProcedureStore; learningDir?: string; l8SkillsDir?: string } = {}): { l17: number; l8: number; signatures: number } {
    const store = options.store ?? getProcedureStore()
    const learningDir = options.learningDir ?? getNovaLearningDir()
    const l8Dir = options.l8SkillsDir ?? defaultL8SkillsDir()
    const imported: Procedure[] = []
    const result = { l17: 0, l8: 0, signatures: 0 }
    let signatures: Array<[string, number]> = []

    const l17File = join(learningDir, 'learned-solutions.json')
    if (existsSync(l17File)) {
        const raw = readJson(l17File)
        for (const entry of Array.isArray(raw) ? raw : []) {
            if (!entry || typeof entry.problem !== 'string' || typeof entry.solution !== 'string') continue
            const candidate: Procedure = {
                ...(typeof entry.userId === 'string' ? { userId: entry.userId } : {}),
                problem: entry.problem, solution: entry.solution,
                ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
                learnedAt: Number(entry.learnedAt) || Date.now(), successCount: Number(entry.successCount) || 1,
                source: 'migriert-l17', verified: true,
            }
            candidate.verified = usable(candidate)
            imported.push(candidate)
            result.l17++
        }
    }

    const coordinatorFile = join(learningDir, 'verified-procedures.json')
    if (existsSync(coordinatorFile)) {
        const raw = readJson(coordinatorFile) as { procedures?: Array<[string, number]> } | null
        signatures = (raw?.procedures || []).filter(([key, runs]) => typeof key === 'string' && Number.isFinite(runs) && runs >= 0)
        result.signatures = signatures.length
    }

    let l8IsDir = false
    try { l8IsDir = existsSync(l8Dir) && statSync(l8Dir).isDirectory() } catch { l8IsDir = false }
    if (l8IsDir) {
        for (const file of readdirSync(l8Dir).filter(name => name.endsWith('.json'))) {
            const entry = readJson(join(l8Dir, file)) as Record<string, unknown> | null
            if (!entry || typeof entry.capability !== 'string') continue
            imported.push({
                problem: String(entry.name || entry.capability), solution: `L8-Fähigkeit ${entry.capability}: ${String(entry.description || '')}`.slice(0, 500),
                ...(typeof entry.toolCode === 'string' ? { code: entry.toolCode.slice(0, 20_000) } : {}),
                learnedAt: Number(entry.learnedAt) || Date.now(), successCount: Number(entry.successCount) || 0,
                source: 'migriert-l8', verified: false,
            })
            result.l8++
        }
    }

    if (imported.length > 0 || signatures.length > 0) store.importLegacy(imported, signatures)
    if (existsSync(l17File)) retire(l17File)
    if (existsSync(coordinatorFile)) retire(coordinatorFile)
    if (l8IsDir) retire(l8Dir)
    if (result.l17 + result.l8 + result.signatures > 0) {
        console.log(`[Prozeduren] übernommen: ${result.l17} aus L17, ${result.l8} aus L8, ${result.signatures} Zähler`)
    }
    return result
}

// ---------------------------------------------------------------------------
// /prozeduren (Owner): Einblick und an/aus
// ---------------------------------------------------------------------------

export function procedureStatus(entry: Procedure): string {
    if (entry.disabledByOwner) return 'aus (Owner)'
    if (entry.verified !== true) return entry.retractedAt !== undefined ? 'ohne Beleg (zurückgenommen)' : 'ohne Beleg (Altbestand)'
    if (suspended(entry)) return `ausgesetzt (${entry.consecutiveFailures} Fehlschläge in Folge)`
    return usable(entry) ? 'aktiv' : 'nicht abrufbar'
}

export async function handleProzedurenCommand(args: string, ctx: { principalId: string; permission?: string }, store: ProcedureStore = getProcedureStore()): Promise<string> {
    if (ctx.permission !== 'owner') return '🔒 Prozeduren sieht und schaltet nur der Owner.'
    const [sub, nr] = String(args || '').trim().split(/\s+/).filter(Boolean)
    if (sub === 'an' || sub === 'aus') {
        const changed = store.setOwnerSwitch(ctx.principalId, Number.parseInt(nr || '', 10), sub === 'an')
        if (!changed) return `❌ Prozedur ${nr || '(keine Nummer)'} nicht gefunden. Liste: /prozeduren`
        const title = changed.procedure.problem.slice(0, 80)
        if (sub === 'aus') return `⏸️ Prozedur ${nr} ist aus (bleibt aus, bis du sie einschaltest): ${title}`
        return changed.recallable
            ? `▶️ Prozedur ${nr} ist wieder an: ${title}`
            : `⚠️ Prozedur ${nr}: Sperre aufgehoben, aber ${procedureStatus(changed.procedure)} — sie wird erst mit einem neuen verifizierten Beleg wieder genutzt.`
    }
    const mine = store.list(ctx.principalId)
    if (mine.length === 0) return '📚 Noch keine Prozeduren gelernt (entstehen aus zweimal verifizierten Werkzeug-Ergebnissen).'
    const lines = mine.slice(0, 30).map((entry, index) => {
        const uses = entry.uses || 0
        const ok = uses - (entry.failures || 0)
        return `${index + 1}. ${entry.problem.slice(0, 60)} · ${entry.toolName || '–'} · ${uses}× (${Math.max(0, ok)} ok) · ${procedureStatus(entry)}`
    })
    if (mine.length > 30) lines.push(`… und ${mine.length - 30} weitere`)
    return `📚 *Prozeduren* (${mine.length})\n${lines.join('\n')}\n\n/prozeduren an <nr> · /prozeduren aus <nr>`
}

let singleton: ProcedureStore | null = null
export function getProcedureStore(): ProcedureStore { return singleton ||= new ProcedureStore() }
export function setProcedureStore(store: ProcedureStore | null): void { singleton = store }
