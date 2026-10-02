/**
 * Werkzeug-Schmiede (Skill Forge) — das eine Register selbst gebauter
 * Werkzeuge (P9, 01.10.2026). Ablauf und Regeln: docs/TOOL_FORGE.md.
 *
 * Bau → statische Prüfung → Tests (Daten) in der Sandbox → Aktivierung →
 * Ausführung nur in der Sandbox (tools/forge-sandbox.ts).
 *
 * Aktivierung (fest im Code):
 * - lesend + alle Tests grün → selbst aktiv (Gedanke, Abendbericht-Zeile).
 * - schreibend → Aktionsart `werkzeug-schreibend` (L2): Karte, außer die
 *   Vertrauensleiter hat die Art hochgestuft.
 * - extern/physisch → Karte bei der Aktivierung UND Owner-Freigabe
 *   (`ownerApprovalRefusal`) bei jedem Aufruf.
 * - Eine Freigabe gilt nur für genau diesen Code (sha256); neue Version =
 *   neue Freigabe.
 * - 2 Fehlschläge in Folge → neue Version (lokales Lern-Modell) oder aus.
 * - 2.84.0: Eine Verbesserung (Owner-Ja auf eine Schmiede-Idee) baut einen
 *   Kandidaten; die aktive Version bleibt aktiv, bis er alle Tests besteht
 *   (schreibend/extern/physisch: bis zur Karte). Jede neue Version zählt ins
 *   selbe Tageslimit wie Bedarfs-Bauten; darüber wird sie auf morgen gelegt.
 * - 2.84.0: Fordert das Modell ein Werkzeug an, das in keinem Register steht,
 *   wird daraus Bedarf „fehlendes Werkzeug“ (`missingToolFailures`).
 * - Worker bauen nichts. Kein Cloud-Modell: nur `serviceModels.learning`.
 * - 2.83.0: entsteht ein lesendes Werkzeug aus der Wiederholung eines
 *   Routine-Skills, ersetzt es dort bei der Aktivierung den allgemeinen
 *   Schritt (`RoutineSkillStore.adoptTool`, gemessen, sonst zurück).
 *   Schreibend/extern/physisch bleibt der Skill unverändert.
 *
 * Datei: <runtime>/.nova-data/forge/werkzeuge.json (versioniert, mit Zählern).
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir, getNovaLearningDir, getRuntimeRoot } from '../core/data-root.js'
import { evaluateAction, evaluateActionWithTrust, isNieAktionsart, isNieZiel, isPhysischOderExtern, KARTEN_EXTERN, recordActionOutcome } from '../core/action-policy.js'
import { sideEffectsDisabled } from '../core/side-effects.js'
import { isAutonomyWorker } from '../core/autonomy-defaults.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { NovaTool } from './complete-registry.js'
import { getRoutineSkillStore } from '../learning/routine-skills.js'
import {
    createManifestFetch, createManifestReadFile, FORGE_ALLOWED_MODULES, FORGE_IMPACTS, runInForgeSandbox, sandboxSupport, validateForgeCode,
    type ForgeImpact, type ForgeManifest, type SandboxFetchRequest,
} from './forge-sandbox.js'

export type { ForgeImpact, ForgeManifest } from './forge-sandbox.js'

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export type SkillForgeStage = 'proposed' | 'tested' | 'awaiting-approval' | 'active' | 'degraded' | 'disabled' | 'rejected'
export type ForgeOrigin = 'build_skill' | 'create_skill' | 'bedarf' | 'owner' | 'altbestand'
export interface ForgeParameter { name: string; type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }
export interface ForgeExpectation {
    equals?: unknown
    contains?: string
    type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
    keys?: string[]
    throws?: boolean
}
export interface ForgeFetchFixture { url: string; method?: string; status?: number; body: string; headers?: Record<string, string> }
export interface ForgeTestCase { name: string; params: Record<string, unknown>; fetch?: ForgeFetchFixture[]; files?: Record<string, string>; expect: ForgeExpectation }
export interface ForgeVersion { version: number; code: string; codeHash: string; manifest: ForgeManifest; tests: ForgeTestCase[]; parameters: ForgeParameter[]; replacedAt: string; reason: string }
export interface ForgeTestReport { at: string; codeHash: string; passed: number; total: number; failures: string[] }
export interface ForgeCounters { calls: number; successes: number; failures: number; consecutiveFailures: number; lastUsedAt?: string; lastError?: string }
export interface SkillForgeEvidence { stage: string; evidenceRef: string; verifiedAt: string }
/** 2.83.0: Routine-Skill, dessen allgemeinen Schritt dieses Werkzeug ersetzen soll. */
export interface ForgeAdoptTarget { skillId: string; from: string }
/** 2.84.0: Art einer neuen Version — Verbesserung (Kandidat) oder Reparatur nach Fehlschlägen. */
export type ForgeRevisionMode = 'verbesserung' | 'reparatur'
/** 2.84.0: neue Version, die neben der aktiven auf die Owner-Karte wartet. */
export interface ForgeCandidate { code: string; codeHash: string; manifest: ForgeManifest; tests: ForgeTestCase[]; parameters: ForgeParameter[]; lastTest: ForgeTestReport; reason: string; cardId?: string; createdAt: string }
/** 2.84.0: neue Version, die wegen des Tageslimits später gebaut wird. */
export interface ForgePendingRevision { mode: ForgeRevisionMode; reason: string; notBefore: string }

export interface SkillProposal {
    id: string
    ownerId: string
    name: string
    description: string
    why: string
    code: string
    codeHash: string
    parameters: ForgeParameter[]
    manifest: ForgeManifest
    tests: ForgeTestCase[]
    version: number
    history: ForgeVersion[]
    status: SkillForgeStage
    evidence: SkillForgeEvidence[]
    createdAt: number
    decidedAt?: number
    activationBlockedReason?: string
    disabledReason?: string
    lastTest?: ForgeTestReport
    counters: ForgeCounters
    /** Owner-Freigabe gilt nur für diesen Code-Hash. */
    approvedHash?: string
    cardId?: string
    origin: ForgeOrigin
    adoptFor?: ForgeAdoptTarget
    candidate?: ForgeCandidate
    pendingRevision?: ForgePendingRevision
}

export interface ForgeDraft {
    name: string
    description: string
    why: string
    code: string
    parameters?: ForgeParameter[]
    manifest: ForgeManifest
    tests: ForgeTestCase[]
    ownerId?: string
    origin?: ForgeOrigin
    adoptFor?: ForgeAdoptTarget
}

export interface ForgeModel { complete(messages: Array<{ role: string; content: string }>): Promise<{ content?: string } | null | undefined> }

// ---------------------------------------------------------------------------
// Register (Datei)
// ---------------------------------------------------------------------------

const NAME = /^[a-z][a-z0-9_]{2,40}$/
const MAX_TESTS = 10
const MAX_HISTORY = 5
const DISABLE_AFTER_FAILURES = 2
const INJECTED_PARAMS = new Set(['userId', 'channel', 'authorizationUserId', 'requestText', 'confirm'])

export function forgeRegisterPath(): string { return getNovaDataDir('forge', 'werkzeuge.json') }
const legacyRegisterPath = () => getNovaLearningDir('skill-forge.json')
const nowIso = () => new Date().toISOString()
const hashOf = (code: string) => createHash('sha256').update(code).digest('hex')
export const forgeToolName = (proposal: Pick<SkillProposal, 'name'>) => `forge_${proposal.name}`

function clip(value: unknown, max: number): string {
    return redactSecrets(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, max)
}

function emptyCounters(): ForgeCounters { return { calls: 0, successes: 0, failures: 0, consecutiveFailures: 0 } }

/** Alte Vorschläge (vor P9: Funktionskörper ohne Manifest/Tests) bleiben sichtbar, laufen aber nie. */
function fromLegacy(raw: any): SkillProposal | null {
    const name = String(raw?.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
    const code = String(raw?.code || '')
    if (!raw?.id || !name || !code) return null
    return {
        id: String(raw.id), ownerId: String(raw.ownerId || 'nova-self'), name: NAME.test(name) ? name : `alt_${name}`.slice(0, 40),
        description: String(raw.description || ''), why: String(raw.why || ''), code, codeHash: String(raw.codeHash || hashOf(code)),
        parameters: Array.isArray(raw.parameters) ? raw.parameters : [], manifest: { net: [], fs: [], wirkung: 'lesend' }, tests: [],
        version: 1, history: [], status: 'disabled', evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
        createdAt: Number(raw.createdAt || Date.now()), disabledReason: 'Altvorschlag ohne Manifest und Tests — bei Bedarf neu bauen',
        counters: emptyCounters(), origin: 'altbestand',
    }
}

function readAll(): SkillProposal[] {
    const path = forgeRegisterPath()
    if (!existsSync(path)) {
        const legacy = legacyRegisterPath()
        if (!existsSync(legacy)) return []
        try {
            const parsed = JSON.parse(readFileSync(legacy, 'utf8'))
            const rows = Array.isArray(parsed) ? parsed : parsed?.proposals
            const imported = (Array.isArray(rows) ? rows : []).map(fromLegacy).filter(Boolean) as SkillProposal[]
            writeAll(imported)
            renameSync(legacy, `${legacy}.migriert`)
            return imported
        } catch { return [] }
    }
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        return Array.isArray(parsed?.werkzeuge) ? parsed.werkzeuge : []
    } catch { return [] }
}

function writeAll(proposals: SkillProposal[]): void {
    atomicWriteJsonSync(forgeRegisterPath(), { version: 1, updatedAt: nowIso(), werkzeuge: proposals.slice(-300) })
}

function mutate(id: string, change: (proposal: SkillProposal) => void): SkillProposal | null {
    const all = readAll()
    const proposal = all.find(item => item.id === id)
    if (!proposal) return null
    change(proposal)
    writeAll(all)
    return structuredClone(proposal)
}

