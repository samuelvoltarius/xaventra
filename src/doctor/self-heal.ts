/**
 * Stufe 3 — Selbstheilung mit Beleg und Rückweg (S3.1, S3.3, S3.4, S3.5).
 *
 * Alfreds Entscheidung (01.10.2026): ohne Rückfrage dürfen nur drei Rezepte
 * laufen — eigene Log-/Audit-Dateien in ein Archiv rotieren (nie löschen),
 * eigene Zwischenspeicher nach fester Liste leeren, bei totem Modell-Endpoint
 * auf den zweiten bekannten Endpoint umschalten und zurück. Alles andere ist
 * ein Vorschlag an den Owner (Dienst-Neustart, Platte voll, Lease verloren).
 *
 * Grenzen, hier im Code durchgesetzt:
 * - Nur eigener Prozess und eigenes Datenverzeichnis: kein Shell, kein SSH,
 *   kein root. Jeder Pfad läuft durch `resolveInDataDir` (segmentgenau, auch
 *   gegen Symlinks).
 * - Die Nie-Liste ist eine Code-Konstante. Ein Rezept, das sie berührt (Effekt
 *   oder Ziel), einen unbekannten Effekt hat, ein viertes auto-Rezept wäre oder
 *   keinen Rückweg hat, wird beim Laden abgelehnt und läuft nie.
 * - Jede auto-Heilung: Befund (Messung) → Vorher-Messung → Aktion →
 *   Nachher-Probe → bei Misserfolg Rückweg + erneute Messung. Alles im
 *   Heilungs-Journal (JSONL je Tag, 0600).
 * - Bremsen: Abklingzeit + Tageszähler je Rezept, globaler Not-Aus, nach zwei
 *   erfolglosen Heilungen ist das Rezept aus, bis der Owner es wieder anschaltet.
 * - Standard AUS bis `autonomy.selfHeal.enabled=true`.
 * - Fencing: ohne gültige Main-Lease im enforce-Modus keine Heilaktion; im
 *   observe-Modus wird vermerkt, dass enforce fehlt (nur die drei harmlosen
 *   Rezepte existieren ohnehin).
 * - Worker melden nie selbst an den Owner: ihre Meldungen gehen in die
 *   Mesh-Zusammenfassung, der Main leitet sie genau einmal weiter.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CheckResult } from '../core/autonomy-loop.js'
import { NIE_EFFEKTE, NIE_ZIELE as POLICY_NIE_ZIELE } from '../core/action-policy.js'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { NightwatchReport } from './nightwatch.js'

// ---------------------------------------------------------------------------
// Nie-Liste und Effekt-Vokabular
// ---------------------------------------------------------------------------

/** STUFENPLAN „Feste Grenzen“ Nr. 1 plus die Ausführungsgrenzen von Stufe 3.
 * Nicht per Config, YOLO oder Owner-Befehl aufhebbar. Phase 6b: die Liste lebt
 * in der einheitlichen Aktions-Policy (core/action-policy.ts) und ist hier
 * unter dem alten Namen weiter exportiert; ebenso die Nie-Ziele. */
export const NIE_LISTE: ReadonlyArray<{ effect: string; label: string }> = NIE_EFFEKTE

/** Ziele, die ein Rezept nie berühren darf, auch innerhalb des Datenverzeichnisses. */
const NIE_ZIELE: readonly RegExp[] = POLICY_NIE_ZIELE

export const AUTO_RECIPE_IDS = Object.freeze(['log-rotation', 'cache-leeren', 'endpoint-umschalten'] as const)
const AUTO_EFFECTS = new Set(['fs:eigene-logs-archivieren', 'fs:eigene-caches-leeren', 'llm:endpoint-umschalten'])
const PROPOSAL_EFFECTS = new Set(['vorschlag:einreihen', 'owner:melden'])
export type HealEffect = 'fs:eigene-logs-archivieren' | 'fs:eigene-caches-leeren' | 'llm:endpoint-umschalten' | 'vorschlag:einreihen' | 'owner:melden'
export type HealLevel = 'auto' | 'vorschlag'

// ---------------------------------------------------------------------------
// Pfad-Grenze
// ---------------------------------------------------------------------------

