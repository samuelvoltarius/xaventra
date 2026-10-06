/**
 * Knopf-Karten (CL-10, Autonomie-Plan Phase 1 Teil A): one frame for every
 * proposal that needs Alfred's answer — [Ja] [Nein] [Später] [Immer erlauben].
 *
 * Rules (fixed in code, not configurable):
 * - The card id and every button token are generated here, never by a model.
 *   `callback_data` is `ac:<16 hex>` (19 bytes) and carries no parameters; the
 *   action is resolved from the stored card.
 * - Only the owner can answer: a numeric Telegram id that is listed in
 *   `allowFrom` (usernames never count).
 * - Every answer is single-use: the first accepted press consumes all tokens
 *   of the card. Replays, other buttons of the same card and expired cards are
 *   refused.
 * - A Nie-Liste action never becomes a card (the discarded thought is logged).
 * - "Immer erlauben" is never offered for physical or outward actions
 *   (drucken, schalten, senden, kaufen …), whatever the caller declares.
 * - Executing an answer always goes through a registered executor that wraps
 *   an existing path (install ticket, self-heal, PATCH_GATE). A card without
 *   executor can be answered, but "Ja" runs nothing.
 * - Every answer is recorded in the Outcome-Ledger format
 *   (`.nova-data/outcome-ledger/decisions/`, event `approval.recorded`).
 * - P9: every answer feeds the ONE permission store (`action-policy/trust.json`)
 *   under the card's policy kind (`policyKindForCard`): an executed „Ja“ counts
 *   for the trust ladder (after the real outcome, when the executor reports a
 *   `completion`), „Nein“ resets it, „Immer erlauben“ stores a standing grant
 *   for the executor's `standingSubject`. The fixed exclusions
 *   (`isStandingExcluded`) also decide whether „Immer erlauben“ exists at all.
 *
 * API for other modules (e.g. the planner):
 *   registerCardExecutor({ kind, execute, reject?, allowAlways?, isStillOpen?, impact? })
 *   createApprovalCard({ art, titel, beleg, vorschlag, aktion: { kind, ref }, ablaufMs?, effects?, wirkung?, dedupeKey?, node?, quelle? })
 *     -> { ok: true, card, created } | { ok: false, reason }
 *   The Main delivers new cards to Telegram (approval-card-sources.ts,
 *   `deliverPendingCards`, runs every minute); callers never send themselves.
 *   P8 „weniger Einzelfragen“: a card that is not time-critical (internal,
 *   valid >= 2 h, not `wichtigkeit: 'hoch'`, no security/outage wording) gets
 *   `zustellung: 'bericht'` and — while the morning/evening report is on —
 *   waits for the next report, which lists it and releases it
 *   (`releaseBundledCards`). Physical/outward/infra cards, security and
 *   outages always go out at once (`zustellung: 'sofort'`).
 *   listApprovalCards({ status?, limit? }) · noteThought({ quelle, titel, status, text? }) · readThoughts()
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { ownerText, OWNER_PAGE_CHARS } from './owner-text.js'
import {
    grantStanding, isNieAktionsart, isNurEinzelnesJa, isStandingExcluded, KARTEN_EXTERN, KARTEN_PHYSISCH, nieEffekt, policyKindForCard,
    recordActionOutcome, recordOwnerAnswer,
} from './action-policy.js'

export const CARD_ANSWERS = ['ja', 'nein', 'spaeter', 'immer'] as const
export type CardAnswer = typeof CARD_ANSWERS[number]
/** intern = Xaventra's own system; infra = VMs on the Proxmox host (Phase 6c); physisch = acts in the room (printer, switch); extern = leaves the house (mail, purchase). */
export type CardImpact = 'intern' | 'infra' | 'physisch' | 'extern'
export type CardStatus = 'offen' | 'spaeter' | 'ja' | 'nein' | 'immer' | 'abgelaufen' | 'erledigt'

export interface CardActionRef { kind: string; ref: string }
export interface CardButton { token: string; answer: CardAnswer }
export interface ApprovalCard {
    id: string
    art: string
    titel: string
    beleg: string
    vorschlag: string
    aktion: CardActionRef
    wirkung: CardImpact
    stufe: 'fragen'
    node: string
    quelle: string
    dedupeKey?: string
    createdAt: string
    expiresAt: string
    status: CardStatus
    buttons: CardButton[]
    usedTokens: string[]
    resendAt?: string
    decidedAt?: string
    decidedBy?: string
    answer?: CardAnswer
    result?: { ok: boolean; message: string }
    messages: Array<{ chatId: string; messageId: number }>
    deliveredAt?: string
    /** P8: 'bericht' = bundled into the next morning/evening report; 'sofort' (or missing) = at once. */
    zustellung?: CardDelivery
    /** set when a report listed the bundled card; the card loop then delivers it. */
    freigegebenAt?: string
    /** Paket L: delivered inside ONE bundled message (card-bundle.ts), never on its own. */
    buendel?: string
    /** Paket L: short owner line for the bundle (no ids). */
    kurz?: string
    /** Paket L: cards of one subject that render in one row (e.g. lokal/Cloud of one device). */
    gruppe?: string
    /** Paket L: button label for the Ja of this card inside a group row. */
    knopf?: string
    /** Paket L: the one reminder before expiry was sent. */
    erinnertAt?: string
    /** 2.86 Paket M: created with `wichtigkeit: 'hoch'` — may jump the one-question queue (question-queue.ts). */
    wichtig?: boolean
}

