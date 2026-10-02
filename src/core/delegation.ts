/**
 * Delegation an Unteragenten (Autonomie-Plan Phase 6e, Dots-Parität).
 *
 * Xaventra gives a bounded task to another agent and later checks the result
 * herself:
 *
 *   import { delegate, onDelegationSettled } from './core/delegation.js'
 *   const result = await delegate({
 *       to: 'claude' | 'codex' | 'hermes' | 'subagent',
 *       auftrag: 'Analysiere, warum der Doctor-Fall 7ba2 wiederkehrt',
 *       kontext: { befund: '…' },            // cleaned: no memory, secrets, customer data
 *       erwartet: { art: 'release-tag', tag: 'v2.82.0' },   // success criterion (see below)
 *       frist: 240,                          // minutes, or an ISO instant
 *       missionId: 'm-…',                    // optional, reported back to the listener
 *   })
 *   // -> { ok: true, record } | { ok: false, reason }
 *   onDelegationSettled((record, { verified }) => { … })   // missions mark their step here
 *
 * Fixed rules (code, not config):
 * - The delegation id (`dlg-<12 hex>`), the thread id and every timestamp are
 *   generated here, never taken from a caller or an answer.
 * - Level: L1 (sent at once) for reading/analysing tasks; L2 (Knopf-Karte,
 *   sent only after the owner's Ja) as soon as the task asks for changes to
 *   systems. The classification can only raise the level (`aendert: true`),
 *   never lower it. Nie-Liste topics are refused, even as a card.
 * - Ways: `subagent` runs the existing orchestrator locally with a read-only
 *   tool list; claude/codex/hermes go as an Agentic-OS message
 *   (`POST <url>/messages`, same URL as `autonomy.claudeHandoff.url` unless
 *   `autonomy.delegation.url` is set).
 * - Rückkanal: `GET <url>/agent_registry/<NOVA>/inbox`. Only messages with the
 *   delegation's exact thread id, addressed to NOVA and sent by the agent the
 *   task went to are taken. Their text is UNTRUSTED data: it is stored as the
 *   answer and evidence, never executed, never turned into a tool call, a card
 *   or a new delegation. Only `metadata.status` (angenommen/fertig/abgelehnt)
 *   and `metadata.beleg` are read; any other field (new goal, rights, criteria,
 *   deadline, mission) is ignored and listed in `ignoriert`.
 * - The result is verified against `erwartet` by a read-only check chosen by
 *   Nova's own criterion (`release-tag`: GitHub release exists and is not a
 *   draft; `ci-gruen`: every Actions run of the commit succeeded). Anything
 *   else stays `unverifiziert`. Only `verifiziert` closes a mission step.
 * - Deadline: an open delegation past `fristAt` becomes `abgelaufen` and
 *   leaves a thought.
 * - P8: on at the Main by default (`autonomy.delegation.enabled=false` = off). A mesh worker
 *   (`NOVA_NODE_ONLY=true`) never delegates and never polls.
 * - P9: polling only runs while delegations are open (armed by delegate(), stopped by the
 *   tick that finds none). Callers: Missions-Schritt `delegieren` (core/missions.ts via
 *   responsibility-runtime) and Auftrags-Schritte with `an` (core/autonomous-executor.ts).
 *   Not to be confused with the mesh `delegateTask` (user text: „an Knoten übergeben“).
 *
 * Files: `<data>/delegation/delegations.json` { version: 1, records }.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { defaultOn } from './autonomy-defaults.js'
import { getNovaDataDir } from './data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type DelegationTarget = 'claude' | 'codex' | 'hermes' | 'subagent'
/** 2.84.0 Punkt 7: `zurueckgezogen` = withdrawn by Xaventra before sending (end state, not open). */
export type DelegationStatus = 'wartet-auf-freigabe' | 'gesendet' | 'angenommen' | 'fertig' | 'abgelaufen' | 'abgelehnt' | 'fehler' | 'zurueckgezogen'
export type DelegationLevel = 'L1' | 'L2'
export type VerificationResult = 'verifiziert' | 'nicht-erfuellt' | 'unverifiziert'

/** Success criterion. Only these fields are kept; the check is chosen by `art`. */
export interface Expectation {
    art: string
    tag?: string
    sha?: string
    repo?: string
    text?: string
}

export interface DelegationRequest {
    to: DelegationTarget
    auftrag: string
    kontext?: string | Record<string, unknown>
    erwartet: Expectation
    /** Minutes from now, or an ISO instant. Default `defaultFristMinutes`. */
    frist?: number | string
    missionId?: string
    /** Declared by the caller: the task changes systems (raises to L2). */
    aendert?: boolean
    /**
     * Owner approval that was already given for exactly this task (a mission
     * step card answered Ja). Only code paths that hold such an answer pass it;
     * an L2 task then goes out without a second card and records who approved.
     */
    freigabeVon?: string
}

export interface DelegationAnswer {
    text: string
    at: string
    from: string
    messageId: string
    untrusted: true
}

export interface DelegationRecord {
    id: string
    to: DelegationTarget
    agent: string
    threadId: string
    auftrag: string
    kontext: string
    kontextEntfernt: string[]
    erwartet: Expectation
    missionId?: string
    stufe: DelegationLevel
    stufeGrund: string
    status: DelegationStatus
    createdAt: string
    updatedAt: string
    fristAt: string
    sentAt?: string
    karteId?: string
    freigabeVon?: string
    antwort?: DelegationAnswer
    beleg?: string
    ignoriert?: string[]
    pruefung?: { ergebnis: VerificationResult; detail: string; at: string }
    fehler?: string
    verlauf: Array<{ at: string; status: DelegationStatus; detail?: string }>
    messageIds: string[]
}

export interface DelegationConfig {
    enabled: boolean
    url: string | null
    fromAgent: string
    agents: Record<Exclude<DelegationTarget, 'subagent'>, string>
    pollSeconds: number
    defaultFristMinutes: number
    maxOpen: number
}

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>
export type VerifierContext = { fetch: FetchLike }
export type Verifier = (expectation: Expectation, ctx: VerifierContext) => Promise<{ ergebnis: VerificationResult; detail: string }>
export type SettledListener = (record: DelegationRecord, info: { verified: boolean }) => void | Promise<void>

interface CardLike { id: string }
type CreateCard = (input: {
    art: string; titel: string; beleg: string; vorschlag: string; aktion: { kind: string; ref: string }
    ablaufMs?: number; dedupeKey?: string; quelle?: string
}) => { ok: true; card: CardLike; created: boolean } | { ok: false; reason: string }

type AddThought = (input: {
    source: string; title: string; kind?: 'ereignis' | 'idee' | 'vorschlag'; evidence?: string
    severity?: 'critical' | 'warning' | 'info'; permission?: 'selbst' | 'fragen' | 'nie'; signature?: string
}) => unknown