export class SelfHealPathError extends Error {
    readonly code = 'SELF_HEAL_PATH'
    constructor(target: string, reason: string) {
        super(`Pfad außerhalb des Datenverzeichnisses abgelehnt (${reason}): ${String(target).slice(0, 200)}`)
        this.name = 'SelfHealPathError'
    }
}

function outside(rel: string): boolean {
    return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/** Resolves `target` strictly below `dataDir` (never the directory itself).
 * Segment-exact (a sibling `data-evil` is outside) and symlink-safe: the
 * nearest existing ancestor must also resolve inside the real data dir. */
export function resolveInDataDir(dataDir: string, target: string): string {
    if (typeof target !== 'string' || !target || target.includes('\0')) throw new SelfHealPathError(String(target), 'leer')
    const root = resolve(dataDir)
    const abs = resolve(root, target)
    if (outside(relative(root, abs))) throw new SelfHealPathError(target, 'außerhalb')
    const realRoot = existsSync(root) ? realpathSync(root) : root
    let probe = abs
    while (!existsSync(probe) && probe !== root && dirname(probe) !== probe) probe = dirname(probe)
    if (existsSync(probe)) {
        const real = realpathSync(probe)
        if (real !== realRoot && outside(relative(realRoot, real))) throw new SelfHealPathError(target, 'Symlink nach außerhalb')
    }
    return abs
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface EndpointEntry { model: string; endpoint: string }
export interface SelfHealSettings {
    enabled: boolean
    /** Own log/audit files at or above this size are archived. */
    logRotateBytes: number
    /** Disk usage (percent of the data dir's filesystem) that counts as "voll". */
    diskPercent: number
    /** Exactly two known endpoints: the first is preferred, the second the fallback. */
    endpoints?: { primary: EndpointEntry; secondary: EndpointEntry }
}

const MIB = 1024 * 1024
function parseEndpoint(raw: any): EndpointEntry | null {
    if (!raw || typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > 200 || typeof raw.endpoint !== 'string') return null
    try {
        const url = new URL(raw.endpoint)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        if (url.username || url.password) return null
        return { model: raw.model.trim(), endpoint: raw.endpoint.replace(/\/+$/, '') }
    } catch { return null }
}

export function parseSelfHealSettings(raw: unknown): SelfHealSettings {
    const input = (raw && typeof raw === 'object' ? raw : {}) as any
    const bytes = Number(input.logRotateBytes)
    const percent = Number(input.diskPercent)
    const settings: SelfHealSettings = {
        enabled: input.enabled === true,
        logRotateBytes: Number.isFinite(bytes) ? Math.min(100 * 1024 * MIB, Math.max(MIB, Math.floor(bytes))) : 512 * MIB,
        diskPercent: Number.isFinite(percent) ? Math.min(99, Math.max(50, Math.floor(percent))) : 90,
    }
    if (Array.isArray(input.endpoints) && input.endpoints.length === 2) {
        const primary = parseEndpoint(input.endpoints[0])
        const secondary = parseEndpoint(input.endpoints[1])
        if (primary && secondary && primary.endpoint !== secondary.endpoint) settings.endpoints = { primary, secondary }
    }
    return settings
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface EndpointController {
    /** Model the runtime currently uses. */
    currentModel(): string | undefined
    /** True when the endpoint answers (no 5xx, no network error). */
    probe(endpoint: string): Promise<boolean>
    switchTo(entry: EndpointEntry): Promise<boolean>
}

export interface HealSymptom {
    signature: string
    /** Measured evidence for the finding (no secrets, bounded). */
    evidence: Record<string, unknown>
    data?: any
}
export interface HealOutcome { ok: boolean; evidence: Record<string, unknown>; undo?: any }
export interface HealProposal { title: string; message: string }

export interface HealState {
    version: 1
    killSwitch: boolean
    killSwitchAt?: string
    recipes: Record<string, RecipeState>
    endpointActive: 'primary' | 'secondary'
    forwarded: Record<string, string[]>
    outbox: SelfHealMeshReport[]
}
interface RecipeState {
    lastRunAt?: number
    runs: number[]
    successes: number
    failures: number
    disabled?: boolean
    disabledReason?: string
    disabledAt?: string
}

export interface HealContext {
    dataDir: string
    nodeId: string
    now: () => number
    settings: SelfHealSettings
    nightwatch: NightwatchReport | null
    /** Mutable engine state (e.g. which endpoint is active); saved after the run. */
    state: HealState
}

export interface HealRecipe {
    id: string
    level: HealLevel
    title: string
    effects: HealEffect[]
    /** Data-dir relative paths the recipe may act on. Checked at load. */
    targets?: string[]
    cooldownMs: number
    maxPerDay: number
    detect(ctx: HealContext): Promise<HealSymptom[]>
    measure?(ctx: HealContext, symptom: HealSymptom): Promise<Record<string, unknown>>
    act?(ctx: HealContext, symptom: HealSymptom): Promise<HealOutcome>
    probe?(ctx: HealContext, symptom: HealSymptom, act: HealOutcome): Promise<HealOutcome>
    rollback?(ctx: HealContext, symptom: HealSymptom, act: HealOutcome): Promise<HealOutcome>
    /** Optional final step after a passed probe (e.g. free the quarantine). */
    commit?(ctx: HealContext, symptom: HealSymptom, act: HealOutcome): Promise<void>
    proposal?(ctx: HealContext, symptom: HealSymptom): HealProposal
}

const NIE_EFFECTS = new Set(NIE_LISTE.map(item => item.effect))

function recipeProblem(recipe: HealRecipe, dataDir: string, seen: Set<string>): string | null {
    if (!recipe || typeof recipe.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(recipe.id)) return 'ungültige id'
    if (seen.has(recipe.id)) return 'id doppelt'
    const effects = Array.isArray(recipe.effects) ? recipe.effects : []
    if (effects.length === 0) return 'keine Effekte deklariert'
    for (const effect of effects as string[]) {
        if (NIE_EFFECTS.has(effect)) return `berührt die Nie-Liste (${NIE_LISTE.find(item => item.effect === effect)!.label})`
    }
    for (const target of recipe.targets || []) {
        if (NIE_ZIELE.some(pattern => pattern.test(target))) return `Ziel ${JSON.stringify(target)} berührt die Nie-Liste`
        try { resolveInDataDir(dataDir, target) } catch { return `Ziel ${JSON.stringify(target)} liegt außerhalb des Datenverzeichnisses` }
    }
    if (!(Number.isFinite(recipe.cooldownMs) && recipe.cooldownMs >= 60_000)) return 'Abklingzeit fehlt (mindestens 1 min)'
    if (!(Number.isInteger(recipe.maxPerDay) && recipe.maxPerDay >= 1 && recipe.maxPerDay <= 48)) return 'Tageszähler 1–48 fehlt'
    if (typeof recipe.detect !== 'function') return 'keine Symptom-Erkennung'
    if (recipe.level === 'auto') {
        if (!(AUTO_RECIPE_IDS as readonly string[]).includes(recipe.id)) return 'nur die drei freigegebenen Rezepte dürfen automatisch laufen'
        if (effects.some(effect => !AUTO_EFFECTS.has(effect))) return `unbekannter oder nicht freigegebener Effekt ${effects.find(effect => !AUTO_EFFECTS.has(effect))}`
        for (const step of ['measure', 'act', 'probe', 'rollback'] as const) {
            if (typeof recipe[step] !== 'function') return `ohne ${step === 'rollback' ? 'Rückweg' : step === 'probe' ? 'Nachher-Probe' : step === 'measure' ? 'Messung' : 'Aktion'}`
        }
        return null
    }
    if (recipe.level === 'vorschlag') {
        if (effects.some(effect => !PROPOSAL_EFFECTS.has(effect))) return `unbekannter oder nicht freigegebener Effekt ${effects.find(effect => !PROPOSAL_EFFECTS.has(effect))}`
        if (recipe.act || recipe.rollback || recipe.commit) return 'ein Vorschlag führt nie selbst aus'
        if (typeof recipe.proposal !== 'function') return 'ohne Vorschlagstext'
        return null
    }
    return 'Stufe muss auto oder vorschlag sein'
}

/** Load-time gate for the catalog. Rejected recipes never run. */
export function validateRecipeCatalog(recipes: readonly HealRecipe[], dataDir: string): { accepted: HealRecipe[]; rejected: Array<{ id: string; reason: string }> } {
    const accepted: HealRecipe[] = []
    const rejected: Array<{ id: string; reason: string }> = []
    const seen = new Set<string>()
    for (const recipe of recipes) {
        const problem = recipeProblem(recipe, dataDir, seen)
        if (problem) rejected.push({ id: String(recipe?.id ?? '?'), reason: problem })
        else { accepted.push(recipe); seen.add(recipe.id) }
    }
    return { accepted, rejected }
}

// ---------------------------------------------------------------------------
// Fencing gate (S3.5)
// ---------------------------------------------------------------------------

export interface FenceGate { allowAuto: boolean; held: boolean; mode: 'observe' | 'enforce'; note: string }

export function decideFenceGate(input: { held: boolean; mode: 'observe' | 'enforce' }): FenceGate {
    if (input.held) return { allowAuto: true, held: true, mode: input.mode, note: 'gültige Main-Lease' }
    if (input.mode === 'observe') {
        return { allowAuto: true, held: false, mode: 'observe', note: 'Fencing observe: enforce fehlt, nur die drei harmlosen Rezepte im eigenen Datenverzeichnis erlaubt' }
    }
    return { allowAuto: false, held: false, mode: 'enforce', note: 'Fencing enforce ohne gültige Main-Lease: keine Heilaktion' }
}

// ---------------------------------------------------------------------------
// State, journal, proposals
// ---------------------------------------------------------------------------

export type HealResult = 'geheilt' | 'zurueckgerollt' | 'rueckweg-gescheitert' | 'vorschlag' | 'gesperrt-fence'
export interface HealJournalEntry {
    id: string
    at: string
    node: string
    recipe: string
    level: HealLevel
    signature: string
    befund: Record<string, unknown>
    aktion: string
    vorher?: Record<string, unknown>
    nachher?: Record<string, unknown>
    ergebnis: HealResult
    rueckweg?: { ok: boolean; evidence: Record<string, unknown> }
    zustandWieVorher?: boolean
    fence: { held: boolean; mode: string; note: string }
    message: string
}

export interface SelfHealMeshReport { id: string; at: string; recipe: string; level: HealLevel; ergebnis: string; message: string; notify: boolean }
export interface SelfHealMeshSummary { schema: 1; enabled: boolean; killSwitch: boolean; reports: SelfHealMeshReport[] }

const DAY_MS = 24 * 60 * 60_000
const MAX_FAILURES = 2
const OUTBOX_LIMIT = 20
const SUMMARY_REPORTS = 10
const FORWARDED_LIMIT = 100

const stateFile = (dataDir: string) => join(dataDir, 'self-heal', 'state.json')
const proposalsFile = (dataDir: string) => join(dataDir, 'self-heal', 'proposals.json')
const journalDir = (dataDir: string) => join(dataDir, 'self-heal', 'journal')

function emptyState(): HealState {
    return { version: 1, killSwitch: false, recipes: {}, endpointActive: 'primary', forwarded: {}, outbox: [] }
}

export function loadHealState(dataDir: string): HealState {
    try {
        const raw = JSON.parse(readFileSync(stateFile(dataDir), 'utf8'))
        if (raw?.version !== 1) return emptyState()
        return {
            ...emptyState(),
            ...raw,
            killSwitch: raw.killSwitch === true,
            recipes: raw.recipes && typeof raw.recipes === 'object' ? raw.recipes : {},
            endpointActive: raw.endpointActive === 'secondary' ? 'secondary' : 'primary',
            forwarded: raw.forwarded && typeof raw.forwarded === 'object' ? raw.forwarded : {},
            outbox: Array.isArray(raw.outbox) ? raw.outbox.slice(-OUTBOX_LIMIT) : [],
        }
    } catch {
        return emptyState()
    }
}

function saveHealState(dataDir: string, state: HealState): void {
    mkdirSync(join(dataDir, 'self-heal'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(stateFile(dataDir), state)
}

function redactDeep(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return redactSecrets(value).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, 2000)
    if (depth > 6 || value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.slice(0, 50).map(item => redactDeep(item, depth + 1))
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, item]) => [key, redactDeep(item, depth + 1)]))
}

function appendJournal(dataDir: string, entry: HealJournalEntry): void {
    const dir = journalDir(dataDir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(join(dir, `${entry.at.slice(0, 10)}.jsonl`), `${JSON.stringify(redactDeep(entry))}\n`, { mode: 0o600 })
}

/** Latest journal entries, newest last. Corrupt lines are skipped. */
export function readHealJournal(dataDir: string, limit = 20): HealJournalEntry[] {
    const dir = journalDir(dataDir)
    if (!existsSync(dir)) return []
    const files = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse()
    const out: HealJournalEntry[] = []
    for (const file of files) {
        const lines = readFileSync(join(dir, file), 'utf8').split('\n').reverse()
        for (const line of lines) {
            if (!line.trim()) continue
            try { out.push(JSON.parse(line)) } catch { /* skip */ }
            if (out.length >= limit) return out.reverse()
        }
    }
    return out.reverse()
}

export type HealProposalStatus = 'offen' | 'angenommen' | 'abgelehnt'
interface ProposalItem { id: string; at: string; node: string; recipe: string; signature: string; title: string; message: string; befund: Record<string, unknown>; status: HealProposalStatus; decidedAt?: string }
export function readHealProposals(dataDir: string): ProposalItem[] {
    try {
        const raw = JSON.parse(readFileSync(proposalsFile(dataDir), 'utf8'))
        return Array.isArray(raw?.items) ? raw.items : []
    } catch { return [] }
}

function queueProposal(dataDir: string, item: ProposalItem): void {
    const items = [...readHealProposals(dataDir), redactDeep(item) as ProposalItem].slice(-200)
    mkdirSync(join(dataDir, 'self-heal'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(proposalsFile(dataDir), { version: 1, items })
}

/**
 * Owner decision from a button card (CL-10). Only records the decision on an
 * open proposal; it never executes anything (there is no restart executor).
 */
export function setHealProposalStatus(dataDir: string, id: string, status: 'angenommen' | 'abgelehnt', now = Date.now()): boolean {
    const items = readHealProposals(dataDir)
    const index = items.findIndex(item => item.id === id)
    if (index < 0 || items[index].status !== 'offen') return false
    items[index] = { ...items[index], status, decidedAt: new Date(now).toISOString() }
    mkdirSync(join(dataDir, 'self-heal'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(proposalsFile(dataDir), { version: 1, items })
    return true
}

/** Owner switches: global Not-Aus, or re-enable one recipe after an automatic stop. */
export function setSelfHealSwitch(dataDir: string, value: 'an' | 'aus', recipeId?: string, now = Date.now()): string {
    const state = loadHealState(dataDir)
    if (recipeId) {
        const recipe = state.recipes[recipeId]
        if (!recipe) return `Rezept ${recipeId} hat noch keinen Zustand.`
        if (value === 'an') { recipe.disabled = false; recipe.failures = 0; delete recipe.disabledReason; delete recipe.disabledAt }
        else { recipe.disabled = true; recipe.disabledReason = 'vom Owner abgeschaltet'; recipe.disabledAt = new Date(now).toISOString() }
        saveHealState(dataDir, state)
        return `Rezept ${recipeId}: ${value === 'an' ? 'wieder an (Fehlerzähler zurückgesetzt)' : 'aus'}.`
    }
    state.killSwitch = value === 'aus'
    state.killSwitchAt = new Date(now).toISOString()
    saveHealState(dataDir, state)
    return value === 'aus' ? 'Selbstheilung: Not-Aus gesetzt. Keine Heilaktion bis /selbstheilung an.' : 'Selbstheilung: Not-Aus aufgehoben.'
}

// ---------------------------------------------------------------------------
// Mesh summary (worker → Main)
// ---------------------------------------------------------------------------

export function getSelfHealMeshSummary(dataDir: string, enabled = true): SelfHealMeshSummary | null {
    const state = loadHealState(dataDir)
    if (!state.outbox.length && !state.killSwitch) return null
    return { schema: 1, enabled, killSwitch: state.killSwitch, reports: state.outbox.slice(-SUMMARY_REPORTS) }
}

const clip = (value: unknown, max: number) => redactSecrets(String(value ?? '')).replace(/[\u0000-\u001f]/g, ' ').slice(0, max)

/** Receiving side: a peer's summary is signed mesh data, still bounded here. */
export function sanitizeSelfHealSummary(raw: unknown): SelfHealMeshSummary | null {
    const input = raw as any
    if (!input || typeof input !== 'object' || input.schema !== 1 || !Array.isArray(input.reports)) return null
    const reports = input.reports.slice(-SUMMARY_REPORTS).map((report: any) => ({
        id: clip(report?.id, 80),
        at: clip(report?.at, 40),
        recipe: clip(report?.recipe, 64),
        level: report?.level === 'auto' ? 'auto' : 'vorschlag',
        ergebnis: clip(report?.ergebnis, 40),
        message: clip(report?.message, 300),
        notify: report?.notify === true,
    })).filter((report: SelfHealMeshReport) => report.id)
    return { schema: 1, enabled: input.enabled === true, killSwitch: input.killSwitch === true, reports }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface SelfHealRunInput {
    gate: FenceGate
    /** Only the Main (with channels) may notify the owner; workers report via mesh. */
    canNotifyOwner: boolean
    nightwatch?: NightwatchReport | null
    peers?: Array<{ nodeId: string; selfHeal?: SelfHealMeshSummary | null }>
}
export interface SelfHealRunResult {
    active: boolean
    reason?: string
    entries: HealJournalEntry[]
    checks: CheckResult[]
    rejected: Array<{ id: string; reason: string }>
}

const SOURCE = 'selbstheilung'

function sameState(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

async function safely<T>(step: () => Promise<T>, fallback: (error: unknown) => T): Promise<T> {
    try { return await step() } catch (error) { return fallback(error) }
}

const errorEvidence = (error: unknown) => ({ ok: false, evidence: { fehler: String((error as Error)?.message || error).slice(0, 300) } })

export function createSelfHealEngine(options: { dataDir: string; nodeId: string; settings: SelfHealSettings; recipes: readonly HealRecipe[]; now?: () => number }) {
    const now = options.now ?? Date.now
    const { dataDir, nodeId, settings } = options

    async function run(input: SelfHealRunInput): Promise<SelfHealRunResult> {
        const state = loadHealState(dataDir)
        if (!settings.enabled) return { active: false, reason: 'aus (autonomy.selfHeal.enabled ist nicht true)', entries: [], checks: [], rejected: [] }
        if (state.killSwitch) return { active: false, reason: 'Not-Aus gesetzt (/selbstheilung an hebt ihn auf)', entries: [], checks: [], rejected: [] }

        const { accepted, rejected } = validateRecipeCatalog(options.recipes, dataDir)
        for (const item of rejected) console.warn(`[Selbstheilung] Rezept ${item.id} beim Laden abgelehnt: ${item.reason}`)
        const ctx: HealContext = { dataDir, nodeId, now, settings, nightwatch: input.nightwatch ?? null, state }
        const entries: HealJournalEntry[] = []
        const checks: CheckResult[] = []
        const notices: Array<{ entry: HealJournalEntry; severity: CheckResult['severity']; notify: boolean; message: string }> = []
        const fence = { held: input.gate.held, mode: input.gate.mode, note: input.gate.note }

        const record = (entry: HealJournalEntry, severity: CheckResult['severity'], notify: boolean) => {
            entries.push(entry)
            try { appendJournal(dataDir, entry) } catch (error) { console.warn('[Selbstheilung] Journal nicht schreibbar:', (error as Error)?.message) }
            notices.push({ entry, severity, notify, message: entry.message })
        }

        for (const recipe of accepted) {
            const rs: RecipeState = state.recipes[recipe.id] ??= { runs: [], successes: 0, failures: 0 }
            rs.runs = (rs.runs || []).filter(at => now() - at < DAY_MS)
            if (rs.disabled) continue
            if (rs.lastRunAt !== undefined && now() - rs.lastRunAt < recipe.cooldownMs) continue
            if (rs.runs.length >= recipe.maxPerDay) continue

            const symptoms = await safely(() => recipe.detect(ctx), error => {
                console.debug(`[Selbstheilung] ${recipe.id}: Erkennung fehlgeschlagen: ${String(error).slice(0, 200)}`)
                return [] as HealSymptom[]
            })
            if (!symptoms.length) continue
            rs.lastRunAt = now()

            for (const symptom of symptoms.slice(0, 5)) {
                const base = {
                    id: randomUUID(), at: new Date(now()).toISOString(), node: nodeId, recipe: recipe.id, level: recipe.level,
                    signature: String(symptom.signature).slice(0, 200), befund: symptom.evidence, fence,
                }
                if (recipe.level === 'vorschlag') {
                    const proposal = recipe.proposal!(ctx, symptom)
                    queueProposal(dataDir, { id: base.id, at: base.at, node: nodeId, recipe: recipe.id, signature: base.signature, title: proposal.title, message: proposal.message, befund: symptom.evidence, status: 'offen' })
                    rs.runs.push(now())
                    record({ ...base, aktion: 'Vorschlag eingereiht, nichts ausgeführt', ergebnis: 'vorschlag', message: `${proposal.title}: ${proposal.message}` }, 'warning', true)
                    continue
                }
                if (!input.gate.allowAuto) {
                    record({ ...base, aktion: 'keine (Fencing)', ergebnis: 'gesperrt-fence', message: `${recipe.title}: nicht ausgeführt — ${input.gate.note}` }, 'info', false)
                    continue
                }
                rs.runs.push(now())
                const vorher = await safely(() => recipe.measure!(ctx, symptom), error => ({ messfehler: String(error).slice(0, 200) }))
                const acted = await safely(() => recipe.act!(ctx, symptom), errorEvidence) as HealOutcome
                const probed = acted.ok ? await safely(() => recipe.probe!(ctx, symptom, acted), errorEvidence) as HealOutcome : { ok: false, evidence: { probe: 'übersprungen, Aktion gescheitert' } }
                if (acted.ok && probed.ok) {
                    let commitNote: Record<string, unknown> = {}
                    if (recipe.commit) await recipe.commit(ctx, symptom, acted).catch(error => { commitNote = { abschlussFehler: String(error).slice(0, 200) } })
                    const nachher = await safely(() => recipe.measure!(ctx, symptom), error => ({ messfehler: String(error).slice(0, 200) }))
                    rs.successes++
                    record({
                        ...base, aktion: recipe.title, vorher, nachher: { ...nachher, probe: probed.evidence, ...acted.evidence, ...commitNote }, ergebnis: 'geheilt',
                        message: `${recipe.title}: geheilt (${base.signature})`,
                    }, 'info', false)
                    continue
                }
                const back = await safely(() => recipe.rollback!(ctx, symptom, acted), errorEvidence) as HealOutcome
                const nachRueckweg = await safely(() => recipe.measure!(ctx, symptom), error => ({ messfehler: String(error).slice(0, 200) }))
                const restored = back.ok && sameState(vorher, nachRueckweg)
                rs.failures++
                record({
                    ...base, aktion: recipe.title, vorher, nachher: nachRueckweg,
                    ergebnis: restored ? 'zurueckgerollt' : 'rueckweg-gescheitert',
                    rueckweg: { ok: back.ok, evidence: back.evidence }, zustandWieVorher: sameState(vorher, nachRueckweg),
                    message: restored
                        ? `${recipe.title}: Heilung gescheitert (${JSON.stringify(acted.ok ? probed.evidence : acted.evidence).slice(0, 160)}), Rückweg gelaufen, Zustand wie vorher`
                        : `${recipe.title}: Heilung UND Rückweg gescheitert — bitte prüfen (${base.signature})`,
                }, restored ? 'warning' : 'critical', true)
                if (rs.failures >= MAX_FAILURES) {
                    rs.disabled = true
                    rs.disabledReason = `${rs.failures} erfolglose Heilungen`
                    rs.disabledAt = new Date(now()).toISOString()
                    notices.push({ entry: entries[entries.length - 1], severity: 'warning', notify: true, message: `Rezept ${recipe.id} automatisch abgeschaltet nach ${rs.failures} erfolglosen Heilungen (/selbstheilung an ${recipe.id})` })
                    break
                }
            }
        }

        // The Main forwards worker reports exactly once; workers never notify.
        if (input.canNotifyOwner) {
            for (const peer of input.peers || []) {
                const summary = sanitizeSelfHealSummary(peer.selfHeal)
                if (!summary || !peer.nodeId) continue
                const seen = new Set(state.forwarded[peer.nodeId] || [])
                for (const report of summary.reports) {
                    if (seen.has(report.id)) continue
                    seen.add(report.id)
                    if (!report.notify) continue
                    checks.push({ source: SOURCE, severity: 'warning', message: `[${clip(peer.nodeId, 64)}] ${report.message}`, timestamp: now(), requiresNotification: true })
                }
                state.forwarded[peer.nodeId] = [...seen].slice(-FORWARDED_LIMIT)
            }
        }

        for (const notice of notices) {
            if (input.canNotifyOwner) {
                checks.push({ source: SOURCE, severity: notice.severity, message: clip(notice.message, 500), timestamp: now(), requiresNotification: notice.notify, ...(notice.entry.ergebnis === 'geheilt' ? { actionTaken: notice.entry.aktion } : {}) })
            } else {
                state.outbox.push({ id: notice.entry.id + (notice.message === notice.entry.message ? '' : ':aus'), at: notice.entry.at, recipe: notice.entry.recipe, level: notice.entry.level, ergebnis: notice.entry.ergebnis, message: clip(notice.message, 300), notify: notice.notify })
            }
        }
        state.outbox = state.outbox.slice(-OUTBOX_LIMIT)
        saveHealState(dataDir, state)
        return { active: true, entries, checks, rejected }
    }

    return { run }
}

// ---------------------------------------------------------------------------
// Owner view (/heilung)
// ---------------------------------------------------------------------------

export function formatSelfHealStatus(input: {
    dataDir: string
    settings: SelfHealSettings
    recipes: readonly HealRecipe[]
    gate?: FenceGate
    peers?: Array<{ nodeId: string; selfHeal?: SelfHealMeshSummary | null }>
    limit?: number
    now?: number
}): string {
    const now = input.now ?? Date.now()
    const state = loadHealState(input.dataDir)
    const on = input.settings.enabled && !state.killSwitch
    const lines: string[] = []
    lines.push(`Selbstheilung: ${on ? 'AN' : 'AUS'}${!input.settings.enabled ? ' (Config autonomy.selfHeal.enabled ist nicht true)' : state.killSwitch ? ` (Not-Aus seit ${state.killSwitchAt ?? '?'})` : ''}`)
    if (input.gate) lines.push(`Fencing: ${input.gate.mode}, ${input.gate.note}`)
    const { accepted, rejected } = validateRecipeCatalog(input.recipes, input.dataDir)
    lines.push('Rezepte:')
    for (const recipe of accepted) {
        const rs = state.recipes[recipe.id]
        const wait = rs?.lastRunAt !== undefined ? Math.max(0, recipe.cooldownMs - (now - rs.lastRunAt)) : 0
        const status = rs?.disabled ? `AUS (${rs.disabledReason ?? '?'})` : wait > 0 ? `Abklingzeit ${Math.ceil(wait / 60_000)} min` : 'bereit'
        lines.push(`- ${recipe.id} [${recipe.level}] ${status}; geheilt ${rs?.successes ?? 0}, erfolglos ${rs?.failures ?? 0}`)
    }
    for (const item of rejected) lines.push(`- ${item.id} ABGELEHNT: ${item.reason}`)
    if (input.settings.endpoints) lines.push(`Endpoint aktiv: ${state.endpointActive === 'primary' ? 'erster' : 'zweiter'} (${state.endpointActive === 'primary' ? input.settings.endpoints.primary.model : input.settings.endpoints.secondary.model})`)
    const open = readHealProposals(input.dataDir).filter(item => item.status === 'offen')
    lines.push(`Offene Vorschläge: ${open.length}${open.length ? ` (zuletzt: ${JSON.stringify(open[open.length - 1].title)})` : ''}`)
    const journal = readHealJournal(input.dataDir, input.limit ?? 8)
    lines.push(journal.length ? 'Letzte Einträge:' : 'Journal: noch keine Einträge.')
    for (const entry of journal) {
        // JSON quoting keeps evidence from injecting formatting.
        lines.push(`- ${entry.at.slice(0, 16).replace('T', ' ')} ${entry.recipe}: ${entry.ergebnis}${entry.zustandWieVorher !== undefined ? ` (Zustand wie vorher: ${entry.zustandWieVorher ? 'ja' : 'NEIN'})` : ''} — ${JSON.stringify(entry.signature)}`)
    }
    for (const peer of input.peers || []) {
        const summary = sanitizeSelfHealSummary(peer.selfHeal)
        if (!summary) continue
        const last = summary.reports[summary.reports.length - 1]
        lines.push(`Knoten ${peer.nodeId}: ${summary.killSwitch ? 'Not-Aus' : summary.enabled ? 'an' : 'aus'}${last ? `, zuletzt ${last.recipe}: ${last.ergebnis}` : ''}`)
    }
    return lines.join('\n')
}

/** Stable fingerprint so the mesh only carries the summary on change. */
export function selfHealSummaryFingerprint(summary: SelfHealMeshSummary | null): string {
    return createHash('sha256').update(JSON.stringify(summary)).digest('hex').slice(0, 16)
}