export type CardDelivery = 'sofort' | 'bericht'

export interface NewCardInput {
    art: string
    titel: string
    beleg: string
    vorschlag: string
    aktion: CardActionRef
    /** Can only raise the impact (intern -> physisch/extern), never lower it. */
    wirkung?: CardImpact
    /** Effect vocabulary of the Nie-Liste (e.g. 'daten:loeschen'); any hit refuses the card. */
    effects?: string[]
    ablaufMs?: number
    node?: string
    quelle?: string
    dedupeKey?: string
    /** 'hoch' = time-critical, always delivered at once (never bundled). */
    wichtigkeit?: 'hoch' | 'normal'
    /** Paket L: bundle key (card-bundle.ts) plus short line, row group and button label. */
    buendel?: string
    kurz?: string
    gruppe?: string
    knopf?: string
}

export interface CardExecutionResult {
    ok: boolean
    message: string
    /** The real outcome when the work continues after the answer (e.g. an install on the host); the trust ladder waits for it. */
    completion?: Promise<{ ok: boolean; rolledBack?: boolean }>
}
export interface CardDecisionContext { decidedBy: string; userId: string }
export interface CardExecutor {
    kind: string
    impact?: CardImpact
    /** true only where a standing permission is meaningful for this kind (e.g. one catalog entry). */
    allowAlways?: (card: ApprovalCard) => boolean
    /** P9: what „Immer erlauben“ covers (e.g. the catalog id); stored in trust.json. Default: the action ref. */
    standingSubject?: (card: ApprovalCard) => string | null | undefined
    execute(card: ApprovalCard, answer: 'ja' | 'immer', ctx: CardDecisionContext): Promise<CardExecutionResult>
    reject?(card: ApprovalCard, ctx: CardDecisionContext): Promise<CardExecutionResult>
    /** false when the underlying proposal was settled elsewhere (e.g. /setup approve). */
    isStillOpen?(card: ApprovalCard): boolean
}

export interface CardLedger { recordApproval(runId: string, approval: Record<string, unknown>): void }
export interface CardStoreOptions {
    /** Base data directory (default `.nova-data`). The store lives in `<dataDir>/approval-cards/`. */
    dataDir?: string
    now?: () => number
    /** Outcome ledger; default: OutcomeLedger in `<dataDir>/outcome-ledger/decisions`. null disables. */
    ledger?: CardLedger | null
}

export type CardAnswerCode = 'ok' | 'kein-owner' | 'unbekannt' | 'verbraucht' | 'abgelaufen' | 'nie-liste' | 'nicht-erlaubt' | 'fehler'
export interface CardAnswerResult { ok: boolean; code: CardAnswerCode; message: string; card?: ApprovalCard }

export interface ThoughtEntry { at: string; quelle: string; titel: string; status: string; text?: string }

// ---------------------------------------------------------------------------
// fixed rules
// ---------------------------------------------------------------------------

export const CALLBACK_PREFIX = 'ac:'
const TOKEN_PATTERN = /^[a-f0-9]{16}$/
const KIND_PATTERN = /^[a-z][a-z0-9-]{1,39}$/
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/
const DEFAULT_TTL_MS = 24 * 60 * 60_000
const MIN_TTL_MS = 60_000
const MAX_TTL_MS = 7 * 24 * 60 * 60_000
const SNOOZE_MS = 4 * 60 * 60_000
const STORE_LIMIT = 300
const THOUGHT_LIMIT_BYTES = 512 * 1024

/** Kinds that never get a card (STUFENPLAN „Feste Grenzen“ Nr. 1). Phase 6b: the
 * lists live in the unified action policy (core/action-policy.ts); a card is
 * refused when ANY of its lists matches (union, never looser than before). */

/** Physical and outward actions: always ask, never "Immer erlauben" (Alfred 23.09.: Konstruieren ist nicht drucken). */
const PHYSICAL_KINDS = KARTEN_PHYSISCH
const EXTERNAL_KINDS = KARTEN_EXTERN

const IMPACT_RANK: Record<CardImpact, number> = { intern: 0, infra: 1, physisch: 2, extern: 3 }