type SpawnSubagent = (task: { task: string; tools?: string[]; timeoutMs?: number; systemPrompt?: string }) => Promise<{ status: string; output: string; error?: string }>

export interface DelegationServiceDeps {
    dataDir?: string
    now?: () => number
    config: DelegationConfig
    fetch?: FetchLike
    createCard?: CreateCard
    addThought?: AddThought
    spawnSubagent?: SpawnSubagent
    /** True only on the fenced Main. Default: not a worker and global autonomy authority. */
    authority?: () => boolean | Promise<boolean>
    isWorker?: () => boolean
    verifiers?: Record<string, Verifier>
}

// ---------------------------------------------------------------------------
// fixed rules
// ---------------------------------------------------------------------------

export const DELEGATION_ID_PATTERN = /^dlg-[a-f0-9]{12}$/
const THREAD_PREFIX = 'xaventra-delegation-'
const TARGETS: readonly DelegationTarget[] = ['claude', 'codex', 'hermes', 'subagent']
const OPEN: ReadonlySet<DelegationStatus> = new Set(['wartet-auf-freigabe', 'gesendet', 'angenommen'])
const WAITING_FOR_ANSWER: ReadonlySet<DelegationStatus> = new Set(['gesendet', 'angenommen'])
const MAX_RECORDS = 300
const MIN_FRIST_MS = 5 * 60_000
const MAX_FRIST_MS = 14 * 24 * 60 * 60_000
const DEFAULT_REPO = 'samuelvoltarius/xaventra'
const AGENT_ID = /^[A-Z][A-Z0-9_-]{1,31}$/

/** Read-only tools for a local subagent (no memory, no shell, no writes, no sending). */
export const DELEGATION_SUBAGENT_TOOLS: readonly string[] = Object.freeze([
    'web_search', 'browser_search', 'fetch_url', 'read_url', 'read_file', 'list_directory', 'calculate', 'get_time', 'get_system_info',
])

/** Asks for a change to systems → L2 (card). Raises only. Umlauts handled via \p{L}. */
const CHANGE_RULES: ReadonlyArray<[RegExp, string]> = [
    [/(?<!\p{L})(deploy|ausroll|rollout|roll\w* .{0,20}aus\b|veröffentlich|veroeffentlich|publish|release erstell|erstelle .{0,20}release)/iu, 'ausrollen/veröffentlichen'],
    [/(?<!\p{L})(installier|deinstall|einrichten|richte .{0,30}ein\b|konfigurier)/iu, 'installieren/einrichten'],
    [/(?<!\p{L})(merge\b|mergen|merge |pushe|push\b|pushen|committe|commite|commiten|rebase)/iu, 'Git schreiben'],
    [/(?<!\p{L})(restart|neustart|neu ?start|starte\w* .{0,20}neu|stoppe|stoppen|stop\b|beende|kill)/iu, 'Dienst starten/stoppen'],
    [/(?<!\p{L})(änder|aender|bearbeite|überschreib|ueberschreib|edit\b|editier)/iu, 'ändern'],
    [/(?<!\p{L})(lösch|loesch|delete|entferne|entfernen|remove)/iu, 'löschen/entfernen'],
    [/(?<!\p{L})(fix\b|fixe|fixen|behebe|beheben|reparier|patche|patchen|patch\b|implementier|baue\b|bauen\b|migrier|migrate)/iu, 'Code/System ändern'],
    [/(?<!\p{L})(aktualisier|updaten|upgraden|upgrade\b|setze .{0,30}auf\b)/iu, 'aktualisieren'],
]

/** Nie-Liste topics (STUFENPLAN Feste Grenzen Nr. 1): never delegated, not even as a card. */
const NEVER_RULES: readonly RegExp[] = [
    /(?<!\p{L})(passw|secret|geheimnis|zugangsdaten|credential|api[ -_]?key|private[ -_]?key|token)/iu,
    /(?<!\p{L})(backup|sicherung|rollback-container).{0,40}(lösch|loesch|delete|entfern)|(?<!\p{L})(lösch|loesch|delete|entfern).{0,40}(backup|sicherung|daten)/iu,
    /(?<!\p{L})nas.{0,20}(neustart|neu ?start|reboot|shutdown|herunterfahr)/iu,
    /(?<!\p{L})(db|datenbank).{0,20}(migration|migrier)/iu,
    /(?<!\p{L})(firewall|sudoers|tailscale|ssh-?(config|schlüssel|key))/iu,
    /(?<!\p{L})(kernel|treiber|cuda|dist-upgrade|apt upgrade|curl .{0,40}\|\s*(ba)?sh)/iu,
]

/** Creates, writes, moves, sends, prints, switches, buys or runs something → L2 (card). */
const ACTION_RULES: ReadonlyArray<[RegExp, string]> = [
    [/(?<!\p{L})(erstell|anleg|leg\w* .{0,40}\ban\b|erzeug|create|schreib|write|verschieb|move\b|kopier|copy\b|umbenenn|rename|setz\w* .{0,30}\bum\b|umsetz|ausführ|führ\w* .{0,40}\baus\b|run\b|execute|starte?\b|mach\w*\b|tu\b|erledig)/iu, 'erstellen/schreiben/ausführen'],
    [/(?<!\p{L})(send|schick|versend|antwort\w* .{0,30}\ban\b|beantwort|mail\w*\b .{0,30}\ban\b|poste|posten|veröffentlich)/iu, 'senden/nach außen'],
    [/(?<!\p{L})(druck|print|schalt|einschalt|ausschalt|switch|kauf|bestell|buy|order\b|bezahl|zahl\w*\b|überweis|ueberweis|buch\w*\b)/iu, 'physisch/Kauf'],
]

/** Clearly read-only intent; required for L1. */
const READ_ONLY = /(?<!\p{L})(prüf|pruef|check|analys|analyz|untersuch|lies\b|lese\b|recherchier|research|such|find\w* .{0,40}\bheraus\b|fass\w* .{0,60}\bzusammen\b|zusammenfass|summar|vergleich|compare|erklär|erklaer|explain|bewert|beschreib|review|diagnos|investigat|look up|nachschau)/iu

/**
 * Allowlist, not denylist: only clearly read-only work goes out without a card.
 * Anything unrecognised, any change/action/external/physical verb → L2.
 */
export function classifyDelegationLevel(auftrag: string, declaredChange = false): { stufe: DelegationLevel; grund: string } {
    if (declaredChange) return { stufe: 'L2', grund: 'vom Aufrufer als ändernd erklärt' }
    for (const [pattern, label] of [...CHANGE_RULES, ...ACTION_RULES]) if (pattern.test(auftrag)) return { stufe: 'L2', grund: `Regel: ${label}` }
    if (!READ_ONLY.test(auftrag)) return { stufe: 'L2', grund: 'nicht eindeutig lesend' }
    return { stufe: 'L1', grund: 'lesend/analysierend' }
}

