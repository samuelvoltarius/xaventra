/**
 * Routine-Skills (P8, Owner-Wunsch 01.10.2026): wenn Alfred immer wieder
 * dasselbe will, legt Xaventra selbst einen Skill an und nutzt ihn danach
 * zuerst, statt jedes Mal neu zu planen.
 *
 * Feste Regeln (Code, nicht Config):
 * - Gelernt wird nur aus Owner-Anfragen im Direktgespräch: keine Gruppe,
 *   keine Fremden, keine System-/Autonomie-Nachrichten, nur validierte Läufe
 *   mit mindestens einem erfolgreichen Werkzeug.
 * - Wiederholung = gleiche Absicht: gleiche Aufgabenart (Kernel-Intent) UND
 *   ähnliche Werkzeugfolge mit festen Parametern (Jaccard >= 0,67); weicht die
 *   Folge ab, muss zusätzlich das Thema der Anfrage überlappen. Der Wortlaut
 *   allein zählt nie. Fenster Standard 7 Tage, Schwelle Standard 3 (Config
 *   `routineSkills.repeatThreshold` / `routineSkills.windowDays`).
 * - Ein Skill ist nur ein Plan-Hinweis im Prompt. Er führt nichts selbst aus
 *   und erlaubt nichts zusätzlich: jeder Schritt läuft wie bei der
 *   Einzelausführung durch Werkzeug-Autorisierung, Aktions-Policy und Karten.
 *   Physische und nach außen wirkende Schritte stehen ausdrücklich als
 *   „fragt weiter“ im Hinweis.
 * - Nie-Liste: enthält ein Lauf einen Nie-Liste-Schritt (L3: löschen, Secrets,
 *   SSH, Firewall …), wird er nicht einmal gezählt.
 * - Keine Secrets: Parameter mit Secret-Namen, Werte, die `redactSecrets`
 *   verändert, und lange Token-artige Werte werden nie gespeichert; die
 *   Beleg-Anfragen werden redigiert.
 * - Nach 2 Fehlschlägen in Folge wird ein Skill deaktiviert (Gedanke). Ein vom
 *   Owner abgeschalteter Skill wird nie automatisch wieder eingeschaltet.
 *
 * Dateien (versionsfähig, abschaltbar):
 *   <data>/skills/routine/<id>.json            ein Skill pro Datei (version, history)
 *   <data>/skills/routine-observations.json    gezählte Owner-Läufe (Fenster)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { evaluateAction, type ActionLevel } from '../core/action-policy.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { sideEffectsDisabled } from '../core/side-effects.js'

export type SkillParamValue = string | number | boolean
export type RoutineSkillOrigin = 'gelernt' | 'eingebaut'

export interface RoutineSkillStep {
    tool: string
    params: Record<string, SkillParamValue>
    level: ActionLevel
    /** true: braucht dieselbe Freigabe wie die Einzelausführung (Karte/Policy). */
    fragt: boolean
    hinweis: string
}

export interface RoutineSkillEvidence { runId: string; request: string; at: string }

export interface RoutineSkill {
    id: string
    version: number
    name: string
    /** Auslöser-Beschreibung (wann der Skill passt). */
    trigger: string
    intent: string
    keywords: string[]
    steps: RoutineSkillStep[]
    /** Zusätzliche feste Arbeitsanweisung (nur eingebaute Skills). */
    anleitung?: string[]
    /** Erfolgsprüfung. */
    check: string
    origin: RoutineSkillOrigin
    readOnly: boolean
    ownerId: string
    evidence: RoutineSkillEvidence[]
    enabled: boolean
    disabledReason?: string
    disabledBy?: 'automatik' | 'owner'
    disabledAt?: string
    uses: number
    successes: number
    failures: number
    consecutiveFailures: number
    createdAt: string
    updatedAt: string
    lastUsedAt?: string
    history: Array<{ version: number; steps: RoutineSkillStep[]; replacedAt: string }>
}

export interface RoutineObservation {
    runId: string
    ownerId: string
    request: string
    intent: string
    topic: string[]
    steps: Array<{ tool: string; params: Record<string, SkillParamValue> }>
    signature: string[]
    at: string
}