/** Less than this left → time-critical, never bundled. */
export const BUNDLE_MIN_REMAINING_MS = 2 * 60 * 60_000
/** Security and outages always ask at once. */
const URGENT_TEXT = /sicherheit|security|ausfall|outage|offline|nicht erreichbar|unreachable|\bdown\b|alarm|kritisch|critical|notfall|einbruch|intrusion|angriff|attack|leck|leak/i

/** P8: is this card time-critical (deliver at once) or can it wait for the next report? */
export function cardDeliveryFor(input: { wirkung: CardImpact; ttlMs: number; wichtigkeit?: 'hoch' | 'normal'; text: string }): CardDelivery {
    if (input.wirkung !== 'intern') return 'sofort'
    if (input.wichtigkeit === 'hoch') return 'sofort'
    if (input.ttlMs < BUNDLE_MIN_REMAINING_MS) return 'sofort'
    if (URGENT_TEXT.test(input.text)) return 'sofort'
    return 'bericht'
}

function classifyImpact(art: string, kind: string, declared?: CardImpact, executorImpact?: CardImpact): CardImpact {
    let impact: CardImpact = 'intern'
    const raise = (value: CardImpact | undefined) => { if (value && IMPACT_RANK[value] > IMPACT_RANK[impact]) impact = value }
    const text = `${art} ${kind}`.toLowerCase()
    if (PHYSICAL_KINDS.test(text)) raise('physisch')
    if (EXTERNAL_KINDS.test(text)) raise('extern')
    raise(declared)
    raise(executorImpact)
    return impact
}

function neverListReason(input: Pick<NewCardInput, 'art' | 'aktion' | 'effects'>): string | null {
    for (const effect of input.effects || []) {
        const label = nieEffekt(effect)
        if (label) return `Nie-Liste: ${label}`
    }
    const text = `${input.art} ${input.aktion?.kind}`.toLowerCase()
    return isNieAktionsart(text) ? `Nie-Liste: Aktionsart „${input.aktion?.kind || input.art}“` : null
}

// ---------------------------------------------------------------------------
// executors
// ---------------------------------------------------------------------------

const executors = new Map<string, CardExecutor>()

export function registerCardExecutor(executor: CardExecutor): void {
    if (!executor || !KIND_PATTERN.test(String(executor.kind))) throw new Error('Ungültige Karten-Aktionsart')
    if (neverListReason({ art: executor.kind, aktion: { kind: executor.kind, ref: 'x' } })) throw new Error('Nie-Liste: kein Ausführer erlaubt')
    executors.set(executor.kind, executor)
}

export function unregisterCardExecutor(kind: string): void {
    executors.delete(kind)
}

export function getCardExecutor(kind: string): CardExecutor | undefined {
    return executors.get(kind)
}