function evidence(proposal: SkillProposal, stage: string, evidenceRef: string): void {
    proposal.evidence = [...(proposal.evidence || []), { stage, evidenceRef: clip(evidenceRef, 300), verifiedAt: nowIso() }].slice(-30)
}

export function getSkillProposals(limit = 50, ownerId?: string): SkillProposal[] {
    return readAll().filter(item => !ownerId || item.ownerId === ownerId).slice(-Math.max(1, Math.min(limit, 500))).map(item => structuredClone(item))
}

/** Werkzeug nach ID, Name oder Tool-Name (`forge_<name>`). */
export function getForgeTool(ref: string): SkillProposal | null {
    const key = String(ref || '').trim().toLowerCase().replace(/^forge_/, '')
    const found = readAll().find(item => item.id === ref || item.name === key)
    return found ? structuredClone(found) : null
}

// ---------------------------------------------------------------------------
// Prüfung von Entwurf, Manifest und Tests
// ---------------------------------------------------------------------------

const IMPACT_RANK: Record<ForgeImpact, number> = { lesend: 0, schreibend: 1, physisch: 2, extern: 3 }

/** Wirkung nie niedriger, als Name/Beschreibung es nahelegen (z. B. „licht_schalten“ ist physisch). */
export function effectiveImpact(name: string, declared: ForgeImpact): ForgeImpact {
    const kind = String(name || '').toLowerCase().replace(/_/g, '-')
    let impact: ForgeImpact = FORGE_IMPACTS.includes(declared) ? declared : 'schreibend'
    if (isPhysischOderExtern(kind)) {
        const raised: ForgeImpact = KARTEN_EXTERN.test(kind) || evaluateAction({ kind, origin: 'code' }).impact === 'extern' ? 'extern' : 'physisch'
        if (IMPACT_RANK[raised] > IMPACT_RANK[impact]) impact = raised
    }
    return impact
}

function forbiddenReadPath(path: string): string | null {
    if (!isAbsolute(path)) return `Pfad ${path} ist nicht absolut`
    if (isNieZiel(path)) return `Pfad ${path} ist ein geschütztes Ziel`
    const full = resolve(path)
    const root = getRuntimeRoot()
    for (const own of ['.nova-data', '.nova-learning', '.env', 'xaventra.config.json', 'nova.config.json']) {
        const blocked = resolve(root, own)
        if (full === blocked || full.startsWith(blocked + sep)) return `Pfad ${path} gehört zu Xaventras eigenem Zustand`
    }
    return null
}

function normalizeManifest(raw: any, name: string): { manifest?: ForgeManifest; errors: string[] } {
    const errors: string[] = []
    const net = Array.isArray(raw?.net) ? raw.net.map((host: unknown) => String(host).trim().toLowerCase()).filter(Boolean) : []
    const fs = Array.isArray(raw?.fs) ? raw.fs.map((path: unknown) => String(path).trim()).filter(Boolean) : []
    const declared = String(raw?.wirkung || '') as ForgeImpact
    if (!FORGE_IMPACTS.includes(declared)) errors.push(`Manifest: wirkung muss ${FORGE_IMPACTS.join('|')} sein`)
    if (net.length > 10) errors.push('Manifest: höchstens 10 Hosts')
    for (const host of net) if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) errors.push(`Manifest: ungültiger Host ${host}`)
    if (fs.length > 5) errors.push('Manifest: höchstens 5 Pfade')
    for (const path of fs) { const reason = forbiddenReadPath(path); if (reason) errors.push(`Manifest: ${reason}`) }
    if (errors.length) return { errors }
    return { manifest: { net: [...new Set<string>(net)], fs: [...new Set<string>(fs)], wirkung: effectiveImpact(name, declared) }, errors }
}

function normalizeParameters(raw: unknown): ForgeParameter[] {
    if (!Array.isArray(raw)) return []
    return raw.slice(0, 20).flatMap((item: any) => {
        const name = String(item?.name || '').trim()
        if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) || INJECTED_PARAMS.has(name)) return []
        const type = ['string', 'number', 'boolean'].includes(item?.type) ? item.type : 'string'
        return [{ name, type, description: clip(item?.description || name, 200), ...(item?.required === true ? { required: true } : {}) }]
    })
}

function normalizeTests(raw: unknown): { tests: ForgeTestCase[]; errors: string[] } {
    const errors: string[] = []
    if (!Array.isArray(raw) || raw.length === 0) return { tests: [], errors: ['Mindestens ein Testfall (als Daten) ist Pflicht'] }
    if (raw.length > MAX_TESTS) errors.push(`Höchstens ${MAX_TESTS} Testfälle`)
    const tests = raw.slice(0, MAX_TESTS).map((item: any, index: number): ForgeTestCase => {
        const expectation = item?.expect && typeof item.expect === 'object' ? item.expect : {}
        const keys = ['equals', 'contains', 'type', 'keys', 'throws'].filter(key => key in expectation)
        if (keys.length === 0) errors.push(`Test ${index + 1}: expect braucht equals, contains, type, keys oder throws`)
        const fetch = Array.isArray(item?.fetch) ? item.fetch.slice(0, 10).map((fixture: any) => ({
            url: String(fixture?.url || ''), method: String(fixture?.method || 'GET').toUpperCase(),
            status: Number.isInteger(fixture?.status) ? fixture.status : 200, body: String(fixture?.body ?? ''),
            ...(fixture?.headers && typeof fixture.headers === 'object' ? { headers: Object.fromEntries(Object.entries(fixture.headers).map(([k, v]) => [String(k), String(v)])) } : {}),
        })) : undefined
        const files = item?.files && typeof item.files === 'object' ? Object.fromEntries(Object.entries(item.files).slice(0, 10).map(([k, v]) => [String(k), String(v)])) : undefined
        return {
            name: clip(item?.name || `Test ${index + 1}`, 120),
            params: item?.params && typeof item.params === 'object' && !Array.isArray(item.params) ? item.params : {},
            ...(fetch ? { fetch } : {}), ...(files ? { files } : {}),
            expect: {
                ...('equals' in expectation ? { equals: expectation.equals } : {}),
                ...(typeof expectation.contains === 'string' ? { contains: expectation.contains } : {}),
                ...(typeof expectation.type === 'string' ? { type: expectation.type } : {}),
                ...(Array.isArray(expectation.keys) ? { keys: expectation.keys.map(String) } : {}),
                ...(expectation.throws === true ? { throws: true } : {}),
            },
        }
    })
    return { tests, errors }
}

/** Entwurf prüfen und normalisieren (wirft mit allen Gründen). */
export async function validateDraft(draft: ForgeDraft): Promise<Omit<SkillProposal, 'id' | 'status' | 'evidence' | 'createdAt' | 'counters' | 'history' | 'version'>> {
    const errors: string[] = []
    const name = String(draft?.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/^forge_/, '')
    if (!NAME.test(name)) errors.push('Name: snake_case, 3–41 Zeichen, beginnt mit Buchstabe')
    if (isNieAktionsart(name.replace(/_/g, '-'))) errors.push(`Name „${name}“ trifft die Nie-Liste — wird nie gebaut`)
    const description = clip(draft?.description, 400)
    const why = clip(draft?.why, 400)
    if (!description) errors.push('Beschreibung fehlt')
    if (!why) errors.push('Begründung (why) fehlt')
    const code = String(draft?.code || '').trim()
    const { manifest, errors: manifestErrors } = normalizeManifest(draft?.manifest, name)
    errors.push(...manifestErrors)
    const { tests, errors: testErrors } = normalizeTests(draft?.tests)
    errors.push(...testErrors)
    const static_ = await validateForgeCode(code)
    errors.push(...static_.errors)
    if (manifest) {
        for (const test of tests) for (const fixture of test.fetch || []) {
            let host = ''
            try { host = new URL(fixture.url).hostname.toLowerCase() } catch { errors.push(`Test „${test.name}“: ungültige Fixture-URL`) }
            if (host && !manifest.net.includes(host)) errors.push(`Test „${test.name}“: Host ${host} fehlt im Manifest`)
        }
    }
    if (errors.length) throw new Error(`Werkzeug-Entwurf abgelehnt: ${[...new Set(errors)].join('; ')}`)
    return {
        ownerId: clip(draft.ownerId || 'nova-self', 200), name, description, why, code, codeHash: hashOf(code),
        parameters: normalizeParameters(draft.parameters), manifest: manifest!, tests, origin: draft.origin || 'build_skill',
        ...(adoptTarget(draft.adoptFor) ? { adoptFor: adoptTarget(draft.adoptFor)! } : {}),
    }
}

function adoptTarget(value: unknown): ForgeAdoptTarget | null {
    const skillId = String((value as ForgeAdoptTarget | undefined)?.skillId || '')
    const from = String((value as ForgeAdoptTarget | undefined)?.from || '')
    return /^[a-z0-9][a-z0-9-]{2,79}$/.test(skillId) && GENERIC_TOOLS.has(from) ? { skillId, from } : null
}

/** Lesend + aus einem Skill-Bedarf: der Skill nutzt jetzt dieses Werkzeug (gemessen, sonst zurück). */
function adoptIntoRoutineSkill(proposal: SkillProposal): void {
    if (proposal.manifest.wirkung !== 'lesend' || !proposal.adoptFor) return
    try { getRoutineSkillStore()?.adoptTool(proposal.adoptFor.skillId, proposal.adoptFor.from, forgeToolName(proposal)) } catch { /* Skills sind optional */ }
}