function neverListHit(text: string): boolean {
    return NEVER_RULES.some(pattern => pattern.test(text))
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const clip = (value: unknown, max: number) => redactSecrets(String(value ?? '')).replace(CONTROL, ' ').trim().slice(0, max)

// ---------------------------------------------------------------------------
// context cleaning
// ---------------------------------------------------------------------------

const FORBIDDEN_KEY = /memor|erinnerung|gedächtnis|gedaechtnis|facts|soul|journal|secret|token|passw|credential|api.?key|private|auth|cookie|session|prompt|history|verlauf|kunde|kunden|customer|client|klient|email|e-mail|mail|telefon|phone|adresse|address|iban|konto|account|person|kontakt/i
const MEMORY_LINE = /^.*(MEMORY\.md|facts\.json|SOUL\.md|USER\.md|\.nova-memory|\.nova-vector-memory|\.nova-learning|lancedb|\[memory\]|\[erinnerung\]|\bmemory:|gedächtnis:|gedaechtnis:).*$/gim
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE = /(?<![\w.])(?:\+|00)\d[\d ()/-]{6,}\d/g
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g

/**
 * Cleans what leaves the house: keys that name memory, secrets or customer
 * data are dropped entirely; e-mail addresses, phone numbers, IBANs and
 * memory-file lines are removed from the text; secrets are redacted.
 */
export function sanitizeDelegationContext(kontext: unknown, max = 2_000): { text: string; removed: string[] } {
    const removed = new Set<string>()
    let text: string
    if (kontext && typeof kontext === 'object' && !Array.isArray(kontext)) {
        const lines: string[] = []
        for (const [key, value] of Object.entries(kontext as Record<string, unknown>).slice(0, 30)) {
            const safeKey = String(key).replace(/[^\p{L}\p{N}_ -]/gu, '').slice(0, 40)
            if (!safeKey) continue
            if (FORBIDDEN_KEY.test(safeKey)) { removed.add(`schluessel:${safeKey}`); continue }
            const rendered = typeof value === 'string' ? value : JSON.stringify(value)
            lines.push(`${safeKey}: ${String(rendered ?? '').slice(0, 1_000)}`)
        }
        text = lines.join('\n')
    } else {
        text = String(kontext ?? '')
    }
    const scrub = (pattern: RegExp, label: string, replacement: string) => {
        const next = text.replace(pattern, replacement)
        if (next !== text) removed.add(label)
        text = next
    }
    scrub(MEMORY_LINE, 'gedaechtnis-zeile', '')
    scrub(EMAIL, 'email', '[adresse entfernt]')
    scrub(PHONE, 'telefon', '[nummer entfernt]')
    scrub(IBAN, 'iban', '[iban entfernt]')
    const redacted = redactSecrets(text)
    if (redacted !== text) removed.add('secret')
    text = redacted.replace(CONTROL, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
    return { text, removed: [...removed] }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function validUrl(value: unknown): string | null {
    try {
        const url = new URL(String(value || ''))
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
        return url.toString().replace(/\/$/, '')
    } catch { return null }
}

export function parseDelegationConfig(autonomy: any, env: NodeJS.ProcessEnv = process.env): DelegationConfig {
    const raw = autonomy?.delegation ?? {}
    const agentOf = (value: unknown, fallback: string) => typeof value === 'string' && AGENT_ID.test(value) ? value : fallback
    const number = (value: unknown, fallback: number, min: number, max: number) =>
        Number.isFinite(Number(value)) && Number(value) >= min ? Math.min(max, Math.floor(Number(value))) : fallback
    return {
        enabled: defaultOn(raw.enabled, env),
        url: validUrl(raw.url ?? autonomy?.claudeHandoff?.url),
        fromAgent: agentOf(raw.fromAgent, 'NOVA'),
        agents: {
            claude: agentOf(raw.agents?.claude, 'CLAUDE'),
            codex: agentOf(raw.agents?.codex, 'CODEX'),
            hermes: agentOf(raw.agents?.hermes, 'HERMES'),
        },
        pollSeconds: number(raw.pollSeconds, 120, 30, 3_600),
        defaultFristMinutes: number(raw.defaultFristMinutes, 24 * 60, 5, 14 * 24 * 60),
        maxOpen: number(raw.maxOpen, 20, 1, 100),
    }
}

// ---------------------------------------------------------------------------
// expectations + read-only checks
// ---------------------------------------------------------------------------

const TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,30})?$/
const SHA = /^[a-f0-9]{40}$/
const REPO = /^[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,80}$/

export function normalizeExpectation(raw: unknown): Expectation | null {
    if (!raw || typeof raw !== 'object') return null
    const input = raw as Record<string, unknown>
    const art = String(input.art || '').toLowerCase()
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(art)) return null
    const repo = typeof input.repo === 'string' && REPO.test(input.repo) ? input.repo : undefined
    if (art === 'release-tag') {
        const tag = String(input.tag || '')
        return TAG.test(tag) ? { art, tag, ...(repo ? { repo } : {}) } : null
    }
    if (art === 'ci-gruen') {
        const sha = String(input.sha || '').toLowerCase()
        return SHA.test(sha) ? { art, sha, ...(repo ? { repo } : {}) } : null
    }
    const text = clip(input.text ?? input.beschreibung ?? '', 300)
    return text ? { art, text } : null
}

export function describeExpectation(expectation: Expectation): string {
    if (expectation.art === 'release-tag') return `Release ${expectation.tag} existiert (veröffentlicht, kein Entwurf)${expectation.repo ? ` in ${expectation.repo}` : ''}`
    if (expectation.art === 'ci-gruen') return `alle CI-Läufe für Commit ${expectation.sha?.slice(0, 12)} grün${expectation.repo ? ` in ${expectation.repo}` : ''}`
    return expectation.text || expectation.art
}

const GITHUB_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'xaventra-delegation' }

// 2.82.0: the one release lookup lives with the Release-Wächter (self-update/release-watch.ts).
const releaseTagVerifier: Verifier = async (expectation, { fetch }) => {
    const { lookupReleaseTag } = await import('./self-update/release-watch.js')
    const result = await lookupReleaseTag(String(expectation.tag), { repo: expectation.repo || DEFAULT_REPO, fetcher: fetch as any })
    if (result.state === 'fehlt' || result.state === 'entwurf') return { ergebnis: 'nicht-erfuellt', detail: result.detail }
    if (result.state === 'unbekannt') return { ergebnis: 'unverifiziert', detail: result.detail }
    return { ergebnis: 'verifiziert', detail: result.detail }
}