function alwaysAllowed(card: ApprovalCard): boolean {
    if (card.wirkung !== 'intern') return false
    // Fixed in code: some kinds only ever run with a single "Ja" (e.g. vllm-wechsel).
    if (isNurEinzelnesJa(card.aktion?.kind) || isNurEinzelnesJa(card.art)) return false
    // P9: the same exclusions as the trust ladder, on the card's policy kind.
    const policyKind = policyKindForCard(card.aktion?.kind)
    if (!policyKind || isStandingExcluded(policyKind)) return false
    const executor = executors.get(card.aktion.kind)
    try { return executor?.allowAlways?.(card) === true } catch { return false }
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

const baseDir = (opts: CardStoreOptions = {}) => opts.dataDir || getNovaDataDir()
const storeDir = (opts: CardStoreOptions = {}) => join(baseDir(opts), 'approval-cards')
const cardsFile = (opts: CardStoreOptions = {}) => join(storeDir(opts), 'cards.json')
/**
 * Card protocol (2.82.0): was `gedanken.jsonl`, easily confused with the
 * planner's thoughts (`thoughts/thoughts.json`). Now `karten-protokoll.jsonl`;
 * an old file is renamed once on first access (nothing lost, nothing doubled).
 */
export const CARD_PROTOCOL_FILE = 'karten-protokoll.jsonl'
const LEGACY_CARD_PROTOCOL_FILE = 'gedanken.jsonl'
const thoughtsFile = (opts: CardStoreOptions = {}) => {
    const file = join(storeDir(opts), CARD_PROTOCOL_FILE)
    const legacy = join(storeDir(opts), LEGACY_CARD_PROTOCOL_FILE)
    if (!existsSync(file) && existsSync(legacy)) { try { renameSync(legacy, file) } catch { /* next access retries */ } }
    return file
}
const nowOf = (opts: CardStoreOptions = {}) => (opts.now || Date.now)()
const iso = (ms: number) => new Date(ms).toISOString()

function loadCards(opts: CardStoreOptions = {}): ApprovalCard[] {
    try {
        const raw = JSON.parse(readFileSync(cardsFile(opts), 'utf8'))
        return raw?.version === 1 && Array.isArray(raw.cards) ? raw.cards : []
    } catch { return [] }
}

function saveCards(cards: ApprovalCard[], opts: CardStoreOptions = {}): void {
    mkdirSync(storeDir(opts), { recursive: true, mode: 0o700 })
    // Oldest settled cards go first; open cards are always kept.
    let kept = cards
    if (kept.length > STORE_LIMIT) {
        const open = kept.filter(card => card.status === 'offen' || card.status === 'spaeter')
        const settled = kept.filter(card => !(card.status === 'offen' || card.status === 'spaeter'))
        kept = [...settled.slice(-(STORE_LIMIT - open.length)), ...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }
    atomicWriteJsonSync(cardsFile(opts), { version: 1, cards: kept })
}

const clean = (value: unknown, max: number) => redactSecrets(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, max)

export function noteThought(entry: Omit<ThoughtEntry, 'at'> & { at?: string }, opts: CardStoreOptions = {}): void {
    try {
        mkdirSync(storeDir(opts), { recursive: true, mode: 0o700 })
        const file = thoughtsFile(opts)
        if (existsSync(file) && statSync(file).size > THOUGHT_LIMIT_BYTES) {
            // Bounded: keep the newer half.
            const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
            writeFileSync(file, `${lines.slice(-Math.floor(lines.length / 2)).join('\n')}\n`, { mode: 0o600 })
        }
        const line: ThoughtEntry = {
            at: entry.at || iso(nowOf(opts)), quelle: clean(entry.quelle, 40), titel: clean(entry.titel, 160), status: clean(entry.status, 40),
            ...(entry.text ? { text: clean(entry.text, 400) } : {}),
        }
        appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    } catch { /* thoughts are visibility, never a reason to fail */ }
}

export function readThoughts(opts: CardStoreOptions = {}, limit = 50): ThoughtEntry[] {
    try {
        return readFileSync(thoughtsFile(opts), 'utf8').split('\n').filter(Boolean).slice(-limit).flatMap(line => {
            try { return [JSON.parse(line) as ThoughtEntry] } catch { return [] }
        })
    } catch { return [] }
}

let defaultLedger: CardLedger | null = null
async function ledgerFor(opts: CardStoreOptions): Promise<CardLedger | null> {
    if (opts.ledger !== undefined) return opts.ledger
    if (opts.dataDir) {
        const { OutcomeLedger } = await import('./outcome-ledger.js')
        return new OutcomeLedger(join(opts.dataDir, 'outcome-ledger', 'decisions'), false)
    }
    if (!defaultLedger) {
        const { OutcomeLedger } = await import('./outcome-ledger.js')
        defaultLedger = new OutcomeLedger(getNovaDataDir('outcome-ledger', 'decisions'), false)
    }
    return defaultLedger
}

// ---------------------------------------------------------------------------
// cards
// ---------------------------------------------------------------------------

const newToken = () => randomBytes(8).toString('hex')

function issueButtons(card: Pick<ApprovalCard, 'wirkung' | 'aktion'> & Partial<ApprovalCard>): CardButton[] {
    const answers: CardAnswer[] = ['ja', 'nein', 'spaeter']
    if (alwaysAllowed(card as ApprovalCard)) answers.push('immer')
    return answers.map(answer => ({ token: newToken(), answer }))
}

export function createApprovalCard(input: NewCardInput, opts: CardStoreOptions = {}): { ok: true; card: ApprovalCard; created: boolean } | { ok: false; reason: string } {
    const art = String(input?.art || '').toLowerCase()
    const kind = String(input?.aktion?.kind || '').toLowerCase()
    const titel = clean(input?.titel, 160) || art
    const never = neverListReason({ art, aktion: { kind, ref: String(input?.aktion?.ref || '') }, effects: input?.effects })
    if (never) {
        noteThought({ quelle: clean(input?.quelle || art, 40), titel, status: 'verworfen', text: `${never} — keine Karte` }, opts)
        return { ok: false, reason: never }
    }
    if (!KIND_PATTERN.test(art) || !KIND_PATTERN.test(kind)) return { ok: false, reason: 'Ungültige Art/Aktionsart' }
    const ref = String(input.aktion.ref || '')
    if (!REF_PATTERN.test(ref)) return { ok: false, reason: 'Ungültige Aktions-Referenz' }
    const now = nowOf(opts)
    const cards = loadCards(opts)
    const dedupeKey = input.dedupeKey ? clean(input.dedupeKey, 200) : undefined
    if (dedupeKey) {
        const open = cards.find(card => card.dedupeKey === dedupeKey && (card.status === 'offen' || card.status === 'spaeter') && Date.parse(card.expiresAt) > now)
        if (open) return { ok: true, card: open, created: false }
    }
    const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(input.ablaufMs) || DEFAULT_TTL_MS))
    const wirkung = classifyImpact(art, kind, input.wirkung, executors.get(kind)?.impact)
    const base = {
        id: `k${randomBytes(6).toString('hex')}`, art, titel, beleg: clean(input.beleg, 1200), vorschlag: clean(input.vorschlag, 600),
        aktion: { kind, ref }, wirkung, stufe: 'fragen' as const, node: clean(input.node || 'main', 80), quelle: clean(input.quelle || art, 40),
        ...(dedupeKey ? { dedupeKey } : {}),
        createdAt: iso(now), expiresAt: iso(now + ttl), status: 'offen' as const, usedTokens: [], messages: [],
    }
    const zustellung = cardDeliveryFor({ wirkung, ttlMs: ttl, wichtigkeit: input.wichtigkeit, text: `${art} ${kind} ${base.quelle} ${titel} ${base.beleg}` })
    const short = (value: unknown, max: number) => { const v = clean(value, max); return v || undefined }
    const bundle = input.buendel && KIND_PATTERN.test(String(input.buendel)) ? {
        buendel: String(input.buendel),
        ...(short(input.kurz, 80) ? { kurz: short(input.kurz, 80) } : {}),
        ...(input.gruppe && REF_PATTERN.test(String(input.gruppe)) ? { gruppe: String(input.gruppe) } : {}),
        ...(short(input.knopf, 24) ? { knopf: short(input.knopf, 24) } : {}),
    } : {}
    const card: ApprovalCard = { ...base, zustellung, ...bundle, ...(input.wichtigkeit === 'hoch' ? { wichtig: true } : {}), buttons: issueButtons(base) }
    saveCards([...cards, card], opts)
    noteThought({ quelle: card.quelle, titel: card.titel, status: 'vorgeschlagen', text: card.vorschlag }, opts)
    return { ok: true, card, created: true }
}