/** Neuen Entwurf ins Register legen (noch nicht getestet, noch nicht aktiv). */
export async function createSkillProposal(draft: ForgeDraft): Promise<SkillProposal> {
    if (isAutonomyWorker()) throw new Error('Worker bauen keine Werkzeuge (nur der Main).')
    const checked = await validateDraft(draft)
    const all = readAll()
    if (all.some(item => item.name === checked.name && item.status !== 'rejected' && item.status !== 'disabled')) {
        throw new Error(`Werkzeug „${checked.name}“ gibt es schon — neue Version über /werkzeuge oder anderen Namen wählen`)
    }
    const proposal: SkillProposal = {
        ...checked, id: `forge_${Date.now()}_${randomUUID().slice(0, 8)}`, version: 1, history: [], status: 'proposed',
        evidence: [{ stage: 'proposed', evidenceRef: `sha256:${checked.codeHash}`, verifiedAt: nowIso() }],
        createdAt: Date.now(), counters: emptyCounters(), activationBlockedReason: 'Noch nicht getestet',
    }
    writeAll([...all.filter(item => item.id !== proposal.id), proposal])
    return structuredClone(proposal)
}

// ---------------------------------------------------------------------------
// Tests in der Sandbox
// ---------------------------------------------------------------------------

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

function typeOf(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

/** Prüft ein Sandbox-Ergebnis gegen die Erwartung; Grund oder null. */
export function expectationFailure(expectation: ForgeExpectation, result: { ok: boolean; value?: unknown; error?: string; timedOut?: boolean }): string | null {
    if (expectation.throws) return !result.ok && !result.timedOut ? null : result.timedOut ? 'Zeitlimit statt Fehler' : 'erwarteter Fehler blieb aus'
    if (!result.ok) return `Fehler: ${String(result.error || '?').slice(0, 200)}`
    if ('equals' in expectation && !sameJson(result.value, expectation.equals)) return `erwartet ${JSON.stringify(expectation.equals).slice(0, 120)}, bekam ${JSON.stringify(result.value).slice(0, 120)}`
    if (expectation.contains !== undefined) {
        const text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
        if (!String(text).includes(expectation.contains)) return `enthält nicht „${expectation.contains.slice(0, 80)}“`
    }
    if (expectation.type && typeOf(result.value) !== expectation.type) return `Typ ${typeOf(result.value)} statt ${expectation.type}`
    if (expectation.keys) {
        const value = result.value
        if (!value || typeof value !== 'object') return 'kein Objekt für keys'
        const missing = expectation.keys.filter(key => !(key in (value as Record<string, unknown>)))
        if (missing.length) return `fehlende Felder: ${missing.join(', ')}`
    }
    return null
}

function fixtureFetch(test: ForgeTestCase) {
    return async (request: SandboxFetchRequest) => {
        const fixture = (test.fetch || []).find(item => (item.method || 'GET') === request.method && (request.url === item.url || request.url.startsWith(item.url)))
        if (!fixture) throw new Error(`kein Testdatensatz für ${request.method} ${request.url}`)
        return { status: fixture.status ?? 200, headers: fixture.headers || {}, body: fixture.body }
    }
}

/** Testfälle eines Codes (aktiv oder Kandidat) in der Sandbox laufen lassen. */
async function runForgeTests(subject: Pick<SkillProposal, 'code' | 'codeHash' | 'manifest' | 'tests'>): Promise<ForgeTestReport> {
    const report: ForgeTestReport = { at: nowIso(), codeHash: subject.codeHash, passed: 0, total: subject.tests.length, failures: [] }
    const support = sandboxSupport()
    if (!support.ok) {
        report.failures.push(support.reason)
        return report
    }
    for (const test of subject.tests) {
        const result = await runInForgeSandbox({
            code: subject.code, params: test.params, manifest: subject.manifest, timeoutMs: 10_000,
            fetchHandler: fixtureFetch(test),
            readFileHandler: async path => {
                if (test.files && Object.prototype.hasOwnProperty.call(test.files, path)) return test.files[path]
                throw new Error(`kein Testdatensatz für Datei ${path}`)
            },
        })
        const failure = expectationFailure(test.expect, result)
        if (failure) report.failures.push(`${test.name}: ${failure}`)
        else report.passed++
    }
    return report
}

const allGreen = (report: ForgeTestReport) => report.total > 0 && report.passed === report.total

/** Alle Testfälle des aktuellen Codes in der Sandbox laufen lassen. */
export async function testSkillProposal(id: string): Promise<{ proposal: SkillProposal | null; report: ForgeTestReport }> {
    const proposal = getForgeTool(id)
    if (!proposal) return { proposal: null, report: { at: nowIso(), codeHash: '', passed: 0, total: 0, failures: ['unbekanntes Werkzeug'] } }
    const report = await runForgeTests(proposal)
    const updated = mutate(id, item => {
        item.lastTest = report
        if (report.total > 0 && report.passed === report.total && report.codeHash === item.codeHash) {
            if (item.status === 'proposed' || item.status === 'degraded') item.status = 'tested'
            evidence(item, 'tested', `sandbox:${report.passed}/${report.total}:${item.codeHash.slice(0, 16)}`)
            item.activationBlockedReason = undefined
        } else {
            item.activationBlockedReason = `Tests nicht grün: ${report.failures.slice(0, 3).join(' | ')}`.slice(0, 500)
        }
    })
    return { proposal: updated, report }
}

// ---------------------------------------------------------------------------
// Aktivierung
// ---------------------------------------------------------------------------

type CardKind = 'werkzeug-schreibend' | 'werkzeug-extern' | 'werkzeug-physisch'
const cardKindFor = (impact: ForgeImpact): CardKind | null => impact === 'schreibend' ? 'werkzeug-schreibend' : impact === 'extern' ? 'werkzeug-extern' : impact === 'physisch' ? 'werkzeug-physisch' : null

let notifier: ((event: { kind: 'aktiv' | 'freigabe' | 'aus' | 'neue-version' | 'bedarf' | 'fehler'; tool?: SkillProposal; text: string }) => void) | null | undefined

/** Tests setzen hier einen eigenen Empfänger; null schaltet Meldungen ab. */
export function setForgeNotifier(next: typeof notifier): void { notifier = next }

function notify(kind: 'aktiv' | 'freigabe' | 'aus' | 'neue-version' | 'bedarf' | 'fehler', text: string, tool?: SkillProposal): void {
    if (notifier !== undefined) { try { notifier?.({ kind, tool, text }) } catch { /* never critical */ } return }
    if (sideEffectsDisabled()) return
    void import('../planner/index.js').then(({ addThought, setThoughtStatus }) => {
        const { thought } = addThought({
            source: 'werkzeuge', kind: 'ereignis', permission: 'selbst', title: clip(text, 160),
            evidence: tool ? `${forgeToolName(tool)} v${tool.version} · ${tool.manifest.wirkung} · sha ${tool.codeHash.slice(0, 12)}` : undefined,
            ...(kind === 'aus' || kind === 'fehler' ? { severity: 'warning' as const } : {}),
        })
        // Erledigte Ereignisse erscheinen nur als Zeile im Abendbericht.
        if (kind === 'aktiv' || kind === 'neue-version') setThoughtStatus(thought.id, 'erledigt', 'selbst')
    }).catch(() => { /* thoughts are optional */ })
}

function activate(id: string, reason: string): SkillProposal | null {
    const proposal = mutate(id, item => {
        item.status = 'active'
        item.decidedAt = Date.now()
        item.activationBlockedReason = undefined
        item.disabledReason = undefined
        item.counters.consecutiveFailures = 0
        evidence(item, 'active', `${reason}:${item.codeHash.slice(0, 16)}`)
    })
    if (proposal) {
        void registerForgeTool(proposal).catch(() => { /* registry optional in tests */ })
        notify('aktiv', `Werkzeug ${forgeToolName(proposal)} v${proposal.version} aktiv (${proposal.manifest.wirkung}) — ${reason}`, proposal)
        adoptIntoRoutineSkill(proposal)
    }
    return proposal
}

async function requestApproval(proposal: SkillProposal, kind: CardKind): Promise<SkillProposal | null> {
    await registerForgeCardExecutors()
    const { createApprovalCard } = await import('../core/approval-cards.js')
    const test = proposal.lastTest
    const created = createApprovalCard({
        art: kind,
        titel: `Werkzeug ${forgeToolName(proposal)} aktivieren?`,
        beleg: `v${proposal.version} · Wirkung ${proposal.manifest.wirkung} · Hosts: ${proposal.manifest.net.join(', ') || 'keine'} · Dateien: ${proposal.manifest.fs.join(', ') || 'keine'} · Tests ${test?.passed ?? 0}/${test?.total ?? 0} grün · sha ${proposal.codeHash.slice(0, 12)}`,
        vorschlag: `${proposal.description}${kind === 'werkzeug-schreibend' ? '' : ' — fragt zusätzlich bei jedem Aufruf'}`,
        aktion: { kind, ref: proposal.id },
        wirkung: proposal.manifest.wirkung === 'extern' ? 'extern' : proposal.manifest.wirkung === 'physisch' ? 'physisch' : 'intern',
        quelle: 'werkzeuge',
        dedupeKey: `werkzeug:${proposal.id}:${proposal.codeHash.slice(0, 16)}`,
    })
    return mutate(proposal.id, item => {
        item.status = 'awaiting-approval'
        item.activationBlockedReason = created.ok ? 'Wartet auf die Owner-Karte' : `Keine Karte möglich: ${(created as { reason?: string }).reason}`
        if (created.ok) item.cardId = created.card.id
    })
}

/** Nach grünen Tests: selbst aktiv, Vertrauensleiter oder Karte. */
export async function decideActivation(id: string): Promise<SkillProposal | null> {
    const proposal = getForgeTool(id)
    if (!proposal) return null
    if (proposal.status !== 'tested' && proposal.status !== 'awaiting-approval') return proposal
    const test = proposal.lastTest
    if (!test || test.codeHash !== proposal.codeHash || test.total === 0 || test.passed !== test.total) return proposal
    const impact = proposal.manifest.wirkung
    if (impact === 'lesend') return activate(id, 'selbst: lesend und alle Tests grün')
    if (proposal.approvedHash === proposal.codeHash) return activate(id, 'Owner-Freigabe')
    if (impact === 'schreibend') {
        const verdict = evaluateActionWithTrust({ kind: 'werkzeug-schreibend', origin: 'code' })
        if (verdict.decision === 'auto' && verdict.trusted) return activate(id, 'Vertrauensleiter (werkzeug-schreibend)')
    }
    if (proposal.status === 'awaiting-approval' && proposal.cardId) return proposal
    const updated = await requestApproval(proposal, cardKindFor(impact)!)
    if (updated) notify('freigabe', `Werkzeug ${forgeToolName(updated)} wartet auf Freigabe (${impact})`, updated)
    return updated
}

/** Owner gibt genau diesen Code frei. */
export function approveSkillProposal(id: string, by = 'owner'): SkillProposal | null {
    const before = getForgeTool(id)
    if (!before || before.status === 'rejected') return null
    const approved = mutate(id, item => {
        item.approvedHash = item.codeHash
        evidence(item, 'owner-freigabe', `owner:${clip(by, 80)}`)
    })
    if (!approved) return null
    if (approved.status === 'awaiting-approval' || approved.status === 'tested') {
        const test = approved.lastTest
        if (test && test.codeHash === approved.codeHash && test.total > 0 && test.passed === test.total) {
            const active = activate(id, `Owner-Freigabe (${clip(by, 40)})`)
            if (active && active.manifest.wirkung === 'schreibend') {
                try { recordActionOutcome('werkzeug-schreibend', { ok: true, approvedByOwner: true }) } catch { /* trust ladder optional */ }
            }
            return active
        }
    }
    return approved
}

export function rejectSkillProposal(id: string, by = 'owner'): SkillProposal | null {
    const proposal = mutate(id, item => {
        item.status = 'rejected'
        item.decidedAt = Date.now()
        item.activationBlockedReason = 'Vom Owner abgelehnt'
        evidence(item, 'rejected', `owner:${clip(by, 80)}`)
    })
    if (proposal) void unregisterForgeTool(proposal).catch(() => undefined)
    return proposal
}

/** Kompatibel zu Telegram (`skill_ok:`/`skill_no:`) und Desktop. */
export function updateSkillProposalStatus(id: string, status: 'approved' | 'rejected', _ownerId = 'nova-self'): SkillProposal | null {
    return status === 'rejected' ? rejectSkillProposal(id, 'owner') : approveSkillProposal(id, 'owner')
}

/** Owner schaltet ein Werkzeug aus oder wieder an (an = Tests + Aktivierung neu). */
export async function setForgeToolEnabled(ref: string, enabled: boolean, by = 'owner'): Promise<SkillProposal | null> {
    const proposal = getForgeTool(ref)
    if (!proposal || proposal.status === 'rejected') return null
    if (!enabled) {
        const off = mutate(proposal.id, item => {
            item.status = 'disabled'
            item.disabledReason = `vom Owner abgeschaltet (${clip(by, 40)})`
            evidence(item, 'disabled', `owner:${clip(by, 80)}`)
        })
        if (off) await unregisterForgeTool(off).catch(() => undefined)
        return off
    }
    if (proposal.origin === 'altbestand') return proposal
    mutate(proposal.id, item => { item.status = 'proposed'; item.disabledReason = undefined; item.counters.consecutiveFailures = 0 })
    await testSkillProposal(proposal.id)
    return decideActivation(proposal.id)
}

// ---------------------------------------------------------------------------
// Bauen (eine Stelle für build_skill, create_skill, Bedarf, /werkzeuge bau)
// ---------------------------------------------------------------------------

export interface BuildResult { proposal: SkillProposal | null; message: string }

export async function buildTool(draft: ForgeDraft): Promise<BuildResult> {
    if (isAutonomyWorker()) return { proposal: null, message: '❌ Worker bauen keine Werkzeuge — nur der Main.' }
    let created: SkillProposal
    try { created = await createSkillProposal(draft) } catch (error) {
        return { proposal: null, message: `❌ ${String((error as Error)?.message || error).slice(0, 600)}` }
    }
    const { proposal: tested, report } = await testSkillProposal(created.id)
    if (!tested || tested.status !== 'tested') {
        return { proposal: tested, message: `🧪 Werkzeug ${forgeToolName(created)} gespeichert, aber Tests nicht grün (${report.passed}/${report.total}): ${report.failures.slice(0, 3).join(' | ')}`.slice(0, 800) }
    }
    const decided = await decideActivation(created.id)
    const state = decided?.status === 'active'
        ? `aktiv (${decided.manifest.wirkung})${decided.manifest.wirkung === 'extern' || decided.manifest.wirkung === 'physisch' ? ', fragt bei jedem Aufruf' : ''}`
        : `wartet auf Freigabe (${decided?.manifest.wirkung}) — Karte gestellt`
    return { proposal: decided, message: `🔨 Werkzeug ${forgeToolName(created)} v${created.version}: Tests ${report.passed}/${report.total} grün, ${state}.` }
}

// ---------------------------------------------------------------------------
// Generator: nur das lokale Lern-Modell (serviceModels.learning)
// ---------------------------------------------------------------------------

let forgeModel: ForgeModel | null = null
export function setForgeModel(model: ForgeModel | null): void { forgeModel = model }
export function hasForgeModel(): boolean { return forgeModel !== null }

const GENERATOR_SYSTEM = `Du baust ein kleines Werkzeug für Xaventra. Antworte AUSSCHLIESSLICH mit einem JSON-Objekt:
{"name":"snake_case","description":"was es tut","why":"wofür","parameters":[{"name":"x","type":"string|number|boolean","description":"...","required":true}],
 "manifest":{"net":["api.beispiel.de"],"fs":[],"wirkung":"lesend|schreibend|extern|physisch"},
 "code":"export default async function (params, ctx) { ... }",
 "tests":[{"name":"...","params":{},"fetch":[{"url":"https://api.beispiel.de/...","status":200,"body":"..."}],"expect":{"contains":"..."}}]}
Regeln für den Code: ESM-JavaScript mit export default async function (params, ctx). Erlaubte Importe nur: ${FORGE_ALLOWED_MODULES.join(', ')}.
Kein fs, kein net/http, kein process, kein require, kein dynamisches import(), kein eval/Function.
Netz nur über await ctx.fetch(url, {method, headers, body}) zu Hosts aus manifest.net (Antwort hat .ok, .status, .text(), .json()).
Dateien nur über await ctx.readFile(pfad) aus manifest.fs. Rückgabe muss JSON-darstellbar sein.
wirkung: lesend = ändert nichts (nur GET/HEAD); schreibend = ändert etwas in einem Dienst; extern = verlässt das Haus (Mail, Nachricht, Kauf); physisch = wirkt im Raum (Licht, Drucker).
Tests sind Daten: 2–5 Fälle, Netz nur über "fetch"-Testdatensätze, Erwartung mit equals, contains, type, keys oder throws.`

function parseDraft(text: string): Record<string, unknown> {
    const match = String(text || '').match(/\{[\s\S]*\}/)
    if (!match) throw new Error('Lern-Modell lieferte kein JSON')
    return JSON.parse(match[0])
}

export async function generateToolDraft(input: { request: string; nameHint?: string; ownerId?: string; origin?: ForgeOrigin; previous?: SkillProposal; error?: string; mode?: ForgeRevisionMode }): Promise<ForgeDraft> {
    if (!forgeModel) throw new Error('Kein lokales Lern-Modell (serviceModels.learning) erreichbar — Werkzeug wird nicht gebaut.')
    const previous = input.previous
    const why = input.mode === 'verbesserung' ? `Es soll besser werden. Anlass: ${clip(input.error, 400)}` : `Es scheiterte zweimal: ${clip(input.error, 400)}`
    const user = previous
        ? `Überarbeite das Werkzeug "${previous.name}" (Version ${previous.version}). ${why}\nBisheriger Code:\n${previous.code}\nManifest: ${JSON.stringify(previous.manifest)}\nTests: ${JSON.stringify(previous.tests).slice(0, 4_000)}\nBehalte den Namen "${previous.name}".`
        : `Aufgabe: ${clip(input.request, 1_000)}${input.nameHint ? `\nName-Vorschlag: ${clip(input.nameHint, 60)}` : ''}`
    const response = await forgeModel.complete([{ role: 'system', content: GENERATOR_SYSTEM }, { role: 'user', content: user }])
    const raw = parseDraft(String(response?.content || ''))
    return {
        name: String(previous?.name || raw.name || input.nameHint || ''),
        description: String(raw.description || input.request || ''),
        why: String(raw.why || input.request || 'angeforderte Fähigkeit'),
        code: String(raw.code || ''),
        parameters: raw.parameters as ForgeParameter[],
        manifest: raw.manifest as ForgeManifest,
        tests: raw.tests as ForgeTestCase[],
        ownerId: input.ownerId || previous?.ownerId,
        origin: input.origin || previous?.origin || 'create_skill',
    }
}

export interface ReviseOptions {
    /** `verbesserung` (Standard, Owner-Ja auf eine Idee): Kandidat, nichts wird abgeschaltet. `reparatur`: nach 2 Fehlschlägen in Folge. */
    mode?: ForgeRevisionMode
    now?: () => number
}

/**
 * Neue Version desselben Werkzeugs. Freigaben gelten nicht weiter.
 * - Tageslimit: zählt mit den Bedarfs-Bauten (`bedarf.json`); darüber wird
 *   die Version auf morgen gelegt, nichts abgeschaltet.
 * - Verbesserung: die aktive Version bleibt, bis der Kandidat alle Tests
 *   besteht (und, falls nötig, die Owner-Karte). Scheitert er, wird er verworfen.
 * - Reparatur: nur dieser Weg darf abschalten (Entwurf oder Tests gescheitert).
 */
export async function reviseTool(id: string, error: string, options: ReviseOptions = {}): Promise<BuildResult> {
    const mode: ForgeRevisionMode = options.mode || 'verbesserung'
    const now = (options.now || Date.now)()
    const proposal = getForgeTool(id)
    if (!proposal) return { proposal: null, message: 'unbekanntes Werkzeug' }
    if (mode === 'verbesserung' && (proposal.status === 'disabled' || proposal.status === 'rejected')) {
        return { proposal, message: `${forgeToolName(proposal)} ist aus (${proposal.status}) — keine neue Version` }
    }
    if (forgeModel && !reserveBuild(`neue-version:${proposal.id}:${now}`, 'neue-version', now)) {
        const deferred = mutate(id, item => { item.pendingRevision = { mode, reason: clip(error, 300), notBefore: new Date(now + DAY_MS).toISOString() } })
        notify('bedarf', `Werkzeug ${forgeToolName(proposal)}: Tageslimit ${MAX_BUILDS_PER_DAY} Bauten erreicht — neue Version morgen (v${proposal.version} bleibt ${proposal.status === 'degraded' ? 'pausiert' : proposal.status})`, deferred || proposal)
        return { proposal: deferred, message: `Tageslimit ${MAX_BUILDS_PER_DAY} Werkzeug-Bauten erreicht — neue Version morgen` }
    }
    if (proposal.pendingRevision) mutate(id, item => { item.pendingRevision = undefined })
    if (mode === 'verbesserung') return reviseAsCandidate(proposal, error)
    let draft: ForgeDraft
    let checked: Awaited<ReturnType<typeof validateDraft>>
    try {
        draft = await generateToolDraft({ request: proposal.description, previous: proposal, error })
        checked = await validateDraft({ ...draft, name: proposal.name, ownerId: proposal.ownerId, origin: proposal.origin })
    } catch (failure) {
        const off = mutate(id, item => { item.status = 'disabled'; item.disabledReason = `2 Fehlschläge, neue Version gescheitert: ${clip((failure as Error)?.message || failure, 200)}` })
        if (off) { await unregisterForgeTool(off).catch(() => undefined); notify('aus', `Werkzeug ${forgeToolName(off)} abgeschaltet (2 Fehlschläge, keine neue Version)`, off) }
        return { proposal: off, message: 'abgeschaltet' }
    }
    mutate(id, item => {
        item.history = [...item.history, { version: item.version, code: item.code, codeHash: item.codeHash, manifest: item.manifest, tests: item.tests, parameters: item.parameters, replacedAt: nowIso(), reason: clip(error, 200) }].slice(-MAX_HISTORY)
        item.version += 1
        item.code = checked.code
        item.codeHash = checked.codeHash
        item.manifest = checked.manifest
        item.tests = checked.tests
        item.parameters = checked.parameters
        item.status = 'proposed'
        item.cardId = undefined
        item.counters.consecutiveFailures = 0
        evidence(item, 'neue-version', `sha256:${checked.codeHash}`)
    })
    const { proposal: tested, report } = await testSkillProposal(id)
    if (!tested || tested.status !== 'tested') {
        const off = mutate(id, item => { item.status = 'disabled'; item.disabledReason = `neue Version v${item.version}: Tests nicht grün (${report.passed}/${report.total})` })
        if (off) notify('aus', `Werkzeug ${forgeToolName(off)} abgeschaltet: neue Version besteht die Tests nicht`, off)
        return { proposal: off, message: 'abgeschaltet' }
    }
    const decided = await decideActivation(id)
    if (decided) notify('neue-version', `Werkzeug ${forgeToolName(decided)} v${decided.version} gebaut (${decided.status})`, decided)
    return { proposal: decided, message: `neue Version v${decided?.version}` }
}

function promoteCandidate(item: SkillProposal, candidate: ForgeCandidate): void {
    item.history = [...item.history, { version: item.version, code: item.code, codeHash: item.codeHash, manifest: item.manifest, tests: item.tests, parameters: item.parameters, replacedAt: nowIso(), reason: candidate.reason }].slice(-MAX_HISTORY)
    item.version += 1
    item.code = candidate.code
    item.codeHash = candidate.codeHash
    item.manifest = candidate.manifest
    item.tests = candidate.tests
    item.parameters = candidate.parameters
    item.lastTest = candidate.lastTest
    item.candidate = undefined
    item.cardId = undefined
    item.status = 'tested'
    item.activationBlockedReason = undefined
    item.counters.consecutiveFailures = 0
    evidence(item, 'neue-version', `sha256:${candidate.codeHash}`)
    evidence(item, 'tested', `sandbox:${candidate.lastTest.passed}/${candidate.lastTest.total}:${candidate.codeHash.slice(0, 16)}`)
}

function discardCandidate(proposal: SkillProposal, why: string): BuildResult {
    const kept = mutate(proposal.id, item => { item.candidate = undefined; evidence(item, 'kandidat-verworfen', why) })
    notify('fehler', `Werkzeug ${forgeToolName(proposal)}: neue Version verworfen (${clip(why, 160)}) — v${proposal.version} bleibt ${proposal.status}`, kept || proposal)
    return { proposal: kept, message: `neue Version verworfen: ${clip(why, 200)}` }
}

/** Verbesserung: Kandidat bauen und testen; die aktive Version bleibt, bis er besteht. */
async function reviseAsCandidate(proposal: SkillProposal, reason: string): Promise<BuildResult> {
    let checked: Awaited<ReturnType<typeof validateDraft>>
    try {
        const draft = await generateToolDraft({ request: proposal.description, previous: proposal, error: reason, mode: 'verbesserung' })
        checked = await validateDraft({ ...draft, name: proposal.name, ownerId: proposal.ownerId, origin: proposal.origin })
    } catch (failure) {
        return discardCandidate(proposal, `Entwurf: ${clip((failure as Error)?.message || failure, 200)}`)
    }
    if (checked.codeHash === proposal.codeHash) return discardCandidate(proposal, 'Entwurf unverändert')
    const lastTest = await runForgeTests(checked)
    if (!allGreen(lastTest)) return discardCandidate(proposal, `Tests ${lastTest.passed}/${lastTest.total}: ${lastTest.failures.slice(0, 2).join(' | ')}`)
    const candidate: ForgeCandidate = {
        code: checked.code, codeHash: checked.codeHash, manifest: checked.manifest, tests: checked.tests, parameters: checked.parameters,
        lastTest, reason: clip(reason, 200), createdAt: nowIso(),
    }
    const impact = checked.manifest.wirkung
    const trusted = impact === 'schreibend' && (() => {
        const verdict = evaluateActionWithTrust({ kind: 'werkzeug-schreibend', origin: 'code' })
        return verdict.decision === 'auto' && verdict.trusted
    })()
    // Without a working version there is nothing to keep running: the candidate takes over directly.
    if (impact === 'lesend' || trusted || proposal.status !== 'active') {
        mutate(proposal.id, item => promoteCandidate(item, candidate))
        const decided = await decideActivation(proposal.id)
        if (decided) notify('neue-version', `Werkzeug ${forgeToolName(decided)} v${decided.version} gebaut (${decided.status})`, decided)
        return { proposal: decided, message: `neue Version v${decided?.version}` }
    }
    // Writing/external/physical: the active version keeps running until the owner approves exactly this code.
    const waiting = await requestCandidateApproval(proposal, candidate, cardKindFor(impact)!)
    if (waiting) notify('freigabe', `Werkzeug ${forgeToolName(waiting)}: neue Version wartet auf Freigabe (${impact}); v${waiting.version} bleibt aktiv`, waiting)
    return { proposal: waiting, message: `neue Version wartet auf Freigabe — v${proposal.version} bleibt aktiv` }
}

async function requestCandidateApproval(proposal: SkillProposal, candidate: ForgeCandidate, kind: CardKind): Promise<SkillProposal | null> {
    await registerForgeCardExecutors()
    const { createApprovalCard } = await import('../core/approval-cards.js')
    const created = createApprovalCard({
        art: kind,
        titel: `Neue Version von ${forgeToolName(proposal)} aktivieren?`,
        beleg: `v${proposal.version + 1} (aktiv bleibt v${proposal.version}) · Wirkung ${candidate.manifest.wirkung} · Hosts: ${candidate.manifest.net.join(', ') || 'keine'} · Dateien: ${candidate.manifest.fs.join(', ') || 'keine'} · Tests ${candidate.lastTest.passed}/${candidate.lastTest.total} grün · sha ${candidate.codeHash.slice(0, 12)}`,
        vorschlag: `${proposal.description} — Anlass: ${candidate.reason}`,
        aktion: { kind, ref: proposal.id },
        wirkung: candidate.manifest.wirkung === 'extern' ? 'extern' : candidate.manifest.wirkung === 'physisch' ? 'physisch' : 'intern',
        quelle: 'werkzeuge',
        dedupeKey: `werkzeug:${proposal.id}:${candidate.codeHash.slice(0, 16)}`,
    })
    if (!created.ok) return discardCandidate(proposal, `keine Karte möglich: ${(created as { reason?: string }).reason}`).proposal
    return mutate(proposal.id, item => { item.candidate = { ...candidate, cardId: created.card.id } })
}

/** Owner gibt die wartende neue Version frei: sie ersetzt die aktive. */
function approveCandidate(id: string, by: string): SkillProposal | null {
    const before = getForgeTool(id)
    if (!before?.candidate) return null
    const candidate = before.candidate
    mutate(id, item => {
        promoteCandidate(item, candidate)
        item.approvedHash = item.codeHash
        evidence(item, 'owner-freigabe', `owner:${clip(by, 80)}`)
    })
    const active = activate(id, `Owner-Freigabe neue Version (${clip(by, 40)})`)
    if (active && active.manifest.wirkung === 'schreibend') {
        try { recordActionOutcome('werkzeug-schreibend', { ok: true, approvedByOwner: true }) } catch { /* trust ladder optional */ }
    }
    return active
}

// ---------------------------------------------------------------------------
// Ausführung aktiver Werkzeuge (nur im Sandbox-Kind)
// ---------------------------------------------------------------------------

let permissionResolver: ((params: Record<string, unknown>) => Promise<string>) | null = null
/** Tests setzen hier die Rolle des Aufrufers; Standard: Ausführungskontext + Benutzerrolle. */
export function setForgePermissionResolver(resolver: typeof permissionResolver): void { permissionResolver = resolver }

async function callerPermission(params: Record<string, unknown>): Promise<string> {
    if (permissionResolver) return permissionResolver(params)
    try {
        const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
        const context = getExecutionPolicyContext()
        const authUserId = String(context.authUserId || params.authorizationUserId || '').trim()
        if (!authUserId) return 'guest'
        const { getUserPermission } = await import('../users/multi-user-middleware.js')
        return getUserPermission(authUserId, String(context.channel || params.channel || '') || undefined)
    } catch { return 'guest' }
}

function recordRun(id: string, ok: boolean, error?: string): SkillProposal | null {
    return mutate(id, item => {
        item.counters.calls++
        item.counters.lastUsedAt = nowIso()
        if (ok) { item.counters.successes++; item.counters.consecutiveFailures = 0; item.counters.lastError = undefined }
        else { item.counters.failures++; item.counters.consecutiveFailures++; item.counters.lastError = clip(error, 300) }
    })
}

async function handleRepeatedFailure(proposal: SkillProposal): Promise<void> {
    await unregisterForgeTool(proposal).catch(() => undefined)
    if (forgeModel && !isAutonomyWorker()) {
        mutate(proposal.id, item => { item.status = 'degraded'; item.activationBlockedReason = `${DISABLE_AFTER_FAILURES} Fehlschläge in Folge — neue Version wird gebaut` })
        void reviseTool(proposal.id, proposal.counters.lastError || 'Fehlschlag', { mode: 'reparatur' }).catch(() => undefined)
        return
    }
    const off = mutate(proposal.id, item => { item.status = 'disabled'; item.disabledReason = `${DISABLE_AFTER_FAILURES} Fehlschläge in Folge (kein Lern-Modell für eine neue Version)` })
    if (off) notify('aus', `Werkzeug ${forgeToolName(off)} abgeschaltet (${DISABLE_AFTER_FAILURES} Fehlschläge in Folge)`, off)
}

export async function runForgeTool(id: string, rawParams: Record<string, unknown>): Promise<Record<string, unknown>> {
    const proposal = getForgeTool(id)
    if (!proposal || proposal.status !== 'active') return { success: false, error: `Werkzeug ist nicht aktiv (${proposal?.status || 'unbekannt'})` }
    const support = sandboxSupport()
    if (!support.ok) return { success: false, error: support.reason }
    const permission = await callerPermission(rawParams)
    const allowed = proposal.manifest.wirkung === 'lesend' ? permission === 'owner' || permission === 'admin' : permission === 'owner'
    if (!allowed) return { success: false, error: `${forgeToolName(proposal)}: nur der Owner darf dieses Werkzeug nutzen` }
    const params = Object.fromEntries(Object.entries(rawParams || {}).filter(([key]) => !INJECTED_PARAMS.has(key)))
    if (proposal.manifest.wirkung === 'extern' || proposal.manifest.wirkung === 'physisch') {
        // One owner code per exact call (P9 approvals: codes are always bound to a detail).
        const { ownerApprovalRefusal, approvalDetailOf } = await import('./owner-approval.js')
        const refusal = await ownerApprovalRefusal(rawParams, forgeToolName(proposal), approvalDetailOf(params))
        if (refusal) return { success: false, error: refusal, needsApproval: true }
    }
    const result = await runInForgeSandbox({
        code: proposal.code, params, manifest: proposal.manifest, timeoutMs: 20_000,
        fetchHandler: createManifestFetch(proposal.manifest), readFileHandler: createManifestReadFile(proposal.manifest),
    })
    const after = recordRun(proposal.id, result.ok, result.error)
    if (!result.ok && after && after.counters.consecutiveFailures >= DISABLE_AFTER_FAILURES) await handleRepeatedFailure(after)
    return result.ok
        ? { success: true, werkzeug: forgeToolName(proposal), version: proposal.version, result: result.value }
        : { success: false, werkzeug: forgeToolName(proposal), error: result.error }
}

// ---------------------------------------------------------------------------
// Registrierung im Tool-Register
// ---------------------------------------------------------------------------

interface RegistryLike { register(tool: NovaTool): void; unregister(name: string): boolean; get(name: string): NovaTool | undefined }
let injectedRegistry: RegistryLike | null = null
export function setForgeRegistry(registry: RegistryLike | null): void { injectedRegistry = registry }

async function registryOf(): Promise<RegistryLike | null> {
    if (injectedRegistry) return injectedRegistry
    if (sideEffectsDisabled()) return null
    const { getToolRegistry } = await import('./complete-registry.js')
    return getToolRegistry()
}

function toNovaTool(proposal: SkillProposal): NovaTool {
    const asks = proposal.manifest.wirkung === 'extern' || proposal.manifest.wirkung === 'physisch'
    return {
        name: forgeToolName(proposal),
        description: `[Werkzeug-Schmiede v${proposal.version} · ${proposal.manifest.wirkung}${asks ? ' · fragt bei jedem Aufruf' : ''}] ${proposal.description}`,
        category: 'other',
        parameters: proposal.parameters,
        handler: params => runForgeTool(proposal.id, params),
    }
}

export async function registerForgeTool(proposal: SkillProposal): Promise<void> {
    const registry = await registryOf()
    if (!registry || proposal.status !== 'active') return
    registry.register(toNovaTool(proposal))
}

export async function unregisterForgeTool(proposal: Pick<SkillProposal, 'name'>): Promise<void> {
    const registry = await registryOf()
    registry?.unregister(forgeToolName(proposal))
}

/** Beim Start: alle aktiven Werkzeuge registrieren. */
export async function registerActiveForgeTools(): Promise<number> {
    const active = readAll().filter(item => item.status === 'active')
    for (const proposal of active) await registerForgeTool(proposal)
    return active.length
}

// ---------------------------------------------------------------------------
// Karten (Aktivierung schreibend/extern/physisch)
// ---------------------------------------------------------------------------

let executorsRegistered = false
export async function registerForgeCardExecutors(): Promise<void> {
    if (executorsRegistered) return
    const { registerCardExecutor, getCardExecutor } = await import('../core/approval-cards.js')
    for (const [kind, impact] of [['werkzeug-schreibend', 'intern'], ['werkzeug-extern', 'extern'], ['werkzeug-physisch', 'physisch']] as const) {
        if (getCardExecutor(kind)) continue
        registerCardExecutor({
            kind, impact,
            async execute(card, _answer, ctx) {
                const proposal = getForgeTool(card.aktion.ref)
                if (proposal?.candidate?.cardId === card.id) {
                    const promoted = approveCandidate(card.aktion.ref, ctx.decidedBy)
                    return promoted?.status === 'active'
                        ? { ok: true, message: `Werkzeug ${forgeToolName(promoted)} v${promoted.version} aktiv (neue Version)` }
                        : { ok: false, message: `Neue Version nicht aktiviert (${promoted?.status || 'unbekannt'})` }
                }
                if (!proposal || proposal.cardId !== card.id) return { ok: false, message: 'Werkzeug hat sich inzwischen geändert — keine Aktivierung' }
                const active = approveSkillProposal(card.aktion.ref, ctx.decidedBy)
                return active?.status === 'active'
                    ? { ok: true, message: `Werkzeug ${forgeToolName(active)} v${active.version} aktiv` }
                    : { ok: false, message: `Werkzeug nicht aktiviert (${active?.status || 'unbekannt'})` }
            },
            async reject(card, ctx) {
                const current = getForgeTool(card.aktion.ref)
                if (current?.candidate?.cardId === card.id) {
                    // Rejecting a new version never switches off the working one.
                    const kept = mutate(current.id, item => { item.candidate = undefined; evidence(item, 'kandidat-abgelehnt', `owner:${clip(ctx.decidedBy, 80)}`) })
                    return { ok: true, message: `Neue Version von ${forgeToolName(current)} abgelehnt — v${kept?.version ?? current.version} bleibt aktiv` }
                }
                const rejected = rejectSkillProposal(card.aktion.ref, ctx.decidedBy)
                return { ok: Boolean(rejected), message: rejected ? `Werkzeug ${forgeToolName(rejected)} abgelehnt` : 'Werkzeug nicht gefunden' }
            },
            isStillOpen(card) {
                const proposal = getForgeTool(card.aktion.ref)
                if (proposal?.candidate?.cardId === card.id) return proposal.status === 'active'
                return Boolean(proposal && proposal.status === 'awaiting-approval' && proposal.cardId === card.id)
            },
        })
    }
    executorsRegistered = true
}

// ---------------------------------------------------------------------------
// Bedarfs-Hook (message-pipeline, neben finishRoutineSkillRun)
// ---------------------------------------------------------------------------

export type ForgeNeedKind = 'owner-wunsch' | 'fehlendes-werkzeug' | 'wiederholung'
export interface ForgeNeedContext {
    principalId: string
    permission?: string
    isGroup?: boolean
    systemAuthored?: boolean
    request: string
    toolExecutions?: ReadonlyArray<{ toolName?: string; success?: boolean; error?: unknown; result?: unknown }>
    routineSkillCreated?: { id?: string; name: string; steps: ReadonlyArray<{ tool: string }> } | null
}

const OWNER_WISH = /\b(bau|baue|bastel|bastle|erstell|erstelle|schreib|programmier)\w*\b[^.?!\n]{0,40}\b(werkzeug|tool)\b/i
const MISSING_TOOL = /Tool nicht gefunden: ([A-Za-z0-9_.-]{2,80})/
/** Allgemeine Werkzeuge, deren wiederholte Nutzung ein eigenes Werkzeug lohnt. */
const GENERIC_TOOLS = new Set(['execute_python', 'run_command', 'shell_exec', 'system_executor', 'fetch_url', 'read_url', 'http_request', 'web_fetch'])
const NEED_WINDOW_MS = 7 * 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
/** Ein Limit für alle Bauten: Bedarf, Owner-Wunsch und neue Versionen (`reviseTool`). */
const MAX_BUILDS_PER_DAY = 3
const OUTSIDE_CONTRACT = /outside the offered contract(?: after one correction)?: ([A-Za-z0-9_.,\s-]+)/

export interface MissingToolFailure { callId: string; toolName: string; params: Record<string, unknown>; result: string; success: false; timestamp: number }

/**
 * 2.84.0: Hat das Modell-Gate einen Lauf gestoppt, weil das Modell ein nicht
 * angebotenes Werkzeug wollte, wird jedes davon, das in KEINEM Register
 * steht, ein fehlgeschlagener Eintrag „Tool nicht gefunden: x“. Ein
 * vorhandenes, nur nicht angebotenes Werkzeug ist kein Bedarf.
 */
export function missingToolFailures(error: unknown, isKnown: (name: string) => boolean, now = Date.now()): MissingToolFailure[] {
    const err = error as { message?: unknown; cause?: { message?: unknown } } | null | undefined
    const text = `${String(err?.message ?? error ?? '')} ${String(err?.cause?.message ?? '')}`
    const match = text.match(OUTSIDE_CONTRACT)
    if (!match) return []
    const names = [...new Set(match[1].split(',').map(name => name.trim()).filter(name => /^[A-Za-z][A-Za-z0-9_.-]{1,79}$/.test(name)))]
    return names.filter(name => { try { return !isKnown(name) } catch { return false } }).slice(0, 5).map(name => ({
        callId: `fehlt:${name}`, toolName: name, params: {}, result: `Tool nicht gefunden: ${name}`, success: false, timestamp: now,
    }))
}

export function detectForgeNeed(ctx: ForgeNeedContext): { kind: ForgeNeedKind; detail: string; adoptFor?: ForgeAdoptTarget } | null {
    if (OWNER_WISH.test(ctx.request || '')) return { kind: 'owner-wunsch', detail: clip(ctx.request, 300) }
    for (const execution of ctx.toolExecutions || []) {
        if (execution?.success !== false) continue
        const text = `${String(execution.error ?? '')} ${typeof execution.result === 'string' ? execution.result : JSON.stringify(execution.result ?? '')}`
        const match = text.match(MISSING_TOOL)
        if (match) return { kind: 'fehlendes-werkzeug', detail: `fehlt: ${match[1]}` }
    }
    const generic = ctx.routineSkillCreated?.steps.find(step => GENERIC_TOOLS.has(step.tool))
    if (generic) {
        const adoptFor = adoptTarget({ skillId: ctx.routineSkillCreated!.id, from: generic.tool })
        return { kind: 'wiederholung', detail: `Routine „${clip(ctx.routineSkillCreated!.name, 80)}“ nutzt immer wieder ${generic.tool}`, ...(adoptFor ? { adoptFor } : {}) }
    }
    return null
}

interface NeedFile { version: 1; needs: Array<{ signature: string; kind: ForgeNeedKind | 'neue-version'; at: string; built: boolean; skillId?: string; from?: string; missingTool?: string }> }
const needFile = () => getNovaDataDir('forge', 'bedarf.json')
function readNeeds(): NeedFile {
    try { const raw = JSON.parse(readFileSync(needFile(), 'utf8')); return raw?.version === 1 && Array.isArray(raw.needs) ? raw : { version: 1, needs: [] } } catch { return { version: 1, needs: [] } }
}
/**
 * 2.85: the names of missing tools of the last needs (no request text) — read by the
 * Software-Scout as a need signal (`software-demand.ts`), e.g. a missing OCR tool = vision.
 */
export function forgeMissingToolNeeds(): Array<{ tool: string; at: string }> {
    return readNeeds().needs.filter(item => item.kind === 'fehlendes-werkzeug' && typeof item.missingTool === 'string')
        .map(item => ({ tool: item.missingTool!, at: item.at }))
}
const buildsWithinDay = (file: NeedFile, now: number) => file.needs.filter(item => item.built && now - Date.parse(item.at) < DAY_MS).length

/** Wie viele Bauten (Bedarf + neue Versionen) heute noch gehen. */
export function forgeBuildsLeftToday(now = Date.now()): number {
    return Math.max(0, MAX_BUILDS_PER_DAY - buildsWithinDay(readNeeds(), now))
}

/** Einen Bau im gemeinsamen Tageslimit vermerken; false = Limit erreicht. */
function reserveBuild(signature: string, kind: 'neue-version', now: number): boolean {
    const file = readNeeds()
    file.needs = file.needs.filter(item => now - Date.parse(item.at) < NEED_WINDOW_MS)
    if (buildsWithinDay(file, now) >= MAX_BUILDS_PER_DAY) return false
    file.needs.push({ signature, kind, at: new Date(now).toISOString(), built: true })
    atomicWriteJsonSync(needFile(), file)
    return true
}

/** Eine auf morgen gelegte neue Version nachholen (ruhige Owner-Runde, Limit frei). */
function resumeDeferredRevision(now: number): void {
    if (!forgeModel || forgeBuildsLeftToday(now) <= 0) return
    const due = readAll().find(item => item.pendingRevision && Date.parse(item.pendingRevision.notBefore) <= now && item.status !== 'rejected' && item.status !== 'disabled')
    if (!due?.pendingRevision) return
    const { mode, reason } = due.pendingRevision
    void reviseTool(due.id, reason, { mode, now: () => now }).catch(() => undefined)
}

/**
 * Nach einem Owner-Lauf: fehlt ein Werkzeug, wiederholt sich ein allgemeiner
 * Ablauf oder wünscht der Owner eines? Dann wird (im Hintergrund) gebaut.
 */
export function noteForgeNeed(ctx: ForgeNeedContext, options: { allowInTests?: boolean; now?: () => number; onBuilt?: (result: BuildResult) => void } = {}): { queued: boolean; reason: string; kind?: ForgeNeedKind } {
    if (ctx.permission !== 'owner' || ctx.isGroup || ctx.systemAuthored) return { queued: false, reason: 'nur Owner im Direktgespräch' }
    if (isAutonomyWorker()) return { queued: false, reason: 'Worker bauen nichts' }
    if (sideEffectsDisabled() && !options.allowInTests) return { queued: false, reason: 'Nebenwirkungen aus' }
    const need = detectForgeNeed(ctx)
    const now = (options.now || Date.now)()
    if (!need) {
        resumeDeferredRevision(now)
        return { queued: false, reason: 'kein Bedarf' }
    }
    const signature = createHash('sha256').update(`${ctx.principalId}\0${need.kind}\0${need.detail.toLowerCase()}`).digest('hex').slice(0, 24)
    const file = readNeeds()
    file.needs = file.needs.filter(item => now - Date.parse(item.at) < NEED_WINDOW_MS)
    if (file.needs.some(item => item.signature === signature)) return { queued: false, reason: 'Bedarf schon bearbeitet', kind: need.kind }
    if (buildsWithinDay(file, now) >= MAX_BUILDS_PER_DAY) return { queued: false, reason: `Tageslimit ${MAX_BUILDS_PER_DAY} Werkzeug-Bauten erreicht`, kind: need.kind }
    const canBuild = forgeModel !== null
    const missingTool = need.kind === 'fehlendes-werkzeug' ? /^fehlt: ([A-Za-z0-9_.-]{2,80})$/.exec(need.detail)?.[1] : undefined
    file.needs.push({ signature, kind: need.kind, at: new Date(now).toISOString(), built: canBuild, ...(missingTool ? { missingTool } : {}), ...(need.adoptFor ? { skillId: need.adoptFor.skillId, from: need.adoptFor.from } : {}) })
    atomicWriteJsonSync(needFile(), file)
    if (!canBuild) {
        notify('bedarf', `Werkzeug-Bedarf erkannt (${need.kind}: ${need.detail}), aber kein lokales Lern-Modell — nichts gebaut`)
        return { queued: false, reason: 'kein lokales Lern-Modell', kind: need.kind }
    }
    void (async () => {
        const draft = await generateToolDraft({ request: `${ctx.request}\n(${need.kind}: ${need.detail})`, ownerId: ctx.principalId, origin: need.kind === 'owner-wunsch' ? 'owner' : 'bedarf' })
        const result = await buildTool({ ...draft, why: draft.why || need.detail, ...(need.adoptFor ? { adoptFor: need.adoptFor } : {}) })
        options.onBuilt?.(result)
        if (!result.proposal || result.proposal.status !== 'active') notify('fehler', `Werkzeug-Bau (${need.kind}): ${result.message}`.slice(0, 300), result.proposal || undefined)
    })().catch(error => {
        options.onBuilt?.({ proposal: null, message: String((error as Error)?.message || error) })
        notify('fehler', `Werkzeug-Bau (${need.kind}) gescheitert: ${clip((error as Error)?.message || error, 200)}`)
    })
    return { queued: true, reason: need.detail, kind: need.kind }
}

// ---------------------------------------------------------------------------
// /werkzeuge (Einblick) und Start
// ---------------------------------------------------------------------------

const STATUS_MARK: Record<SkillForgeStage, string> = {
    proposed: '📝', tested: '🧪', 'awaiting-approval': '🔘', active: '✅', degraded: '🛠️', disabled: '⏸️', rejected: '🚫',
}

export function formatForgeTool(proposal: SkillProposal): string {
    const c = proposal.counters
    const lines = [
        `${STATUS_MARK[proposal.status]} *${forgeToolName(proposal)}* v${proposal.version} · ${proposal.status} · ${proposal.manifest.wirkung}`,
        `  ${proposal.description}`,
        `  Netz: ${proposal.manifest.net.join(', ') || '—'} · Dateien: ${proposal.manifest.fs.join(', ') || '—'}`,
        `  Tests: ${proposal.lastTest ? `${proposal.lastTest.passed}/${proposal.lastTest.total}` : 'noch nicht'} · Aufrufe ${c.calls} (ok ${c.successes}, Fehler ${c.failures})`,
    ]
    if (proposal.activationBlockedReason) lines.push(`  ⏳ ${proposal.activationBlockedReason}`)
    if (proposal.disabledReason) lines.push(`  ⏸️ ${proposal.disabledReason}`)
    return lines.join('\n')
}

export async function handleWerkzeugeCommand(args: string, ctx: { principalId: string; permission?: string }): Promise<string> {
    const [sub, ...rest] = String(args || '').trim().split(/\s+/).filter(Boolean)
    const support = sandboxSupport()
    if (sub === 'aus' || sub === 'an') {
        if (ctx.permission !== 'owner') return '🔒 Nur der Owner schaltet Werkzeuge.'
        const changed = await setForgeToolEnabled(rest[0] || '', sub === 'an', ctx.principalId)
        return changed ? `🧰 ${forgeToolName(changed)}: ${changed.status}` : `❌ Werkzeug nicht gefunden: ${rest[0] || '(kein Name)'}`
    }
    if (sub === 'bau') {
        if (ctx.permission !== 'owner') return '🔒 Nur der Owner lässt Werkzeuge bauen.'
        const request = rest.join(' ').trim()
        if (!request) return 'Beispiel: /werkzeuge bau Wechselkurs EUR→CHF von frankfurter.app holen'
        if (!support.ok) return `❌ ${support.reason}`
        if (!forgeModel) return '❌ Kein lokales Lern-Modell (serviceModels.learning) erreichbar — ich baue kein Werkzeug mit einem Cloud-Modell.'
        try {
            const draft = await generateToolDraft({ request, ownerId: ctx.principalId, origin: 'owner' })
            return (await buildTool(draft)).message
        } catch (error) { return `❌ Werkzeug-Bau gescheitert: ${clip((error as Error)?.message || error, 300)}` }
    }
    if (sub) {
        const tool = getForgeTool(sub)
        if (!tool) return `❌ Werkzeug nicht gefunden: ${sub}`
        const history = tool.history.map(item => `v${item.version} (${item.reason})`).join(', ')
        return `${formatForgeTool(tool)}\n  sha ${tool.codeHash.slice(0, 16)} · Herkunft ${tool.origin}${history ? ` · frühere Versionen: ${history}` : ''}${tool.lastTest?.failures.length ? `\n  Testfehler: ${tool.lastTest.failures.slice(0, 3).join(' | ')}` : ''}`
    }
    const tools = getSkillProposals(100)
    const header = `🧰 *Werkzeug-Schmiede* (${tools.filter(item => item.status === 'active').length} aktiv)${support.ok ? '' : `\n⚠️ ${support.reason}`}${forgeModel ? '' : '\n⚠️ Kein lokales Lern-Modell — gebaut wird nur mit build_skill'}`
    if (tools.length === 0) return `${header}\n\nNoch keine Werkzeuge. Bauen: /werkzeuge bau <was es tun soll>`
    return `${header}\n\n${tools.map(formatForgeTool).join('\n\n')}\n\n/werkzeuge <name> · /werkzeuge aus|an <name> · /werkzeuge bau <beschreibung>`
}

/** Daemon-Start: Lern-Modell setzen, Karten-Ausführer und aktive Werkzeuge registrieren. */
export async function initToolForge(options: { learningModel?: ForgeModel | null } = {}): Promise<{ active: number; support: ReturnType<typeof sandboxSupport>; legacyToolsIgnored: number }> {
    setForgeModel(options.learningModel ?? null)
    await registerForgeCardExecutors()
    const support = sandboxSupport()
    const active = support.ok ? await registerActiveForgeTools() : 0
    // Der alte Lader für .nova-tools/*.json (new Function im Daemon) ist entfernt.
    let legacyToolsIgnored = 0
    try {
        const { readdirSync } = await import('node:fs')
        const legacyDir = resolve(getRuntimeRoot(), '.nova-tools')
        if (existsSync(legacyDir)) legacyToolsIgnored = readdirSync(legacyDir).filter(file => file.endsWith('.json')).length
    } catch { legacyToolsIgnored = 0 }
    return { active, support, legacyToolsIgnored }
}

// ---------------------------------------------------------------------------
// Werkzeuge für das Modell
// ---------------------------------------------------------------------------

function parseJson<T>(value: unknown, fallback: T): T {
    if (value === undefined || value === null || value === '') return fallback
    if (typeof value !== 'string') return value as T
    return JSON.parse(value) as T
}

export const buildSkillTool: NovaTool = {
    name: 'build_skill',
    description: 'Baut ein neues Werkzeug in der Werkzeug-Schmiede: ESM-Code (export default async function (params, ctx)), Manifest (net-Hosts, fs-Pfade, wirkung lesend|schreibend|extern|physisch) und Testfälle als Daten. Läuft nur in der Sandbox; lesend + Tests grün wird selbst aktiv, sonst Freigabe-Karte.',
    category: 'other',
    parameters: [
        { name: 'name', type: 'string', description: 'Werkzeug-Name in snake_case (wird als forge_<name> registriert)', required: true },
        { name: 'description', type: 'string', description: 'Was das Werkzeug tut', required: true },
        { name: 'why', type: 'string', description: 'Welche Lücke es schließt', required: true },
        { name: 'code', type: 'string', description: 'ESM: export default async function (params, ctx) { … } — Netz nur ctx.fetch, Dateien nur ctx.readFile', required: true },
        { name: 'manifest', type: 'string', description: 'JSON {"net":["host"],"fs":["/pfad"],"wirkung":"lesend|schreibend|extern|physisch"}', required: true },
        { name: 'tests', type: 'string', description: 'JSON-Array von Testfällen {name, params, fetch?:[{url,status,body}], expect:{equals|contains|type|keys|throws}}', required: true },
        { name: 'parameters', type: 'string', description: 'JSON-Array typisierter Parameter', required: false },
    ],
    handler: async params => {
        try {
            const result = await buildTool({
                name: String(params.name || ''), description: String(params.description || ''), why: String(params.why || ''), code: String(params.code || ''),
                manifest: parseJson<ForgeManifest>(params.manifest, { net: [], fs: [], wirkung: 'lesend' }),
                tests: parseJson<ForgeTestCase[]>(params.tests, []),
                parameters: parseJson<ForgeParameter[]>(params.parameters, []),
                ownerId: String(params.authorizationUserId || 'nova-self'), origin: 'build_skill',
            })
            return result.message
        } catch (error) { return `❌ Werkzeug-Entwurf abgelehnt: ${clip((error as Error)?.message || error, 400)}` }
    },
}

export const createSkillTool: NovaTool = {
    name: 'create_skill',
    description: 'Lässt das lokale Lern-Modell aus einer Beschreibung ein Werkzeug bauen (Code, Manifest, Tests) und prüft es in der Werkzeug-Schmiede. Kein Cloud-Modell.',
    category: 'learning',
    parameters: [
        { name: 'name', type: 'string', description: 'Name-Vorschlag (snake_case)', required: true },
        { name: 'description', type: 'string', description: 'Was das Werkzeug tun soll', required: true },
        { name: 'examples', type: 'string', description: 'Beispiele und erwartete Ergebnisse', required: false },
    ],
    handler: async params => {
        if (!forgeModel) return { message: '❌ Kein lokales Lern-Modell erreichbar — Werkzeug wird nicht gebaut (kein Cloud-Ersatz).' }
        try {
            const draft = await generateToolDraft({
                request: `${String(params.description || '')}${params.examples ? `\nBeispiele: ${String(params.examples)}` : ''}`,
                nameHint: String(params.name || ''), ownerId: String(params.authorizationUserId || 'nova-self'), origin: 'create_skill',
            })
            return { message: (await buildTool(draft)).message }
        } catch (error) { return { message: `❌ Werkzeug-Bau gescheitert: ${clip((error as Error)?.message || error, 300)}` } }
    },
}

export const listSkillsTool: NovaTool = {
    name: 'list_skills',
    description: 'Zeigt die Werkzeuge der Werkzeug-Schmiede mit Status, Wirkung, Version und Zählern.',
    category: 'learning',
    parameters: [],
    handler: async () => ({ message: await handleWerkzeugeCommand('', { principalId: 'tool', permission: 'user' }) }),
}

export const deleteSkillTool: NovaTool = {
    name: 'delete_skill',
    description: 'Schaltet ein Werkzeug der Werkzeug-Schmiede ab (nichts wird gelöscht).',
    category: 'learning',
    parameters: [{ name: 'name', type: 'string', description: 'Werkzeug-Name', required: true }],
    handler: async params => {
        if (await callerPermission(params) !== 'owner') return { message: '🔒 Nur der Owner schaltet Werkzeuge ab.' }
        const off = await setForgeToolEnabled(String(params.name || ''), false, 'owner')
        return { message: off ? `⏸️ ${forgeToolName(off)} abgeschaltet.` : `❌ Werkzeug "${String(params.name || '')}" nicht gefunden.` }
    },
}