export interface ObserveInput {
    runId?: string
    principalId: string
    permission?: string
    isGroup?: boolean
    systemAuthored?: boolean
    request: string
    intentKind?: string
    steps: ReadonlyArray<{ toolName: string; params?: Record<string, unknown>; success?: boolean }>
    success: boolean
}

export type ObserveResult =
    | { counted: false; reason: string }
    | { counted: true; count: number; created?: RoutineSkill }

export interface RoutineSkillEvent { kind: 'neu' | 'deaktiviert'; skill: RoutineSkill; detail: string }

export interface RoutineSkillOptions {
    dir?: string
    now?: () => number
    repeatThreshold?: number
    windowDays?: number
    notify?: (event: RoutineSkillEvent) => void
}

// ---------------------------------------------------------------------------
// Normalisierung
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
    'mal', 'bitte', 'guck', 'gucke', 'gucken', 'kuck', 'schau', 'schaue', 'schauen', 'nachschauen', 'nachsehen', 'sieh', 'siehst',
    'zeig', 'zeige', 'zeigen', 'mir', 'mich', 'du', 'dir', 'kannst', 'koenntest', 'kann', 'ich', 'wir', 'bei', 'beim', 'im', 'in',
    'am', 'an', 'auf', 'den', 'dem', 'der', 'die', 'das', 'des', 'ein', 'eine', 'einen', 'einem', 'und', 'oder', 'wie', 'was',
    'ist', 'sind', 'es', 'sieht', 'siehts', 'aus', 'gerade', 'jetzt', 'heute', 'doch', 'noch', 'nach', 'von', 'vom', 'zum', 'zur',
    'fuer', 'mit', 'so', 'da', 'dort', 'hier', 'status', 'stand', 'lage', 'zustand', 'uebersicht', 'los', 'alles', 'gibts', 'gibt',
    'neues', 'check', 'checken', 'pruef', 'pruefe', 'pruefen', 'sag', 'sage', 'sagen', 'schnell', 'kurz', 'nochmal', 'wieder',
    'einmal', 'eben', 'halt', 'ja', 'nein', 'hey', 'hallo', 'xaventra', 'nova', 'please', 'the', 'look', 'at', 'show', 'me',
    'what', 'on', 'whats', 'hows', 'how', 'is', 'of', 'to', 'mein', 'meine', 'meinem', 'meinen', 'unser', 'unsere', 'dein',
])

const SYNONYMS: ReadonlyArray<[RegExp, string]> = [
    [/\bhome[\s_-]*assistant\b/g, ' homeassistant '],
    [/\bhass\b/g, ' homeassistant '],
    [/\bha\b/g, ' homeassistant '],
    [/\bsmart[\s_-]*home\b/g, ' smarthome '],
]

function foldUmlauts(text: string): string {
    return text.toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
}

function stem(token: string): string {
    if (token.length > 5 && token.endsWith('en')) return token.slice(0, -2)
    if (token.length > 4 && (token.endsWith('e') || token.endsWith('s') || token.endsWith('n'))) return token.slice(0, -1)
    return token
}

/** Themen-Wörter einer Anfrage (ohne Füllwörter, Synonyme vereinheitlicht). */
export function topicTokens(text: string): string[] {
    let value = foldUmlauts(redactSecrets(String(text || '')))
    for (const [pattern, replacement] of SYNONYMS) value = value.replace(pattern, replacement)
    const tokens = value.split(/[^a-z0-9]+/)
        .filter(token => token.length >= 2 && !STOP_WORDS.has(token) && !/^\d+$/.test(token))
        .map(stem)
    return [...new Set(tokens)].slice(0, 24)
}

const INJECTED_PARAMS = new Set(['userId', 'channel', 'authorizationUserId', 'requestText'])
const SECRET_PARAM_NAME = /token|secret|passw|passphrase|api.?key|credential|authorization|private.?key|cookie|session|bearer|auth/i
const TOKEN_LIKE_VALUE = /^[A-Za-z0-9+/=_.-]{32,}$/