export function listApprovalCards(opts: CardStoreOptions & { status?: CardStatus | CardStatus[]; limit?: number } = {}): ApprovalCard[] {
    const wanted = opts.status ? new Set(Array.isArray(opts.status) ? opts.status : [opts.status]) : null
    const cards = loadCards(opts).filter(card => !wanted || wanted.has(card.status))
    return opts.limit ? cards.slice(-opts.limit) : cards
}

const LABELS: Record<CardAnswer, string> = { ja: '✅ Ja', nein: '❌ Nein', spaeter: '⏰ Später', immer: '♾️ Immer erlauben' }
const ANSWER_TEXT: Record<CardAnswer, string> = { ja: 'Ja', nein: 'Nein', spaeter: 'Später', immer: 'Immer erlauben' }

export function cardKeyboard(card: ApprovalCard): Array<Array<{ text: string; callback_data: string }>> {
    if (card.status !== 'offen') return []
    const button = (item: CardButton) => ({ text: LABELS[item.answer], callback_data: `${CALLBACK_PREFIX}${item.token}` })
    const rows = [card.buttons.filter(item => item.answer !== 'immer').map(button)]
    const always = card.buttons.find(item => item.answer === 'immer')
    if (always && card.wirkung === 'intern') rows.push([button(always)])
    return rows
}

const IMPACT_TEXT: Record<CardImpact, string> = { intern: 'intern', infra: 'Infrastruktur (VMs) — fragt immer', physisch: 'physisch — fragt immer', extern: 'nach außen — fragt immer' }

/**
 * Paket L: the Telegram text of a card — title + proposal, short (<= 600) and
 * without technical identifiers. Evidence, kind and validity stay available
 * behind „Details“ (`formatCardText`).
 */
export function formatCardTextShort(card: ApprovalCard): string {
    const title = ownerText(card.titel) || card.art
    const proposal = ownerText(card.vorschlag)
    const lines = [`🔘 ${title}`]
    if (proposal && proposal !== title) lines.push(proposal.length > 360 ? `${proposal.slice(0, 359)}…` : proposal)
    if (card.wirkung !== 'intern') lines.push(card.wirkung === 'physisch' ? 'Wirkt im Raum — fragt jedes Mal.' : card.wirkung === 'extern' ? 'Geht nach außen — fragt jedes Mal.' : 'Betrifft Infrastruktur — fragt jedes Mal.')
    if (card.status !== 'offen') {
        const answer = card.answer ? ANSWER_TEXT[card.answer] : card.status
        lines.push('', card.status === 'abgelaufen' ? '⌛ Abgelaufen — nichts ausgeführt; steht im nächsten Bericht.'
            : card.status === 'erledigt' ? '☑️ Anderweitig erledigt.'
            : `→ ${answer}${card.result ? `: ${ownerText(card.result.message)}` : ''}`)
    }
    const text = lines.join('\n')
    return text.length > OWNER_PAGE_CHARS ? `${text.slice(0, OWNER_PAGE_CHARS - 1)}…` : text
}