const ciGreenVerifier: Verifier = async (expectation, { fetch }) => {
    const repo = expectation.repo || DEFAULT_REPO
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs?head_sha=${expectation.sha}&per_page=50`, { method: 'GET', headers: GITHUB_HEADERS, redirect: 'error' })
    if (!response.ok) return { ergebnis: 'unverifiziert', detail: `GitHub HTTP ${response.status}` }
    const body = await response.json()
    const runs: any[] = Array.isArray(body?.workflow_runs) ? body.workflow_runs : []
    if (!runs.length) return { ergebnis: 'unverifiziert', detail: 'keine CI-Läufe für diesen Commit gefunden' }
    const running = runs.filter(run => run?.status !== 'completed')
    if (running.length) return { ergebnis: 'unverifiziert', detail: `${running.length} Lauf/Läufe noch nicht fertig` }
    const failed = runs.filter(run => !['success', 'skipped', 'neutral'].includes(String(run?.conclusion)))
    if (failed.length) return { ergebnis: 'nicht-erfuellt', detail: failed.slice(0, 3).map(run => `${clip(run?.name, 40)}: ${clip(run?.conclusion, 20)}`).join(', ') }
    return { ergebnis: 'verifiziert', detail: `${runs.length} CI-Läufe grün` }
}

const builtinVerifiers: Record<string, Verifier> = { 'release-tag': releaseTagVerifier, 'ci-gruen': ciGreenVerifier }
const registeredVerifiers = new Map<string, Verifier>()

/** Runs the read-only check for a criterion outside a delegation (e.g. the release re-check of the auto reminders). */
/** One stable default fetch, so the shared release lookup cache is reused between checks (2.82.0). */
const defaultVerifierFetch: FetchLike = (url, init) => fetch(url, init as any) as any

export async function checkExpectation(raw: Expectation, fetchImpl?: FetchLike): Promise<{ ergebnis: VerificationResult; detail: string }> {
    const expectation = normalizeExpectation(raw)
    if (!expectation) return { ergebnis: 'unverifiziert', detail: 'ungültiges Kriterium' }
    const verifier = builtinVerifiers[expectation.art] ?? registeredVerifiers.get(expectation.art)
    if (!verifier) return { ergebnis: 'unverifiziert', detail: `keine lesende Prüfung für „${expectation.art}“` }
    try {
        return await verifier(expectation, { fetch: fetchImpl ?? defaultVerifierFetch })
    } catch (error) {
        return { ergebnis: 'unverifiziert', detail: `Prüfung nicht möglich: ${clip((error as Error)?.message, 120)}` }
    }
}

/** Missions and other modules may add their own READ-ONLY checks per criterion type. */
export function registerDelegationVerifier(art: string, verifier: Verifier): void {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(art) || builtinVerifiers[art]) throw new Error(`Ungültige oder feste Prüfart: ${art}`)
    registeredVerifiers.set(art, verifier)
}

// ---------------------------------------------------------------------------
// answers from the Agentic OS
// ---------------------------------------------------------------------------

interface InboxMessage { id: string; from: string; to: string; thread: string; content: string; metadata: Record<string, unknown>; at: string }

function extractMessages(body: unknown): InboxMessage[] {
    const list = Array.isArray(body) ? body
        : body && typeof body === 'object'
            ? (['messages', 'items', 'inbox', 'data', 'results'].map(key => (body as any)[key]).find(Array.isArray) || [])
            : []
    return (list as any[]).slice(0, 200).flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const content = String(item.content ?? item.text ?? item.body ?? '')
        const thread = String(item.thread_id ?? item.threadId ?? '')
        const at = String(item.created_at ?? item.createdAt ?? item.ts ?? '')
        const rawId = item.id ?? item.message_id ?? item._id
        const id = rawId !== undefined && rawId !== null && String(rawId)
            ? String(rawId).slice(0, 80)
            : `h${createHash('sha256').update(`${thread}\n${at}\n${content}`).digest('hex').slice(0, 20)}`
        return [{
            id, thread, content, at,
            from: String(item.from_agent ?? item.from ?? item.sender ?? '').toUpperCase(),
            to: String(item.to_agent ?? item.to ?? '').toUpperCase(),
            metadata: item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata : {},
        }]
    })
}

const READ_FIELDS = new Set(['status', 'delegation_status', 'beleg', 'evidence'])

function claimedStatus(metadata: Record<string, unknown>): 'angenommen' | 'fertig' | 'abgelehnt' | null {
    const value = String(metadata.status ?? metadata.delegation_status ?? '').toLowerCase()
    if (['angenommen', 'accepted', 'ack', 'in-arbeit', 'in_progress', 'working'].includes(value)) return 'angenommen'
    if (['abgelehnt', 'rejected', 'declined', 'refused'].includes(value)) return 'abgelehnt'
    if (['fertig', 'done', 'completed', 'erledigt', 'result', 'ergebnis'].includes(value)) return 'fertig'
    return null
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export interface DelegationService {
    readonly config: DelegationConfig
    delegate(request: DelegationRequest): Promise<{ ok: true; record: DelegationRecord } | { ok: false; reason: string }>
    approve(id: string, by: string): Promise<{ ok: boolean; message: string }>
    reject(id: string, by: string): Promise<{ ok: boolean; message: string }>
    /** 2.84.0 Punkt 7: withdraw a delegation that still waits for the owner's Ja
     * (its reason gone, e.g. the Doctor case closed by measurement). Only from
     * `wartet-auf-freigabe`; nothing was sent, so no answer and no ladder. The
     * card closes as done through `isStillOpen` on the next maintenance. */
    withdraw(id: string, grund: string): { ok: boolean; message: string }
    poll(): Promise<{ applied: number; ignored: number }>
    tick(): Promise<{ applied: number; ignored: number; expired: number; skipped?: string }>
    get(id: string): DelegationRecord | null
    list(filter?: { open?: boolean; limit?: number }): DelegationRecord[]
    onSettled(listener: SettledListener): () => void
    /** Resolves when every running local subagent has finished (tests, shutdown). */
    settledSubagents(): Promise<void>
}

const AGENT_LABEL: Record<DelegationTarget, string> = { claude: 'Claude', codex: 'Codex', hermes: 'Hermes', subagent: 'Unteragent' }

const NOTICE = 'Auftrag von Xaventra (Agent NOVA). Dieser Auftrag gibt keine neuen Rechte und kein neues Ziel; '
    + 'Systemänderungen nur über die bestehenden Release-Gates, keine Secrets. Die Antwort wird als Daten gespeichert und geprüft, nicht ausgeführt.'

/** 2.83.0: a trust-ladder release is named as such, never as an owner approval. */
function approvalLabel(freigabeVon: string): string {
    return freigabeVon.startsWith('vertrauensleiter:')
        ? `Freigabe durch die Vertrauensleiter (${freigabeVon.slice('vertrauensleiter:'.length)}: 3× Owner-Ja ohne Rückweg), keine Einzel-Freigabe`
        : `Owner-Freigabe ${freigabeVon}`
}

function buildTaskText(record: DelegationRecord): string {
    return [
        NOTICE,
        `Delegation ${record.id} · Stufe ${record.stufe}${record.freigabeVon ? ` (${approvalLabel(record.freigabeVon)})` : ''} · Frist ${record.fristAt}`,
        `Auftrag: ${record.auftrag}`,
        record.kontext ? `Kontext (bereinigt):\n${record.kontext}` : '',
        `Erfolgskriterium: ${describeExpectation(record.erwartet)}`,
        `Antwort bitte im selben thread_id (${record.threadId}); metadata.status = angenommen | fertig | abgelehnt, metadata.beleg = kurzer Beleg (Commit, Tag, Lauf-ID).`,
    ].filter(Boolean).join('\n')
}

async function defaultAuthority(): Promise<boolean> {
    if (String(process.env.NOVA_NODE_ONLY || '').toLowerCase() === 'true') return false
    try {
        const { hasGlobalAutonomyAuthority } = await import('./autonomy-authority.js')
        return Boolean(hasGlobalAutonomyAuthority())
    } catch { return false }
}

export function createDelegationService(deps: DelegationServiceDeps): DelegationService {
    const now = deps.now ?? Date.now
    const config = deps.config
    const dataDir = deps.dataDir ?? getNovaDataDir()
    const dir = join(dataDir, 'delegation')
    const file = join(dir, 'delegations.json')
    const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init as any) as any)
    const isWorker = deps.isWorker ?? (() => String(process.env.NOVA_NODE_ONLY || '').toLowerCase() === 'true')
    const authority = deps.authority ?? defaultAuthority
    const listeners = new Set<SettledListener>()
    const running = new Set<Promise<void>>()
    const iso = (t = now()) => new Date(t).toISOString()

    const load = (): DelegationRecord[] => {
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8'))
            return raw?.version === 1 && Array.isArray(raw.records) ? raw.records.filter((item: DelegationRecord) => DELEGATION_ID_PATTERN.test(item?.id)) : []
        } catch { return [] }
    }
    const save = (records: DelegationRecord[]) => {
        let kept = records
        if (kept.length > MAX_RECORDS) {
            const closed = kept.filter(item => !OPEN.has(item.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            const drop = new Set(closed.slice(0, kept.length - MAX_RECORDS).map(item => item.id))
            kept = kept.filter(item => !drop.has(item.id))
        }
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        atomicWriteJsonSync(file, { version: 1, records: kept })
    }
    /** Synchronous read-modify-write (no await inside). */
    const mutate = <T>(id: string, fn: (record: DelegationRecord) => T): T | null => {
        const records = load()
        const record = records.find(item => item.id === id)
        if (!record) return null
        const result = fn(record)
        record.updatedAt = iso()
        save(records)
        return result
    }
    const setStatus = (record: DelegationRecord, status: DelegationStatus, detail?: string) => {
        record.status = status
        record.verlauf = [...(record.verlauf || []), { at: iso(), status, ...(detail ? { detail: clip(detail, 200) } : {}) }].slice(-20)
    }

    const thought = (input: Parameters<AddThought>[0]) => {
        try {
            if (deps.addThought) { deps.addThought(input); return }
            void import('../planner/index.js').then(planner => planner.addThought(input)).catch(() => undefined)
        } catch (error) {
            console.warn(`[Delegation] Gedanke nicht gespeichert: ${clip((error as Error)?.message, 120)}`)
        }
    }

    const settle = async (record: DelegationRecord) => {
        const verified = record.status === 'fertig' && record.pruefung?.ergebnis === 'verifiziert'
        const who = AGENT_LABEL[record.to]
        const short = record.auftrag.slice(0, 80)
        if (record.status === 'fertig') {
            const check = record.pruefung ? `Prüfung: ${record.pruefung.ergebnis} — ${record.pruefung.detail}` : 'Prüfung: keine'
            thought(verified
                ? { source: 'delegation', title: `Delegation an ${who} erledigt (geprüft)`, evidence: `${short} · ${check} · Antwort liegt als Daten in /delegiert`, severity: 'info', signature: `delegation:${record.id}:fertig` }
                : { source: 'delegation', title: `Delegation an ${who}: Ergebnis ${record.pruefung?.ergebnis === 'nicht-erfuellt' ? 'nicht erfüllt' : 'unverifiziert'}`, evidence: `${short} · ${check}`, severity: 'warning', signature: `delegation:${record.id}:fertig` })
        } else if (record.status === 'abgelaufen') {
            thought({ source: 'delegation', title: `Delegation an ${who} abgelaufen`, evidence: `${short} · Frist ${record.fristAt} ohne fertiges Ergebnis`, severity: 'warning', signature: `delegation:${record.id}:abgelaufen` })
        } else if (record.status === 'abgelehnt' || record.status === 'fehler') {
            thought({ source: 'delegation', title: `Delegation an ${who} ${record.status === 'fehler' ? 'fehlgeschlagen' : 'abgelehnt'}`, evidence: `${short}${record.fehler ? ` · ${record.fehler}` : ''}`, severity: 'warning', signature: `delegation:${record.id}:${record.status}` })
        }
        for (const listener of listeners) {
            try { await listener({ ...record }, { verified }) } catch (error) {
                console.warn(`[Delegation] Listener-Fehler: ${clip((error as Error)?.message, 120)}`)
            }
        }
    }

    const verify = async (expectation: Expectation): Promise<{ ergebnis: VerificationResult; detail: string }> => {
        const verifier = deps.verifiers?.[expectation.art] ?? builtinVerifiers[expectation.art] ?? registeredVerifiers.get(expectation.art)
        if (!verifier) return { ergebnis: 'unverifiziert', detail: `keine lesende Prüfung für „${expectation.art}“` }
        try {
            const result = await verifier({ ...expectation }, { fetch: doFetch })
            const ergebnis: VerificationResult = ['verifiziert', 'nicht-erfuellt', 'unverifiziert'].includes(result?.ergebnis) ? result.ergebnis : 'unverifiziert'
            return { ergebnis, detail: clip(result?.detail, 200) }
        } catch (error) {
            return { ergebnis: 'unverifiziert', detail: `Prüfung nicht möglich: ${clip((error as Error)?.message, 120)}` }
        }
    }

    /**
     * Applies one answer (Agentic OS message or local subagent result). The
     * text is stored as data; only the claimed status and a short evidence
     * string are read; everything else is ignored by name.
     */
    const applyAnswer = async (id: string, answer: { text: string; from: string; messageId: string; at?: string; metadata: Record<string, unknown>; failure?: 'fehler' | 'abgelaufen' }): Promise<boolean> => {
        const before = load().find(item => item.id === id)
        if (!before || !WAITING_FOR_ANSWER.has(before.status) || before.messageIds.includes(answer.messageId)) return false
        const claimed = answer.failure ? null : claimedStatus(answer.metadata)
        const ignored = Object.keys(answer.metadata).filter(key => !READ_FIELDS.has(key)).map(key => clip(key, 40)).slice(0, 12)
        const checkable = Boolean(builtinVerifiers[before.erwartet.art] || deps.verifiers?.[before.erwartet.art] || registeredVerifiers.get(before.erwartet.art))
        // Verify when the agent reports a result, or for a checkable criterion on any answer.
        const wantsCheck = !answer.failure && claimed !== 'abgelehnt' && (claimed === 'fertig' || claimed === null || checkable)
        const check = wantsCheck ? await verify(before.erwartet) : undefined
        let next: DelegationStatus
        if (answer.failure) next = answer.failure
        else if (claimed === 'abgelehnt') next = 'abgelehnt'
        else if (claimed === 'fertig' || claimed === null) next = 'fertig'
        else next = check?.ergebnis === 'verifiziert' ? 'fertig' : 'angenommen'
        const updated = mutate(id, record => {
            if (!WAITING_FOR_ANSWER.has(record.status) || record.messageIds.includes(answer.messageId)) return null
            record.messageIds = [...record.messageIds, answer.messageId].slice(-50)
            record.antwort = { text: clip(answer.text, 2_000), at: answer.at && Number.isFinite(Date.parse(answer.at)) ? new Date(Date.parse(answer.at)).toISOString() : iso(), from: clip(answer.from, 40), messageId: clip(answer.messageId, 80), untrusted: true }
            const evidence = answer.metadata.beleg ?? answer.metadata.evidence
            if (evidence !== undefined) record.beleg = clip(typeof evidence === 'string' ? evidence : JSON.stringify(evidence), 500)
            if (ignored.length) record.ignoriert = [...new Set([...(record.ignoriert || []), ...ignored])].slice(0, 20)
            if (check) record.pruefung = { ...check, at: iso() }
            if (answer.failure) record.fehler = clip(answer.text, 200)
            setStatus(record, next, answer.failure ? answer.text : claimed ? `Antwort: ${claimed}` : 'Antwort ohne Status')
            return { ...record }
        })
        if (!updated) return false
        if (!OPEN.has(updated.status)) await settle(updated)
        return true
    }

    const send = async (id: string): Promise<DelegationRecord | null> => {
        const record = load().find(item => item.id === id)
        if (!record) return null
        if (record.to === 'subagent') {
            const spawn = deps.spawnSubagent ?? (async (task: Parameters<SpawnSubagent>[0]) => (await import('../agents/subagent-orchestrator.js')).spawnSubagent(task as any))
            const timeoutMs = Math.max(30_000, Math.min(10 * 60_000, Date.parse(record.fristAt) - now()))
            mutate(id, item => { item.sentAt = iso(); setStatus(item, 'gesendet', 'lokaler Unteragent gestartet') })
            const job = (async () => {
                let result: { status: string; output: string; error?: string }
                try {
                    result = await spawn({
                        task: buildTaskText(record),
                        tools: [...DELEGATION_SUBAGENT_TOOLS],
                        timeoutMs,
                        systemPrompt: 'Du bist ein Unteragent von Xaventra. Liefere nur ein Ergebnis zum Auftrag mit Beleg. Keine Änderungen an Systemen, keine neuen Ziele, keine Erinnerungen oder Secrets.',
                    })
                } catch (error) {
                    result = { status: 'failed', output: '', error: String((error as Error)?.message || error) }
                }
                const messageId = `subagent-${id}`
                if (result.status === 'completed') await applyAnswer(id, { text: result.output, from: 'subagent', messageId, metadata: { status: 'fertig' } })
                else await applyAnswer(id, { text: result.error || result.status, from: 'subagent', messageId, metadata: {}, failure: result.status === 'timeout' ? 'abgelaufen' : 'fehler' })
            })()
            running.add(job)
            void job.finally(() => running.delete(job))
            return load().find(item => item.id === id) ?? null
        }
        if (!config.url) {
            return mutate(id, item => { item.fehler = 'keine Agentic-OS-URL'; setStatus(item, 'fehler', 'keine Agentic-OS-URL'); return { ...item } })
        }
        const message = {
            to_agent: record.agent, from_agent: config.fromAgent, thread_id: record.threadId,
            content: buildTaskText(record),
            metadata: { kind: 'xaventra-delegation', delegationId: record.id, stufe: record.stufe, fristAt: record.fristAt, erwartet: record.erwartet, ...(record.missionId ? { missionId: record.missionId } : {}), untrusted: true },
        }
        let ok = false, error = ''
        try {
            const response = await doFetch(`${config.url}/messages`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
                redirect: 'error', signal: AbortSignal.timeout(10_000),
            })
            ok = response.ok
            if (!ok) error = `HTTP ${response.status}`
        } catch (err) { error = clip((err as Error)?.message || err, 160) }
        const updated = mutate(id, item => {
            if (ok) { item.sentAt = iso(); setStatus(item, 'gesendet', `an ${item.agent} über Agentic OS`) }
            else { item.fehler = error || 'nicht zugestellt'; setStatus(item, 'fehler', item.fehler) }
            return { ...item }
        })
        if (updated && updated.status === 'fehler') await settle(updated)
        return updated
    }

    const service: DelegationService = {
        config,
        async delegate(request) {
            if (!config.enabled) return { ok: false, reason: 'Delegation ist aus (autonomy.delegation.enabled=false).' }
            if (isWorker()) return { ok: false, reason: 'Mesh-Worker delegiert nicht; nur der Main.' }
            const to = String(request?.to || '').toLowerCase() as DelegationTarget
            if (!TARGETS.includes(to)) return { ok: false, reason: `Unbekanntes Ziel: ${clip(request?.to, 20)}` }
            if (to !== 'subagent' && !config.url) return { ok: false, reason: 'Keine Agentic-OS-URL (autonomy.delegation.url oder autonomy.claudeHandoff.url).' }
            const auftragRaw = String(request?.auftrag ?? '')
            const auftragClean = sanitizeDelegationContext(auftragRaw, 1_000)
            const auftrag = auftragClean.text
            if (auftrag.length < 3) return { ok: false, reason: 'Auftrag fehlt.' }
            if (neverListHit(auftragRaw)) return { ok: false, reason: 'Nie-Liste: so ein Auftrag wird nicht delegiert.' }
            const erwartet = normalizeExpectation(request?.erwartet)
            if (!erwartet) return { ok: false, reason: 'Erfolgskriterium (erwartet) fehlt oder ist ungültig.' }
            if (load().filter(item => OPEN.has(item.status)).length >= config.maxOpen) return { ok: false, reason: `Zu viele offene Delegationen (max. ${config.maxOpen}).` }
            const t = now()
            let fristMs = config.defaultFristMinutes * 60_000
            if (typeof request.frist === 'number' && Number.isFinite(request.frist)) fristMs = request.frist * 60_000
            else if (typeof request.frist === 'string' && Number.isFinite(Date.parse(request.frist))) fristMs = Date.parse(request.frist) - t
            fristMs = Math.max(MIN_FRIST_MS, Math.min(MAX_FRIST_MS, fristMs))
            const kontext = sanitizeDelegationContext(request.kontext)
            const level = classifyDelegationLevel(auftragRaw, request.aendert === true)
            const id = `dlg-${randomBytes(6).toString('hex')}`
            const missionId = typeof request.missionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(request.missionId) ? request.missionId : undefined
            const record: DelegationRecord = {
                id, to, agent: to === 'subagent' ? 'SUBAGENT' : config.agents[to], threadId: `${THREAD_PREFIX}${id}`,
                auftrag, kontext: kontext.text, kontextEntfernt: [...new Set([...auftragClean.removed, ...kontext.removed])], erwartet,
                ...(missionId ? { missionId } : {}),
                stufe: level.stufe, stufeGrund: level.grund, status: 'wartet-auf-freigabe',
                createdAt: iso(t), updatedAt: iso(t), fristAt: iso(t + fristMs), verlauf: [], messageIds: [],
            }
            const records = load()
            records.push(record)
            save(records)
            const preApproved = typeof request.freigabeVon === 'string' && /^[A-Za-z0-9:_.@-]{2,64}$/.test(request.freigabeVon) ? request.freigabeVon : undefined
            if (level.stufe === 'L2' && preApproved) {
                mutate(id, item => { item.freigabeVon = preApproved; setStatus(item, 'wartet-auf-freigabe', preApproved.startsWith('vertrauensleiter:') ? `${approvalLabel(preApproved)}, keine Karte` : `Freigabe ${preApproved} (vorab, Karte des Aufrufers)`) })
            } else if (level.stufe === 'L2') {
                const createCard: CreateCard = deps.createCard ?? (await import('./approval-cards.js')).createApprovalCard as unknown as CreateCard
                const card = createCard({
                    art: 'delegation',
                    titel: `Auftrag an ${AGENT_LABEL[to]} senden?`,
                    beleg: `Der Auftrag verlangt Änderungen an Systemen (${level.grund}). Erfolgskriterium: ${describeExpectation(erwartet)}. Frist ${record.fristAt.slice(0, 16).replace('T', ' ')} UTC.${record.kontextEntfernt.length ? ` Aus dem Kontext entfernt: ${record.kontextEntfernt.join(', ')}.` : ''}`,
                    vorschlag: auftrag.slice(0, 500),
                    aktion: { kind: 'delegation', ref: id },
                    ablaufMs: Math.max(60_000, Math.min(24 * 60 * 60_000, fristMs)),
                    dedupeKey: `delegation:${id}`,
                    quelle: 'delegation',
                })
                if (card.ok === false) {
                    const reason = 'reason' in card ? card.reason : 'Karte abgelehnt'
                    mutate(id, item => { item.fehler = clip(reason, 200); setStatus(item, 'abgelehnt', reason) })
                    return { ok: false, reason: clip(reason, 200) }
                }
                const updated = mutate(id, item => { item.karteId = card.card.id; setStatus(item, 'wartet-auf-freigabe', `Karte ${card.card.id}`); return { ...item } })
                return { ok: true, record: updated ?? record }
            }
            const sent = await send(id)
            return sent ? { ok: true, record: sent } : { ok: false, reason: 'Delegation verschwunden.' }
        },
        async approve(id, by) {
            const claimed = mutate(id, record => {
                if (record.status !== 'wartet-auf-freigabe' || record.stufe !== 'L2') return false
                record.freigabeVon = clip(by, 64)
                setStatus(record, 'gesendet', `Freigabe ${record.freigabeVon}`)
                // claimed before the await: a second Ja finds 'gesendet' and does nothing
                return true
            })
            if (!claimed) return { ok: false, message: 'Delegation wartet nicht (mehr) auf Freigabe.' }
            const sent = await send(id)
            return sent && sent.status !== 'fehler'
                ? { ok: true, message: `Auftrag ${id} an ${AGENT_LABEL[sent.to]} gesendet.` }
                : { ok: false, message: `Auftrag ${id} nicht gesendet: ${sent?.fehler || 'unbekannt'}` }
        },
        async reject(id, by) {
            const updated = mutate(id, record => {
                if (record.status !== 'wartet-auf-freigabe') return null
                setStatus(record, 'abgelehnt', `Owner ${clip(by, 64)}: Nein`)
                record.fehler = 'vom Owner abgelehnt'
                return { ...record }
            })
            if (!updated) return { ok: false, message: 'Delegation wartet nicht (mehr) auf Freigabe.' }
            await settle(updated)
            return { ok: true, message: `Auftrag ${id} nicht gesendet.` }
        },
        withdraw(id, grund) {
            const updated = mutate(id, record => {
                if (record.status !== 'wartet-auf-freigabe') return null
                record.fehler = clip(grund, 200)
                setStatus(record, 'zurueckgezogen', grund)
                return { ...record }
            })
            return updated ? { ok: true, message: `Auftrag ${id} zurückgezogen: ${clip(grund, 120)}` } : { ok: false, message: 'Delegation wartet nicht (mehr) auf Freigabe.' }
        },
        async poll() {
            const result = { applied: 0, ignored: 0 }
            if (!config.enabled || !config.url || isWorker()) return result
            const waiting = load().filter(item => WAITING_FOR_ANSWER.has(item.status) && item.to !== 'subagent')
            if (!waiting.length) return result
            let messages: InboxMessage[] = []
            try {
                const response = await doFetch(`${config.url}/agent_registry/${encodeURIComponent(config.fromAgent)}/inbox`, {
                    method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
                })
                if (!response.ok) return result
                messages = extractMessages(await response.json())
            } catch { return result }
            const byThread = new Map(waiting.map(item => [item.threadId, item]))
            for (const message of messages) {
                // Not a delegation thread (or not ours): ignored, never acted on.
                if (!message.thread.startsWith(THREAD_PREFIX)) { result.ignored++; continue }
                const record = byThread.get(message.thread)
                const addressedToUs = !message.to || message.to === config.fromAgent
                if (!record || message.from !== record.agent || !addressedToUs) { result.ignored++; continue }
                if (record.messageIds.includes(message.id)) continue
                if (await applyAnswer(record.id, { text: message.content, from: message.from, messageId: message.id, at: message.at, metadata: message.metadata })) result.applied++
            }
            return result
        },
        async tick() {
            if (!config.enabled || isWorker()) return { applied: 0, ignored: 0, expired: 0, skipped: 'aus/worker' }
            let main = false
            try { main = Boolean(await authority()) } catch { main = false }
            if (!main) return { applied: 0, ignored: 0, expired: 0, skipped: 'kein Main' }
            const polled = await service.poll()
            let expired = 0
            const t = now()
            for (const record of load().filter(item => OPEN.has(item.status) && Date.parse(item.fristAt) < t)) {
                const updated = mutate(record.id, item => {
                    if (!OPEN.has(item.status)) return null
                    setStatus(item, 'abgelaufen', `Frist ${item.fristAt} überschritten`)
                    return { ...item }
                })
                if (updated) { expired++; await settle(updated) }
            }
            return { ...polled, expired }
        },
        get(id) {
            if (!DELEGATION_ID_PATTERN.test(String(id))) return null
            return load().find(item => item.id === id) ?? null
        },
        list(filter = {}) {
            const limit = Math.max(1, Math.min(300, filter.limit ?? 50))
            return load()
                .filter(item => filter.open === undefined || OPEN.has(item.status) === filter.open)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, limit)
        },
        onSettled(listener) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
        async settledSubagents() {
            while (running.size) await Promise.allSettled([...running])
        },
    }
    return service
}

// ---------------------------------------------------------------------------
// runtime (daemon) + module API
// ---------------------------------------------------------------------------

let current: DelegationService | null = null
let timer: ReturnType<typeof setInterval> | null = null
const pendingListeners = new Set<SettledListener>()
const detachers = new Map<SettledListener, () => void>()

export function configureDelegation(autonomy: unknown, deps: Partial<DelegationServiceDeps> = {}): DelegationService {
    current = createDelegationService({ ...deps, config: parseDelegationConfig(autonomy) })
    detachers.clear()
    for (const listener of pendingListeners) detachers.set(listener, current.onSettled(listener))
    return current
}

export function getDelegationService(): DelegationService {
    return current ?? configureDelegation({})
}

/** Public entry for missions and Aufträge. Arms the poll timer while something is open. */
export async function delegate(request: DelegationRequest): ReturnType<DelegationService['delegate']> {
    const result = await getDelegationService().delegate(request)
    if (result.ok) armDelegationPolling()
    return result
}

/** Survives reconfiguration; returns an unsubscribe function. */
export function onDelegationSettled(listener: SettledListener): () => void {
    pendingListeners.add(listener)
    if (current) detachers.set(listener, current.onSettled(listener))
    return () => {
        pendingListeners.delete(listener)
        detachers.get(listener)?.()
        detachers.delete(listener)
    }
}

/** Knopf-Karte executor for L2 delegations (Ja = send, Nein = not sent). */
export async function registerDelegationCardExecutor(): Promise<void> {
    const { registerCardExecutor, getCardExecutor } = await import('./approval-cards.js')
    if (getCardExecutor('delegation')) return
    registerCardExecutor({
        kind: 'delegation',
        impact: 'intern',
        async execute(card, _answer, ctx) { return getDelegationService().approve(card.aktion.ref, ctx.decidedBy) },
        async reject(card, ctx) { return getDelegationService().reject(card.aktion.ref, ctx.decidedBy) },
        isStillOpen(card) { return getDelegationService().get(card.aktion.ref)?.status === 'wartet-auf-freigabe' },
    })
}

let runtimeActive = false

/**
 * P9: the Rückkanal timer only runs while delegations are open. delegate()
 * arms it; the tick that finds nothing open stops it again. No empty polling.
 */
export function armDelegationPolling(): boolean {
    if (!runtimeActive || timer || !current) return Boolean(timer)
    if (!current.list({ open: true, limit: 1 }).length) return false
    const service = current
    timer = setInterval(() => {
        void service.tick()
            .catch(error => console.warn(`[Delegation] Takt fehlgeschlagen: ${clip((error as Error)?.message, 120)}`))
            .finally(() => {
                if (service.list({ open: true, limit: 1 }).length) return
                if (timer) clearInterval(timer)
                timer = null
            })
    }, service.config.pollSeconds * 1000)
    timer.unref?.()
    return true
}

/** True while the Rückkanal timer runs (tests, /status). */
export function isDelegationPolling(): boolean {
    return timer !== null
}

/** Starts polling + deadline watch on the Main. Off unless enabled; never on a worker. */
export async function startDelegationRuntime(autonomy: unknown, options: { nodeOnly: boolean }): Promise<{ started: boolean; reason: string }> {
    stopDelegationRuntime()
    const service = configureDelegation(autonomy)
    if (!service.config.enabled) return { started: false, reason: 'autonomy.delegation.enabled=false' }
    if (options.nodeOnly) return { started: false, reason: 'Mesh-Worker: Delegation nur am Main' }
    await registerDelegationCardExecutor()
    runtimeActive = true
    const polling = armDelegationPolling()
    return { started: true, reason: `Rückkanal alle ${service.config.pollSeconds}s, nur solange Delegationen offen sind (jetzt ${polling ? 'aktiv' : 'ruhig'})${service.config.url ? '' : '; ohne Agentic-OS-URL nur lokale Unteragenten'}` }
}

export function stopDelegationRuntime(): void {
    if (timer) clearInterval(timer)
    timer = null
    runtimeActive = false
}

const STATUS_MARK: Record<DelegationStatus, string> = {
    'wartet-auf-freigabe': '🔘', gesendet: '📤', angenommen: '🛠️', fertig: '✅', abgelaufen: '⌛', abgelehnt: '🚫', fehler: '❌', zurueckgezogen: '↩️',
}

/** `/delegiert` (owner): open and finished delegations with status and evidence. */
export function formatDelegiert(service: DelegationService = getDelegationService(), limit = 10): string {
    const open = service.list({ open: true, limit: 20 })
    const done = service.list({ open: false, limit })
    const lines = ['🤝 Delegationen']
    if (!service.config.enabled) lines.push('(Delegation ist aus: autonomy.delegation.enabled=false)')
    const row = (item: DelegationRecord) => {
        const parts = [`${STATUS_MARK[item.status]} ${item.id} → ${AGENT_LABEL[item.to]} · ${item.status} · ${item.stufe}`]
        parts.push(`  Auftrag: ${item.auftrag.slice(0, 120)}`)
        parts.push(`  Kriterium: ${describeExpectation(item.erwartet)} · Frist ${item.fristAt.slice(0, 16).replace('T', ' ')} UTC${item.missionId ? ` · Mission ${item.missionId}` : ''}`)
        if (item.pruefung) parts.push(`  Prüfung: ${item.pruefung.ergebnis} — ${item.pruefung.detail}`)
        if (item.beleg) parts.push(`  Beleg (Antwort, ungeprüft): ${item.beleg.slice(0, 160)}`)
        if (item.antwort) parts.push(`  Antwort (Daten, nicht ausgeführt): ${item.antwort.text.slice(0, 160).replace(/\s+/g, ' ')}`)
        if (item.ignoriert?.length) parts.push(`  Ignorierte Felder der Antwort: ${item.ignoriert.join(', ')}`)
        if (item.fehler && item.status !== 'fertig') parts.push(`  Grund: ${item.fehler}`)
        return parts.join('\n')
    }
    lines.push('', `Offen (${open.length}):`, ...(open.length ? open.map(row) : ['—']))
    lines.push('', `Abgeschlossen (letzte ${done.length}):`, ...(done.length ? done.map(row) : ['—']))
    return lines.join('\n')
}