/** Feste, ungefährliche Parameter: nur Skalare, nie Secret-Namen oder -Werte. */
export function cleanSkillParams(params: Record<string, unknown> | undefined): Record<string, SkillParamValue> {
    const out: Record<string, SkillParamValue> = {}
    for (const [key, raw] of Object.entries(params || {})) {
        if (INJECTED_PARAMS.has(key) || SECRET_PARAM_NAME.test(key) || !/^[A-Za-z0-9_.-]{1,60}$/.test(key)) continue
        if (typeof raw === 'number' && Number.isFinite(raw)) { out[key] = raw; continue }
        if (typeof raw === 'boolean') { out[key] = raw; continue }
        if (typeof raw !== 'string') continue
        const value = raw.trim()
        if (!value || value.length > 160 || TOKEN_LIKE_VALUE.test(value)) continue
        if (redactSecrets(value) !== value || redactSecrets(`${key}=${value}`) !== `${key}=${value}`) continue
        out[key] = value
        if (Object.keys(out).length >= 8) break
    }
    return out
}

function stepSignature(step: { tool: string; params: Record<string, SkillParamValue> }): string {
    const params = Object.keys(step.params).sort().map(key => `${key}=${String(step.params[key]).toLowerCase()}`)
    return `${step.tool}(${params.join(',')})`
}

function jaccard(a: readonly string[], b: readonly string[]): number {
    const left = new Set(a)
    const right = new Set(b)
    if (left.size === 0 && right.size === 0) return 1
    let shared = 0
    for (const item of left) if (right.has(item)) shared++
    return shared / (left.size + right.size - shared)
}

/** Gleiche Absicht: Aufgabenart + Werkzeugfolge, nicht nur Wortlaut. */
export function sameIntent(a: Pick<RoutineObservation, 'ownerId' | 'intent' | 'signature' | 'topic'>, b: Pick<RoutineObservation, 'ownerId' | 'intent' | 'signature' | 'topic'>): boolean {
    if (a.ownerId !== b.ownerId) return false
    if (a.intent !== b.intent) return false
    const toolSimilarity = jaccard(a.signature, b.signature)
    if (toolSimilarity < 0.67) return false
    if (toolSimilarity === 1) return true
    return jaccard(a.topic, b.topic) >= 0.25
}

// ---------------------------------------------------------------------------
// Schritt-Einstufung über die Aktions-Policy
// ---------------------------------------------------------------------------

const READ_TOOL = /(^|_)(get|list|status|read|search|find|show|scan|stats|info|query|lookup|outline|describe|inspect|health|capabilities|introspect|recall|weather|time|nodes)(_|$)/

export interface StepVerdict { level: ActionLevel; fragt: boolean; nie: boolean; hinweis: string }

/** Ein Skill darf nie mehr als seine Schritte einzeln: die Einstufung kommt
 * aus derselben Aktions-Policy, nicht vom Modell. */
export function classifySkillStep(toolName: string): StepVerdict {
    const kind = String(toolName || '').toLowerCase().replace(/_/g, '-').slice(0, 48)
    const verdict = evaluateAction({ kind, origin: 'owner' })
    if (verdict.level === 'L3') return { level: 'L3', fragt: true, nie: true, hinweis: `Nie-Liste (${verdict.reason})` }
    if (verdict.impact === 'physisch') return { level: 'L2', fragt: true, nie: false, hinweis: 'wirkt physisch → fragt weiter (Karte), der Skill erlaubt nichts zusätzlich' }
    if (verdict.impact === 'extern') return { level: 'L2', fragt: true, nie: false, hinweis: 'wirkt nach außen → fragt weiter (Karte), der Skill erlaubt nichts zusätzlich' }
    if (READ_TOOL.test(String(toolName || '').toLowerCase())) return { level: 'L0', fragt: false, nie: false, hinweis: 'lesend' }
    return { level: verdict.level, fragt: true, nie: false, hinweis: 'Freigabe wie bei der Einzelausführung, der Skill erlaubt nichts zusätzlich' }
}

// ---------------------------------------------------------------------------
// Eingebauter Home-Assistant-Skill (nicht gelernt)
// ---------------------------------------------------------------------------

export const HOME_ASSISTANT_SKILL_ID = 'builtin-home-assistant'
export const HOME_ASSISTANT_WRITE_TOOLS: readonly string[] = Object.freeze(['hass_turn_on', 'hass_turn_off', 'hass_toggle', 'hass_service'])