/** Plain text (no Markdown) so evidence can never break the message. */
export function formatCardText(card: ApprovalCard): string {
    const lines = [
        `🔘 ${card.titel}`,
        `Beleg: ${card.beleg || '—'}`,
        `Vorschlag: ${card.vorschlag || '—'}`,
        `Art: ${card.art} · Wirkung: ${IMPACT_TEXT[card.wirkung]} · Knoten: ${card.node}`,
        `Gültig bis: ${card.expiresAt.slice(0, 16).replace('T', ' ')} UTC`,
    ]
    if (card.status !== 'offen') {
        const when = card.decidedAt ? card.decidedAt.slice(11, 16) : ''
        const answer = card.answer ? ANSWER_TEXT[card.answer] : card.status
        lines.push('', card.status === 'abgelaufen' ? '⌛ Abgelaufen — nichts ausgeführt.'
            : card.status === 'erledigt' ? '☑️ Anderweitig erledigt.'
            : `→ ${answer}${when ? ` (${when} UTC)` : ''}${card.result ? `: ${card.result.message}` : ''}`)
    }
    return lines.join('\n')
}

/** Owner = numeric Telegram id listed in allowFrom (usernames never count). Shared with /desktop buttons. */
export function isCardOwner(userId: string, ownerIds: readonly string[]): boolean {
    const id = String(userId ?? '').trim()
    if (!/^\d{1,20}$/.test(id)) return false
    return ownerIds.some(entry => /^\d{1,20}$/.test(String(entry).trim()) && String(entry).trim() === id)
}

function updateCard(id: string, patch: Partial<ApprovalCard>, opts: CardStoreOptions): ApprovalCard | undefined {
    const cards = loadCards(opts)
    const index = cards.findIndex(card => card.id === id)
    if (index < 0) return undefined
    cards[index] = { ...cards[index], ...patch }
    saveCards(cards, opts)
    return cards[index]
}

async function record(card: ApprovalCard, opts: CardStoreOptions, extra: Record<string, unknown> = {}): Promise<void> {
    try {
        const ledger = await ledgerFor(opts)
        ledger?.recordApproval(`approval-card-${card.id}`, {
            kind: 'approval-card', cardId: card.id, art: card.art, aktion: card.aktion, wirkung: card.wirkung, node: card.node,
            answer: card.answer, status: card.status, decidedBy: card.decidedBy, decidedAt: card.decidedAt, result: card.result, ...extra,
        })
    } catch (error) {
        console.warn(`[Knopf-Karten] Ledger nicht schreibbar: ${String((error as Error)?.message || error).slice(0, 160)}`)
    }
}

/**
 * Answer a button press. All checks and the token consumption happen
 * synchronously (no await between read and write), so two concurrent presses
 * can never both pass.
 */
export async function answerApprovalCard(callbackData: string, presser: { userId: string; ownerIds: readonly string[]; via?: 'telegram' | 'even-g2' | 'desktop' }, opts: CardStoreOptions = {}): Promise<CardAnswerResult> {
    const data = String(callbackData ?? '')
    const token = data.startsWith(CALLBACK_PREFIX) ? data.slice(CALLBACK_PREFIX.length) : ''
    if (!TOKEN_PATTERN.test(token)) return { ok: false, code: 'unbekannt', message: 'Unbekannter Knopf.' }
    if (!isCardOwner(presser?.userId, presser?.ownerIds || [])) return { ok: false, code: 'kein-owner', message: '🔒 Nur der Owner kann diese Karte beantworten.' }
    const now = nowOf(opts)
    const cards = loadCards(opts)
    const index = cards.findIndex(card => card.buttons.some(button => button.token === token) || card.usedTokens.includes(token))
    if (index < 0) return { ok: false, code: 'unbekannt', message: 'Unbekannte oder gelöschte Karte.' }
    const card = cards[index]
    const button = card.buttons.find(item => item.token === token)
    if (!button || card.status !== 'offen') return { ok: false, code: 'verbraucht', message: 'Diese Karte wurde bereits beantwortet.', card }
    const consume = (patch: Partial<ApprovalCard>): ApprovalCard => {
        cards[index] = { ...card, ...patch, buttons: [], usedTokens: [...card.usedTokens, ...card.buttons.map(item => item.token)].slice(-40) }
        saveCards(cards, opts)
        return cards[index]
    }
    if (now > Date.parse(card.expiresAt)) {
        const expired = consume({ status: 'abgelaufen' })
        noteThought({ quelle: card.quelle, titel: card.titel, status: 'abgelaufen' }, opts)
        await record(expired, opts, { refused: 'abgelaufen' })
        return { ok: false, code: 'abgelaufen', message: 'Karte abgelaufen — nichts ausgeführt.', card: expired }
    }
    const never = neverListReason({ art: card.art, aktion: card.aktion })
    if (never) {
        const refused = consume({ status: 'nein', result: { ok: false, message: never } })
        await record(refused, opts, { refused: 'nie-liste' })
        return { ok: false, code: 'nie-liste', message: never, card: refused }
    }
    if (button.answer === 'immer' && !alwaysAllowed(card)) {
        // Never consume here: the token should not exist for such a card at all.
        return { ok: false, code: 'nicht-erlaubt', message: '„Immer erlauben“ gibt es für diese Aktionsart nicht.', card }
    }
    // The channel only labels who answered; the owner check above is the same for every channel.
    const decidedBy = `${presser.via === 'even-g2' || presser.via === 'desktop' ? presser.via : 'telegram'}:${String(presser.userId).trim()}`
    const decidedAt = iso(now)
    if (button.answer === 'spaeter') {
        const resendAt = Math.min(now + SNOOZE_MS, Date.parse(card.expiresAt))
        const later = consume({ status: 'spaeter', answer: 'spaeter', decidedAt, decidedBy, resendAt: iso(resendAt) })
        noteThought({ quelle: card.quelle, titel: card.titel, status: 'später' }, opts)
        await record(later, opts)
        return { ok: true, code: 'ok', message: `Später: ich frage um ${iso(resendAt).slice(11, 16)} UTC wieder.`, card: later }
    }
    const status: CardStatus = button.answer
    const decided = consume({ status, answer: button.answer, decidedAt, decidedBy })
    const executor = executors.get(card.aktion.kind)
    const ctx: CardDecisionContext = { decidedBy, userId: String(presser.userId).trim() }
    const policyKind = policyKindForCard(card.aktion.kind)
    const trustOpts = { dataDir: opts.dataDir, now: opts.now }
    let standingNote = ''
    if (button.answer === 'immer' && policyKind) {
        // P9: the one permission store. The grant is the owner's decision, made before the run.
        let subject: string | null | undefined
        try { subject = executor?.standingSubject ? executor.standingSubject(decided) : decided.aktion.ref } catch { subject = null }
        const grant = subject ? grantStanding(policyKind, subject, decidedBy, trustOpts) : { ok: false, message: 'kein Subjekt' }
        standingNote = grant.ok ? ` (${grant.message})` : ` (keine dauerhafte Erlaubnis: ${grant.message})`
    }
    let result: CardExecutionResult
    try {
        if (button.answer === 'nein') result = executor?.reject ? await executor.reject(decided, ctx) : { ok: true, message: 'Abgelehnt.' }
        else result = executor ? await executor.execute(decided, button.answer, ctx) : { ok: false, message: 'Kein Ausführungsweg für diese Aktionsart registriert — nichts ausgeführt.' }
    } catch (error) {
        result = { ok: false, message: `Fehler: ${clean((error as Error)?.message || error, 200)}` }
    }
    if (standingNote) result = { ...result, message: `${result.message}${standingNote}` }
    // P9: every card answer feeds the trust ladder under the policy kind. A „Nein“ always
    // resets; a „Ja“ only counts for internal cards (infra/physical/external always ask).
    if (policyKind && executor) {
        if (button.answer === 'nein') recordOwnerAnswer(policyKind, 'nein', trustOpts)
        else if (decided.wirkung !== 'intern') { /* never climbs the ladder */ }
        else if (result.completion) {
            result.completion.then(outcome => recordActionOutcome(policyKind, { ok: outcome?.ok === true, rolledBack: outcome?.rolledBack === true, approvedByOwner: true }, trustOpts),
                () => recordActionOutcome(policyKind, { ok: false, approvedByOwner: true }, trustOpts))
        } else recordActionOutcome(policyKind, { ok: result.ok === true, approvedByOwner: true }, trustOpts)
    }
    const final = updateCard(card.id, { result: { ok: result.ok === true, message: clean(result.message, 400) } }, opts) || decided
    noteThought({ quelle: card.quelle, titel: card.titel, status: button.answer === 'nein' ? 'abgelehnt' : 'angenommen', text: final.result?.message }, opts)
    await record(final, opts)
    if (button.answer === 'immer' || button.answer === 'nein') {
        // Kausales Gedächtnis: the owner's standing answer with the card's evidence as reason (Main only).
        try {
            const { recordCardDecision } = await import('./decisions.js')
            recordCardDecision(final, { dataDir: opts.dataDir, now: opts.now })
        } catch { /* memory is evidence, never a reason to fail the answer */ }
    }
    return { ok: true, code: 'ok', message: `${ANSWER_TEXT[button.answer]}: ${final.result?.message || ''}`.trim(), card: final }
}