function homeAssistantDefinition(): Omit<RoutineSkill, 'enabled' | 'uses' | 'successes' | 'failures' | 'consecutiveFailures' | 'createdAt' | 'updatedAt' | 'history' | 'evidence'> {
    const step = (tool: string, params: Record<string, SkillParamValue>, hinweis: string): RoutineSkillStep => ({ tool, params, level: 'L0', fragt: false, hinweis })
    return {
        id: HOME_ASSISTANT_SKILL_ID,
        version: 1,
        name: 'Home Assistant ansehen',
        trigger: 'Alfred sagt „guck mal bei Home Assistant“, „wie schaut’s im HA aus“, „HA-Status“, „was ist los im Smart Home“ o. ä.',
        intent: 'homeassistant-lesen',
        keywords: topicTokens('homeassistant smarthome hausautomation'),
        steps: [
            step('hass_status', {}, 'lesend: ist HA erreichbar? (URL aus Config/Env)'),
            step('hass_list', {}, 'lesend: Übersicht aller Entitäten'),
        ],
        anleitung: [
            'Erreichen: URL nur aus HASS_URL oder xaventra.config.json → homeassistant.url, Token nur aus HASS_TOKEN oder homeassistant.token. Nie raten, nie ausgeben, nie nach dem Token fragen und es selbst einsetzen. Fehlt eins, sag genau, was fehlt.',
            '„Gucken“ heißt lesen: nur hass_status, hass_list und für Details hass_get. Nichts schalten.',
            'Auswerten: Anzahl Entitäten, nicht verfügbare (unavailable/unknown), Batterien unter 20 %, offene Türen/Fenster, eingeschaltete Lichter und Geräte, Klima-Abweichungen. Kurz auf Deutsch.',
            `Schalten (${HOME_ASSISTANT_WRITE_TOOLS.join(', ')}) gehört nicht zu diesem Skill: nur auf ausdrückliche Bitte und nur über die Freigabe-Karte.`,
        ],
        check: 'hass_status meldet connected: true, hass_list liefert Entitäten, und die Antwort nennt Anzahl, Nicht-Verfügbare und Auffälliges.',
        origin: 'eingebaut',
        readOnly: true,
        ownerId: '*',
    }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const SKILL_ID = /^(rs-[a-f0-9]{12}|builtin-[a-z0-9-]{2,40})$/
const MAX_OBSERVATIONS = 500
const DISABLE_AFTER_FAILURES = 2

function clip(value: unknown, limit: number): string {
    return redactSecrets(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, limit)
}

export class RoutineSkillStore {
    readonly dir: string
    readonly skillDir: string
    readonly observationFile: string
    readonly repeatThreshold: number
    readonly windowMs: number
    private readonly now: () => number
    private readonly notify?: (event: RoutineSkillEvent) => void

    constructor(options: RoutineSkillOptions = {}) {
        this.dir = options.dir ?? getNovaDataDir('skills')
        this.skillDir = join(this.dir, 'routine')
        this.observationFile = join(this.dir, 'routine-observations.json')
        this.now = options.now ?? Date.now
        const threshold = Number(options.repeatThreshold)
        this.repeatThreshold = Number.isInteger(threshold) && threshold >= 2 && threshold <= 20 ? threshold : 3
        const days = Number(options.windowDays)
        this.windowMs = (Number.isFinite(days) && days > 0 && days <= 90 ? days : 7) * 24 * 60 * 60_000
        this.notify = options.notify
    }

    private iso(): string { return new Date(this.now()).toISOString() }

    // --- Dateien ----------------------------------------------------------

    private readObservations(): RoutineObservation[] {
        try {
            const raw = JSON.parse(readFileSync(this.observationFile, 'utf8'))
            return Array.isArray(raw?.items) ? raw.items : []
        } catch { return [] }
    }

    private writeObservations(items: RoutineObservation[]): void {
        mkdirSync(this.dir, { recursive: true })
        const cutoff = this.now() - this.windowMs
        const kept = items.filter(item => Date.parse(item.at) >= cutoff).slice(-MAX_OBSERVATIONS)
        atomicWriteJsonSync(this.observationFile, { version: 1, updatedAt: this.iso(), items: kept })
    }

    private readSkillFile(id: string): RoutineSkill | null {
        if (!SKILL_ID.test(id)) return null
        try { return JSON.parse(readFileSync(join(this.skillDir, `${id}.json`), 'utf8')) as RoutineSkill } catch { return null }
    }

    private writeSkill(skill: RoutineSkill): void {
        if (!SKILL_ID.test(skill.id)) throw new Error('Ungültige Skill-ID')
        mkdirSync(this.skillDir, { recursive: true })
        if (skill.origin === 'eingebaut') {
            // Eingebaute Skills: nur der Zustand liegt auf der Platte, die
            // Definition kommt immer aus dem Code (kann nicht verändert werden).
            const { id, enabled, disabledReason, disabledBy, disabledAt, uses, successes, failures, consecutiveFailures, createdAt, updatedAt, lastUsedAt } = skill
            atomicWriteJsonSync(join(this.skillDir, `${id}.json`), { id, origin: 'eingebaut', enabled, disabledReason, disabledBy, disabledAt, uses, successes, failures, consecutiveFailures, createdAt, updatedAt, lastUsedAt })
            return
        }
        atomicWriteJsonSync(join(this.skillDir, `${skill.id}.json`), skill)
    }

    private builtin(): RoutineSkill {
        const state = this.readSkillFile(HOME_ASSISTANT_SKILL_ID) as Partial<RoutineSkill> | null
        const at = this.iso()
        return {
            ...homeAssistantDefinition(),
            evidence: [],
            history: [],
            enabled: state?.enabled !== false,
            disabledReason: state?.disabledReason,
            disabledBy: state?.disabledBy,
            disabledAt: state?.disabledAt,
            uses: Number(state?.uses) || 0,
            successes: Number(state?.successes) || 0,
            failures: Number(state?.failures) || 0,
            consecutiveFailures: Number(state?.consecutiveFailures) || 0,
            createdAt: state?.createdAt || at,
            updatedAt: state?.updatedAt || at,
            lastUsedAt: state?.lastUsedAt,
        }
    }

    list(): RoutineSkill[] {
        const learned: RoutineSkill[] = []
        if (existsSync(this.skillDir)) {
            for (const file of readdirSync(this.skillDir)) {
                if (!file.endsWith('.json')) continue
                const id = file.slice(0, -5)
                if (id === HOME_ASSISTANT_SKILL_ID) continue
                const skill = this.readSkillFile(id)
                if (skill && skill.origin === 'gelernt') learned.push(skill)
            }
        }
        return [this.builtin(), ...learned.sort((a, b) => a.createdAt.localeCompare(b.createdAt))]
    }

    get(id: string): RoutineSkill | null {
        if (id === HOME_ASSISTANT_SKILL_ID) return this.builtin()
        const skill = this.readSkillFile(id)
        return skill && skill.origin === 'gelernt' ? skill : null
    }

    // --- Lernen -----------------------------------------------------------

    /** Einen abgeschlossenen Lauf zählen; beim n-ten gleichen Mal Skill anlegen. */
    observe(input: ObserveInput): ObserveResult {
        if (input.permission !== 'owner') return { counted: false, reason: 'nur Owner-Anfragen werden gelernt' }
        if (input.isGroup) return { counted: false, reason: 'Gruppen werden nicht gelernt' }
        if (input.systemAuthored) return { counted: false, reason: 'System-Nachrichten werden nicht gelernt' }
        if (!input.success) return { counted: false, reason: 'nur validierte, erfolgreiche Läufe zählen' }
        const request = clip(input.request, 300)
        if (!request || request.startsWith('/')) return { counted: false, reason: 'keine Anfrage' }
        const steps: RoutineObservation['steps'] = []
        for (const step of input.steps || []) {
            if (step.success === false) continue
            const tool = String(step.toolName || '').trim()
            if (!/^[A-Za-z0-9_.-]{2,80}$/.test(tool)) continue
            if (classifySkillStep(tool).nie) return { counted: false, reason: `Nie-Liste-Werkzeug ${tool}` }
            const params = cleanSkillParams(step.params)
            const previous = steps.at(-1)
            if (previous && stepSignature(previous) === stepSignature({ tool, params })) continue
            steps.push({ tool, params })
        }
        if (steps.length === 0) return { counted: false, reason: 'keine erfolgreichen Werkzeuge' }
        const observation: RoutineObservation = {
            runId: clip(input.runId || `run-${this.now()}`, 80),
            ownerId: clip(input.principalId, 120),
            request,
            intent: clip(input.intentKind || 'unbekannt', 40),
            topic: topicTokens(request),
            steps: steps.slice(0, 12),
            signature: [...new Set(steps.slice(0, 12).map(stepSignature))],
            at: this.iso(),
        }
        const cutoff = this.now() - this.windowMs
        const all = this.readObservations().filter(item => Date.parse(item.at) >= cutoff)
        if (all.some(item => item.runId === observation.runId)) return { counted: false, reason: 'Lauf bereits gezählt' }
        all.push(observation)
        this.writeObservations(all)

        const cluster = all.filter(item => sameIntent(item, observation))
        const count = new Set(cluster.map(item => item.runId)).size
        if (count < this.repeatThreshold) return { counted: true, count }

        // Schon abgedeckt? (eingebaut oder gelernt, auch abgeschaltet)
        const covering = this.list().find(skill => this.covers(skill, observation))
        if (covering) {
            const relearn = covering.origin === 'gelernt' && !covering.enabled && covering.disabledBy === 'automatik'
                && cluster.filter(item => Date.parse(item.at) > Date.parse(covering.disabledAt || covering.updatedAt)).length >= this.repeatThreshold
            if (!relearn) return { counted: true, count }
            const renewed = this.renew(covering, cluster)
            return { counted: true, count, created: renewed }
        }
        const created = this.create(cluster)
        return { counted: true, count, created }
    }

    private covers(skill: RoutineSkill, observation: RoutineObservation): boolean {
        if (skill.ownerId !== '*' && skill.ownerId !== observation.ownerId) return false
        const signature = [...new Set(skill.steps.map(stepSignature))]
        if (skill.origin === 'eingebaut') {
            // Der eingebaute Skill deckt alles ab, was nur seine Werkzeuge nutzt.
            const tools = new Set(skill.steps.map(step => step.tool).concat(['hass_get']))
            return observation.steps.every(step => tools.has(step.tool))
        }
        return skill.intent === observation.intent && jaccard(signature, observation.signature) >= 0.67
    }

    private buildFromCluster(cluster: RoutineObservation[]): Pick<RoutineSkill, 'name' | 'trigger' | 'intent' | 'keywords' | 'steps' | 'check' | 'evidence' | 'readOnly'> {
        const latest = cluster[cluster.length - 1]
        const evidence = cluster.slice(-3).map(item => ({ runId: item.runId, request: item.request, at: item.at }))
        const counts = new Map<string, number>()
        for (const item of cluster) for (const token of item.topic) counts.set(token, (counts.get(token) || 0) + 1)
        const keywords = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([token]) => token).slice(0, 12)
        const steps: RoutineSkillStep[] = latest.steps.map(step => {
            const verdict = classifySkillStep(step.tool)
            return { tool: step.tool, params: step.params, level: verdict.level, fragt: verdict.fragt, hinweis: verdict.hinweis }
        })
        const topic = keywords.slice(0, 3).join(' ') || latest.steps.map(step => step.tool).join(' → ')
        return {
            name: `Routine: ${topic}`.slice(0, 80),
            trigger: `Anfragen wie ${evidence.map(item => `„${item.request.slice(0, 80)}“`).join(', ')} (Aufgabenart ${latest.intent})`,
            intent: latest.intent,
            keywords,
            steps,
            check: `Alle ${steps.length} Schritte laufen ohne Fehler und der Validator bestätigt den Lauf – wie bei den Belegen ${evidence.map(item => item.runId).join(', ')}.`,
            evidence,
            readOnly: steps.every(step => step.level === 'L0'),
        }
    }

    private create(cluster: RoutineObservation[]): RoutineSkill {
        const latest = cluster[cluster.length - 1]
        const built = this.buildFromCluster(cluster)
        const id = `rs-${createHash('sha256').update(`${latest.ownerId}\0${latest.intent}\0${latest.signature.join('>')}`).digest('hex').slice(0, 12)}`
        const at = this.iso()
        const skill: RoutineSkill = {
            id, version: 1, ...built, origin: 'gelernt', ownerId: latest.ownerId,
            enabled: true, uses: 0, successes: 0, failures: 0, consecutiveFailures: 0,
            createdAt: at, updatedAt: at, history: [],
        }
        this.writeSkill(skill)
        this.emit({ kind: 'neu', skill, detail: `${cluster.length}× gleiche Absicht in ${Math.round(this.windowMs / 86_400_000)} Tagen` })
        return skill
    }

    private renew(previous: RoutineSkill, cluster: RoutineObservation[]): RoutineSkill {
        const built = this.buildFromCluster(cluster.filter(item => Date.parse(item.at) > Date.parse(previous.disabledAt || previous.updatedAt)))
        const skill: RoutineSkill = {
            ...previous, ...built, version: previous.version + 1,
            enabled: true, disabledReason: undefined, disabledBy: undefined, disabledAt: undefined,
            consecutiveFailures: 0, updatedAt: this.iso(),
            history: [...previous.history, { version: previous.version, steps: previous.steps, replacedAt: this.iso() }].slice(-5),
        }
        this.writeSkill(skill)
        this.emit({ kind: 'neu', skill, detail: `neu gelernt als Version ${skill.version}` })
        return skill
    }

    private emit(event: RoutineSkillEvent): void {
        try { this.notify?.(event) } catch { /* Meldung ist nie kritisch */ }
    }

    // --- Nutzen -----------------------------------------------------------

    /** Passender, eingeschalteter Skill für eine Owner-Anfrage oder null. */
    match(principalId: string, request: string): RoutineSkill | null {
        const query = topicTokens(request)
        if (query.length === 0) return null
        let best: { skill: RoutineSkill; score: number } | null = null
        for (const skill of this.list()) {
            if (!skill.enabled) continue
            if (skill.ownerId !== '*' && skill.ownerId !== principalId) continue
            const keys = new Set(skill.keywords)
            const shared = query.filter(token => keys.has(token)).length
            if (shared === 0) continue
            const score = shared / query.length
            if (score >= 0.5 && (!best || score > best.score)) best = { skill, score }
        }
        return best?.skill ?? null
    }

    recordUse(id: string): RoutineSkill | null {
        const skill = this.get(id)
        if (!skill) return null
        skill.uses++
        skill.lastUsedAt = this.iso()
        skill.updatedAt = skill.lastUsedAt
        this.writeSkill(skill)
        return skill
    }

    /** Erfolg/Fehlschlag eines Laufs, in dem der Skill genutzt wurde. */
    recordOutcome(id: string, success: boolean): RoutineSkill | null {
        const skill = this.get(id)
        if (!skill) return null
        if (success) { skill.successes++; skill.consecutiveFailures = 0 }
        else { skill.failures++; skill.consecutiveFailures++ }
        skill.updatedAt = this.iso()
        const disable = !success && skill.enabled && skill.consecutiveFailures >= DISABLE_AFTER_FAILURES
        if (disable) {
            skill.enabled = false
            skill.disabledBy = 'automatik'
            skill.disabledAt = skill.updatedAt
            skill.disabledReason = `${skill.consecutiveFailures} Fehlschläge in Folge`
        }
        this.writeSkill(skill)
        if (disable) this.emit({ kind: 'deaktiviert', skill, detail: skill.disabledReason! })
        return skill
    }

    /** Owner schaltet einen Skill an/aus. */
    setEnabled(id: string, enabled: boolean): RoutineSkill | null {
        const skill = this.get(id)
        if (!skill) return null
        skill.enabled = enabled
        skill.updatedAt = this.iso()
        if (enabled) { skill.disabledBy = undefined; skill.disabledReason = undefined; skill.disabledAt = undefined; skill.consecutiveFailures = 0 }
        else { skill.disabledBy = 'owner'; skill.disabledReason = 'vom Owner abgeschaltet'; skill.disabledAt = skill.updatedAt }
        this.writeSkill(skill)
        return skill
    }
}