/** Expire overdue cards, resurface snoozed ones with fresh tokens, close cards settled elsewhere. */
export function maintainApprovalCards(opts: CardStoreOptions = {}): { expired: ApprovalCard[]; resurfaced: ApprovalCard[]; settled: ApprovalCard[]; reminded: ApprovalCard[] } {
    const now = nowOf(opts)
    const cards = loadCards(opts)
    const expired: ApprovalCard[] = [], resurfaced: ApprovalCard[] = [], settled: ApprovalCard[] = [], reminded: ApprovalCard[] = []
    let changed = false
    for (let index = 0; index < cards.length; index++) {
        const card = cards[index]
        if (card.status !== 'offen' && card.status !== 'spaeter') continue
        const retire = (status: CardStatus) => {
            cards[index] = { ...card, status, buttons: [], usedTokens: [...card.usedTokens, ...card.buttons.map(item => item.token)].slice(-40) }
            changed = true
            return cards[index]
        }
        if (now > Date.parse(card.expiresAt)) { expired.push(retire('abgelaufen')); continue }
        const executor = executors.get(card.aktion.kind)
        let open = true
        try { open = executor?.isStillOpen ? executor.isStillOpen(card) !== false : true } catch { open = true }
        if (!open) { settled.push(retire('erledigt')); continue }
        if (card.status === 'spaeter' && card.resendAt && now >= Date.parse(card.resendAt)) {
            cards[index] = { ...card, status: 'offen', buttons: issueButtons(card), resendAt: undefined, messages: [], deliveredAt: undefined }
            resurfaced.push(cards[index])
            changed = true
            continue
        }
        // Paket L: never expire silently — exactly one reminder in the last quarter of the
        // validity (same tokens; the first press still consumes every copy). A bundled card
        // is reminded by its bundle message (card-bundle.ts).
        const ttl = Date.parse(card.expiresAt) - Date.parse(card.createdAt)
        if (card.status === 'offen' && !card.erinnertAt && (card.deliveredAt || card.buendel) && Date.parse(card.expiresAt) - now <= ttl / 4) {
            cards[index] = { ...card, erinnertAt: iso(now), ...(card.buendel ? {} : { deliveredAt: undefined, freigegebenAt: card.freigegebenAt || iso(now) }) }
            reminded.push(cards[index])
            changed = true
        }
    }
    if (changed) saveCards(cards, opts)
    for (const card of expired) noteThought({ quelle: card.quelle, titel: card.titel, status: 'abgelaufen' }, opts)
    return { expired, resurfaced, settled, reminded }
}

/** Paket L: cards that expired without an answer in [since, until] — listed once in the report. */
export function expiredCardsSince(since: number, until: number, opts: CardStoreOptions = {}): ApprovalCard[] {
    return loadCards(opts).filter(card => card.status === 'abgelaufen' && !card.answer && Date.parse(card.expiresAt) >= since && Date.parse(card.expiresAt) <= until)
}

/** P8: open, not yet delivered cards that wait for the next report (still >= 2 h valid). */
export function bundledCards(opts: CardStoreOptions = {}): ApprovalCard[] {
    const now = nowOf(opts)
    return loadCards(opts).filter(card => card.status === 'offen' && !card.deliveredAt && card.zustellung === 'bericht' && !card.freigegebenAt && !card.buendel
        && Date.parse(card.expiresAt) - now >= BUNDLE_MIN_REMAINING_MS)
}

/** true when the card loop may deliver this card now (bundling only while a report is active). */
export function isCardDue(card: ApprovalCard, options: { bundleIntoReport?: boolean; now?: number } = {}): boolean {
    if (!options.bundleIntoReport || card.zustellung !== 'bericht' || card.freigegebenAt) return true
    // A bundled card that would expire before it could be answered becomes time-critical.
    return Date.parse(card.expiresAt) - (options.now ?? Date.now()) < BUNDLE_MIN_REMAINING_MS
}

/** Called after a report listed the bundled cards: the card loop delivers them right after. */
export function releaseBundledCards(opts: CardStoreOptions = {}): number {
    const ids = new Set(bundledCards(opts).map(card => card.id))
    if (!ids.size) return 0
    const at = iso(nowOf(opts))
    const cards = loadCards(opts).map(card => ids.has(card.id) ? { ...card, freigegebenAt: at } : card)
    saveCards(cards, opts)
    return ids.size
}

/**
 * P9: an owner command (`/patch approve`, `/setup approve`) asks for this open
 * card now: due at once (never bundled), and sent again if it was delivered
 * before. Same tokens — the first press still consumes every copy.
 */
export function requestCardRedelivery(cardId: string, opts: CardStoreOptions = {}): ApprovalCard | undefined {
    const card = loadCards(opts).find(item => item.id === cardId)
    if (!card || card.status !== 'offen') return undefined
    return updateCard(cardId, { deliveredAt: undefined, freigegebenAt: iso(nowOf(opts)) }, opts)
}

/** Remember where a card was delivered (so the press can edit all copies). */
export function recordCardDelivery(cardId: string, messages: Array<{ chatId: string; messageId: number }>, opts: CardStoreOptions = {}): ApprovalCard | undefined {
    const previous = loadCards(opts).find(item => item.id === cardId)?.messages || []
    return updateCard(cardId, { messages: [...previous, ...messages].slice(-5), deliveredAt: iso(nowOf(opts)) }, opts)
}