// ---------------------------------------------------------------------------
// Prompt, Übersicht, Pipeline-Anbindung
// ---------------------------------------------------------------------------

export function buildRoutineSkillPrompt(skill: RoutineSkill): string {
    const lines = [
        `## Gespeicherter Skill: ${skill.name} (v${skill.version}, ${skill.origin})`,
        'Diese Anfrage passt zu einem gespeicherten Skill. Nutze zuerst diese Schritte, statt frei zu planen. Passt die Anfrage doch nicht, plane frei.',
        'Der Skill ist nur ein Plan: er erlaubt nichts zusätzlich. Jeder Schritt braucht dieselbe Freigabe wie einzeln.',
        ...skill.steps.map((step, index) => `${index + 1}. ${step.tool} ${JSON.stringify(step.params)} — ${step.hinweis}`),
        ...(skill.anleitung || []).map(line => `- ${line}`),
        `Erfolgsprüfung: ${skill.check}`,
    ]
    return redactSecrets(lines.join('\n'))
}

export function formatRoutineSkills(skills: readonly RoutineSkill[]): string {
    if (skills.length === 0) return '🧩 *Routine-Skills*\n\nNoch keine.'
    const rows = skills.map(skill => {
        const state = skill.enabled ? '✅ an' : `⏸️ aus (${skill.disabledReason || 'abgeschaltet'})`
        const steps = skill.steps.map(step => `${step.tool}${step.fragt ? ' (fragt)' : ''}`).join(' → ')
        return `• *${skill.name}* \`${skill.id}\` v${skill.version} · ${skill.origin} · ${state}\n  ${steps}\n  genutzt ${skill.uses}× · ok ${skill.successes} · Fehler ${skill.failures}`
    })
    return `🧩 *Routine-Skills (${skills.length})*\n\n${rows.join('\n\n')}\n\n/skills aus <id> · /skills an <id>`
}

let singleton: RoutineSkillStore | null = null
let injected = false

/** Der Store des Prozesses; in Tests/CI ohne eingesetzten Store null (keine Dateien). */
export function getRoutineSkillStore(): RoutineSkillStore | null {
    if (injected) return singleton
    if (sideEffectsDisabled()) return null
    const config = (globalThis as any).__novaState?.config?.routineSkills || {}
    if (config.enabled === false) return null
    return singleton ||= new RoutineSkillStore({
        repeatThreshold: config.repeatThreshold,
        windowDays: config.windowDays,
        notify: defaultNotify,
    })
}

export function setRoutineSkillStore(store: RoutineSkillStore | null): void {
    singleton = store
    injected = store !== null
}

/** Gedanke „Neuer Skill …“ (erledigt, nur Abendbericht) bzw. „… deaktiviert“. */
function defaultNotify(event: RoutineSkillEvent): void {
    void import('../planner/index.js').then(({ addThought, setThoughtStatus }) => {
        const title = event.kind === 'neu'
            ? `Neuer Skill „${event.skill.name}“ angelegt`
            : `Skill „${event.skill.name}“ deaktiviert`
        const { thought } = addThought({
            source: 'skills', kind: 'ereignis', permission: 'selbst', title,
            evidence: `${event.detail}; Belege: ${event.skill.evidence.map(item => item.runId).join(', ') || 'eingebaut'}`,
        })
        if (event.kind === 'neu') setThoughtStatus(thought.id, 'erledigt', 'selbst')
    }).catch(() => { /* Gedanken sind optional */ })
}

export interface RoutineRunContext {
    principalId: string
    permission?: string
    isGroup?: boolean
    systemAuthored?: boolean
    request: string
}

/** Vor dem Lauf: passenden Skill laden (nur Owner, Direktgespräch). */
export function routineSkillHint(store: RoutineSkillStore | null, ctx: RoutineRunContext): { skillId: string; prompt: string } | null {
    if (!store || ctx.permission !== 'owner' || ctx.isGroup || ctx.systemAuthored) return null
    const skill = store.match(ctx.principalId, ctx.request)
    if (!skill) return null
    store.recordUse(skill.id)
    return { skillId: skill.id, prompt: buildRoutineSkillPrompt(skill) }
}

/** Nach dem Lauf: Skill-Ergebnis zählen und den Lauf für die Wiederholung beobachten. */
export function finishRoutineSkillRun(store: RoutineSkillStore | null, ctx: RoutineRunContext & {
    appliedSkillId?: string | null
    runId?: string
    intentKind?: string
    success: boolean
    awaitingApproval?: boolean
    steps: ObserveInput['steps']
}): ObserveResult | null {
    if (!store) return null
    if (ctx.appliedSkillId && !ctx.awaitingApproval) store.recordOutcome(ctx.appliedSkillId, ctx.success)
    return store.observe({
        runId: ctx.runId, principalId: ctx.principalId, permission: ctx.permission, isGroup: ctx.isGroup,
        systemAuthored: ctx.systemAuthored, request: ctx.request, intentKind: ctx.intentKind,
        steps: ctx.steps, success: ctx.success && !ctx.awaitingApproval,
    })
}
