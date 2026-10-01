/**
 * Kausales Gedächtnis (Dots-Parität, Phase 8): Entscheidungen dauerhaft und
 * nachvollziehbar merken.
 *
 *   Eintrag = Entscheidung + Warum (Beleg) + wer/wann + gültig bis / Widerruf
 *             + wovon abhängig
 *
 * Beispiele: „Telegram nur am Main (Alfred 30.09., Grund: ein Konsument) — gilt
 * bis widerrufen“, „Release-Knopf per Deploy-Key“, „Druck nie ohne Knopf“.
 *
 * Quellen (selbstständig, ohne Befehl und ohne Rückfrage angelegt; der
 * Abendbericht nennt jeden neuen Eintrag):
 *   owner-nachricht  Anweisungen des Owners im Direktchat („ab jetzt …“,
 *                    „immer …“, „nie …“, „du entscheidest …“) → bindend
 *   knopf            Knopf-Antworten „Immer erlauben“ / „Nein“ mit dem Beleg
 *                    der Karte als Grund → bindend
 *   mission          Abschluss/Übergabe einer Mission → Befund (nicht bindend)
 *   delegation       geprüftes Ergebnis einer Delegation → Befund (nicht bindend)
 *   befehl           /entscheidungen (Widerruf, Klärung)
 *
 * Feste Regeln (Code, nicht Config):
 * - Nur Owner-Quellen erzeugen bindende Entscheidungen. Nicht-Owner, Gruppen,
 *   systemerzeugte Nachrichten und Webinhalte erzeugen nie einen Eintrag.
 * - Nur der Main schreibt (nie mit NOVA_NODE_ONLY, nur mit Main-Autorität).
 *   Worker übernehmen nichts.
 * - Keine Secrets: jeder Text läuft durch redactSecrets plus eine Regel für
 *   „Passwort ist …“-Sätze.
 * - Eine Entscheidung kann die Nie-Liste nie aufheben und Karten für
 *   physische/externe Aktionen, Geld oder Löschen nie abschalten. Eine solche
 *   Anweisung wird gespeichert, aber als „nicht wirksam: feste Grenze“
 *   markiert.
 * - In die Aktions-Policy fließen Entscheidungen nur verschärfend ein
 *   („Druck nie ohne Knopf“ → fragen, „nie Modell wechseln“ → nie). Lockernde
 *   Entscheidungen wirken nur als Kontext; das Level setzt weiter der Kern.
 * - Widerspruch zu einer bestehenden Entscheidung: ausdrücklich („statt“,
 *   „nicht mehr“, „ab sofort gilt“ …) → die neuere gewinnt, die alte wird
 *   „ersetzt“. Sonst wird genau einmal nachgefragt; die Antwort („ja, die
 *   neue“ / „nein, die alte“) oder /entscheidungen klärt.
 * - Abgelaufenes („bis Freitag“, „für 3 Tage“, „heute“) fällt heraus.
 * - Größe begrenzt (MAX_ITEMS, Texte gekürzt). Kein LanceDB-Schreiben.
 *
 * Datei: `<data>/decisions/decisions.json` { version: 1, items }.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'
import { AKTIONSARTEN, isNieAktionsart, isPhysischOderExtern, setDecisionConstraintProvider, type DecisionConstraint } from './action-policy.js'
import { redactSecrets } from '../security/secret-redaction.js'

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type DecisionStatus = 'aktiv' | 'rueckfrage' | 'ersetzt' | 'widerrufen' | 'abgelaufen' | 'verworfen'
export type DecisionSourceKind = 'owner-nachricht' | 'knopf' | 'mission' | 'delegation' | 'befehl'
export type DecisionPolarity = 'pos' | 'neg' | 'nur'
export type DecisionEffect = 'strenger' | 'lockernd' | 'neutral'

export interface DecisionSource { art: DecisionSourceKind; von: string; kanal?: string; ref?: string }

export interface Decision {
    id: string
    text: string
    warum: string
    quelle: DecisionSource
    at: string
    bindend: boolean
    gueltigBis?: string
    status: DecisionStatus
    statusAt?: string
    statusGrund?: string
    abhaengigVon: string[]
    ersetzt?: string
    ersetztDurch?: string
    konfliktMit?: string
    themen: string[]
    polaritaet: DecisionPolarity
    wirkung: DecisionEffect
    wirksam: boolean
    nichtWirksamGrund?: string
    constraint?: { mode: 'fragen' | 'nie'; arten: string[] }
    bestaetigtAt?: string
}

export interface DecisionOptions {
    dataDir?: string
    now?: () => number
    /** True only on the fenced Main. Default: what startDecisionMemory set (otherwise false). */
    isMain?: () => boolean
}

export interface ParsedDirective {
    text: string
    warum?: string
    gueltigBis?: string
    polaritaet: DecisionPolarity
    themen: string[]
    wirkung: DecisionEffect
    wirksam: boolean
    nichtWirksamGrund?: string
    constraint?: { mode: 'fragen' | 'nie'; arten: string[] }
    ausdruecklich: boolean
}

export interface OwnerMessage {
    text: string
    permission?: string
    principalId?: string
    channel?: string
    isGroup?: boolean
    systemAuthored?: boolean
}

export interface ObserveResult {
    created: Decision[]
    confirmed: Decision[]
    replaced: Decision[]
    revoked: Decision[]
    conflicts: Array<{ neu: Decision; alt: Decision }>
    resolved?: { decision: Decision; gewinner: 'neu' | 'alt' }
    skipped?: string
}

// ---------------------------------------------------------------------------
// limits and fixed vocabulary
// ---------------------------------------------------------------------------

export const MAX_ITEMS = 400
const MAX_TEXT = 240
const MAX_WARUM = 300
const MAX_MESSAGE = 800
const MAX_CONTEXT_ITEMS = 5
const MAX_CONTEXT_CHARS = 1_400
const CONFLICT_TTL_MS = 3 * 24 * 60 * 60_000
const CARD_NEIN_TTL_MS = 30 * 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000

const STRONG_MARKER = /\b(ab (jetzt|sofort|heute|morgen)|von nun an|k(ü|ue)nftig|in zukunft|du entscheidest|entscheide (du )?selbst|das entscheidest du|grunds(ä|ae)tzlich|grundregel|merk dir|regel:|entscheidung:)/
const WEAK_MARKER = /\b(immer|nie|niemals|nur noch)\b/
const NARRATIVE = /\b(noch nie|schon immer|wie immer|fast immer|immer noch|immer wieder|immer mehr|nie wieder so|warum|wieso|weshalb)\b/
const QUESTION_START = /^(wie|was|warum|wieso|weshalb|wann|wo|wer|welche[rsnm]?|kannst|kann|könntest|koenntest|ist|sind|hast|hat|gibt|bist|darf|soll|sollte|machst|weißt|weisst)\b/
const PAST = /\b(hat|hatte|hattest|war|waren|wurde|wurden|habe|haben)\b[^.]*\b(nie|immer)\b/
const NEG = /\b(nie|niemals|nicht|kein|keine|keinen|keinem|keiner|verboten|unterlass\w*)\b/
const ONLY = /\bnur\b/
/** „ohne Knopf/Frage …“ — verschärfend nur zusammen mit einer Verneinung („nie ohne Knopf“). */
const OHNE_ASK = /ohne (vorher )?(zu )?(knopf|karte|frage|fragen|r(ü|ue)ckfrage|freigabe|best(ä|ae)tigung|mich zu fragen)/
const ASK_ALWAYS = /(immer (vorher )?(fragen|nachfragen|r(ü|ue)ckfrage)|nur (mit|nach) (knopf|karte|freigabe|r(ü|ue)ckfrage|best(ä|ae)tigung)|frag(e)? (mich )?(immer|vorher))/
const PERMISSIVE = /(ohne (zu )?(fragen|frage|r(ü|ue)ckfrage|knopf|karte|freigabe|best(ä|ae)tigung)|nicht (mehr )?(nach)?fragen|kein(en)? knopf|automatisch|selbst(st(ä|ae)ndig)?|du entscheidest|entscheide (du )?selbst|das entscheidest du|immer erlauben|darfst|einfach (machen|tun|erledigen))/
const EXPLICIT = /\b(stattdessen|statt|nicht mehr|ab sofort gilt|neu gilt|ersetzt|ersetze|(ä|ae)nder(e|ung)|doch)\b/
const REVOKE = /\b(widerruf\w*|vergiss|gilt nicht mehr|nicht mehr g(ü|ue)ltig|aufgehoben|hebe?\b.*\bauf|streich\w*)\b/
const GELD = /geld|euro|€|\$|bezahl|zahlung|rechnung|(ü|ue)berweis|kauf|bestell|abo\b/
const LOESCHEN = /l(ö|oe)sch|delete|entfern|wipe|purge|\brm\b/
const REASON = /(?:,\s*|\s+-\s+|\s+|\(\s*)(?:weil|da|denn|grund:?|begr(ü|ue)ndung:?)\s+(.+?)\)?[.!]?$/i
const ANSWER_NEU = /^(ja\b|neu\b|die neue|die neuere|neuere|nimm die neue|ersetz\w*)/
const ANSWER_ALT = /^(nein\b|alt\b|die alte|bleib\w*|behalte?|lass es)/
const ANSWER_WINDOW_MS = 6 * 60 * 60_000
const NO_ASKING = /nicht (mehr )?(nach)?fragen|kein(en)? knopf/
const LEAD = /^(ab (jetzt|sofort|heute)|von nun an|k(ü|ue)nftig|in zukunft)[,:]?\s+/i

const STOPWORDS = new Set([
    'ab', 'jetzt', 'sofort', 'heute', 'morgen', 'immer', 'nie', 'niemals', 'nicht', 'nur', 'noch', 'kein', 'keine', 'keinen', 'keinem', 'keiner',
    'bitte', 'du', 'dich', 'dir', 'ich', 'mir', 'mich', 'wir', 'uns', 'das', 'der', 'die', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
    'und', 'oder', 'aber', 'ohne', 'mit', 'am', 'an', 'auf', 'im', 'in', 'zu', 'zum', 'zur', 'vom', 'von', 'bei', 'beim', 'aus', 'fuer', 'für', 'wenn', 'dann',
    'auch', 'mehr', 'entscheidest', 'entscheide', 'entscheidung', 'selbst', 'grund', 'weil', 'da', 'denn', 'bis', 'gilt', 'gelten', 'soll', 'sollst',
    'sollen', 'musst', 'muss', 'darfst', 'darf', 'kannst', 'kann', 'wird', 'werden', 'ist', 'sind', 'sein', 'hast', 'hat', 'haben', 'mal', 'so', 'es',
    'er', 'sie', 'wie', 'was', 'wo', 'als', 'nun', 'kuenftig', 'künftig', 'zukunft', 'grundsaetzlich', 'grundsätzlich', 'regel', 'merk', 'alles',
    'alle', 'jede', 'jeder', 'jedes', 'mein', 'meine', 'dein', 'deine', 'sein', 'ihre', 'statt', 'stattdessen', 'doch', 'neu', 'neue', 'alte',
    'ja', 'nein', 'hier', 'dort', 'dabei', 'dazu', 'damit', 'machen', 'mache', 'mach', 'tun', 'einfach', 'automatisch', 'erlauben', 'erlaubt',
    'frag', 'frage', 'fragen', 'vorher', 'the', 'and', 'for', 'always', 'never', 'only', 'nicht', 'mehr', 'widerrufen', 'widerruf', 'vergiss',
    'gültig', 'gueltig', 'aufgehoben', 'heb', 'hebe', 'streiche', 'streich', 'tage', 'tag', 'wochen', 'woche', 'stunden', 'stunde', 'monate',
    'monat', 'ende', 'widerrufe', 'neuere', 'aendere', 'ändere', 'ersetzt', 'ersetze', 'dieser', 'diese', 'dieses', 'alfred',
])

/** Keyword stems per known action kind (only for tightening constraints). */
const KIND_KEYWORDS: ReadonlyArray<[string, RegExp]> = [
    ['drucken', /druck|print|plott/],
    ['schalten', /schalt|licht|heizung|klima|steckdose|home-?assistant/],
    ['dienst-neustart', /neustart|neu starten|restart|neu gestartet/],
    ['modell-wechseln', /modell|model\b/],
    ['install-katalog', /install/],
    ['config-aendern', /config|konfig/],
    ['release-ausrollen', /release|ausroll|rollout/],
    ['patch-anwenden', /patch/],
    ['mail-senden', /mail/],
    ['nachricht-senden', /nachricht|sms|whatsapp/],
    ['geraet-einrichten', /ger(ä|ae)t/],
    ['self-heal-zyklus', /selbstheil|heilung|self-?heal/],
    ['log-rotation', /\blogs?\b|log-rotation/],
    ['cache-leeren', /cache|zwischenspeicher/],
    ['endpoint-umschalten', /endpoint/],
    ['vm-starten', /\bvms?\b|proxmox/], ['vm-stoppen', /\bvms?\b|proxmox/], ['vm-snapshot', /\bvms?\b|snapshot/],
    ['pve-start', /\bvms?\b|proxmox/], ['pve-herunterfahren', /\bvms?\b|proxmox/], ['pve-snapshot', /snapshot|proxmox/],
    ['pve-rollback', /rollback|proxmox/], ['pve-anlegen', /\bvms?\b|proxmox/], ['pve-anpassen', /\bvms?\b|proxmox/], ['pve-entfernen', /\bvms?\b|proxmox/],
]

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

const lower = (value: unknown) => String(value ?? '').toLowerCase().normalize('NFC')
const fold = (value: string) => value.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')

/** redactSecrets plus „Passwort ist xyz“ in natural language. */
export function scrubSecrets(value: unknown): string {
    return redactSecrets(String(value ?? ''))
        .replace(/\b(passwort|password|kennwort|passphrase|pin|token|api[- ]?key|schl(?:ü|ue)ssel|secret|zugangsdaten)\b(\s*(?:ist|lautet|heißt|heisst|[:=])?\s*)(\S+)/gi, '$1$2[REDACTED]')
}

const clip = (value: unknown, max: number) => scrubSecrets(value).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

function stem(word: string): string {
    let w = fold(word)
    for (const suffix of ['ungen', 'ung', 'en', 'er', 'es', 'e', 'n', 's']) {
        if (w.length - suffix.length >= 4 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break }
    }
    return w
}

/** Topic tokens: content words (≥4 letters, no stop words), lightly stemmed. */
export function topicTokens(text: unknown): string[] {
    const words = lower(text).replace(/[^a-z0-9äöüß\s-]/g, ' ').split(/[\s-]+/)
    const out = new Set<string>()
    for (const word of words) {
        if (word.length < 4 || STOPWORDS.has(word) || STOPWORDS.has(fold(word)) || /^\d+$/.test(word)) continue
        out.add(stem(word))
        if (out.size >= 16) break
    }
    return [...out]
}

function overlap(a: readonly string[], b: readonly string[]): number {
    const set = new Set(b)
    return a.filter(item => set.has(item)).length
}
/** Shared tokens relative to the smaller topic. */
export function topicSimilarity(a: readonly string[], b: readonly string[]): number {
    if (a.length === 0 || b.length === 0) return 0
    return overlap(a, b) / Math.min(a.length, b.length)
}

function polarityOf(text: string): DecisionPolarity {
    if (NEG.test(text)) return 'neg'
    if (ONLY.test(text)) return 'nur'
    return 'pos'
}

function endOfDay(ms: number): number {
    const date = new Date(ms)
    date.setUTCHours(23, 59, 59, 0)
    return date.getTime()
}

/** „bis morgen“, „heute“, „für 3 Tage“, „bis 15.10.“, „bis Ende der Woche“; „bis auf Widerruf“ = unbegrenzt. */
export function parseValidity(text: string, now: number): string | undefined {
    const t = lower(text)
    if (/bis (auf )?widerruf/.test(t)) return undefined
    const dur = /\bf(ü|ue)r (\d{1,3}|eine?n?) (stunden?|tage?n?|wochen?|monate?n?)\b/.exec(t)
    if (dur) {
        const n = /^\d/.test(dur[2]) ? Number(dur[2]) : 1
        const unit = dur[3].startsWith('stunde') ? 3_600_000 : dur[3].startsWith('tag') ? DAY_MS : dur[3].startsWith('woche') ? 7 * DAY_MS : 30 * DAY_MS
        return new Date(now + Math.max(1, n) * unit).toISOString()
    }
    const date = /\bbis (?:zum )?(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/.exec(t)
    if (date) {
        const year = date[3] ? (date[3].length === 2 ? 2000 + Number(date[3]) : Number(date[3])) : new Date(now).getUTCFullYear()
        let at = Date.UTC(year, Number(date[2]) - 1, Number(date[1]), 23, 59, 59)
        if (!date[3] && at < now) at = Date.UTC(year + 1, Number(date[2]) - 1, Number(date[1]), 23, 59, 59)
        return Number.isFinite(at) ? new Date(at).toISOString() : undefined
    }
    if (/\bbis (ende der woche|wochenende|sonntag)\b/.test(t)) {
        const day = new Date(now).getUTCDay()
        return new Date(endOfDay(now + ((7 - day) % 7) * DAY_MS)).toISOString()
    }
    if (/\bbis (übermorgen|uebermorgen)\b/.test(t)) return new Date(endOfDay(now + 2 * DAY_MS)).toISOString()
    if (/\bbis morgen\b/.test(t)) return new Date(endOfDay(now + DAY_MS)).toISOString()
    if (/\b(nur |für |fuer )?heute\b/.test(t) && !/\bab heute\b/.test(t)) return new Date(endOfDay(now)).toISOString()
    return undefined
}

/** Is this owner text a lasting instruction? Pure: no I/O, no model. */
function isDirectiveSentence(sentence: string): boolean {
    const t = lower(sentence).trim()
    if (t.length < 6 || t.includes('?')) return false
    if (QUESTION_START.test(t) || NARRATIVE.test(t) || PAST.test(t)) return false
    return STRONG_MARKER.test(t) || WEAK_MARKER.test(t)
}

function fixedLimit(text: string): string | null {
    const t = lower(text)
    if (isNieAktionsart(t)) return 'Nie-Liste'
    if (LOESCHEN.test(t)) return 'Löschen'
    if (GELD.test(t)) return 'Geld'
    if (isPhysischOderExtern(t)) return 'physisch/extern'
    return null
}

/** Classifies one instruction sentence (with an optional reason). */
export function classifyDirective(sentence: string, now: number, reasonHint?: string): ParsedDirective {
    let body = clip(sentence, MAX_MESSAGE)
    let warum = reasonHint ? clip(reasonHint, MAX_WARUM) : undefined
    const reason = REASON.exec(body)
    if (reason && reason.index > 4) {
        warum = clip(reason[2], MAX_WARUM)
        body = body.slice(0, reason.index).trim()
    }
    body = body.replace(LEAD, '').trim()
    const t = lower(body)
    const polaritaet = polarityOf(t)
    let wirkung: DecisionEffect = 'neutral'
    let constraint: ParsedDirective['constraint']
    const strictAsk = ASK_ALWAYS.test(t) || (polaritaet === 'neg' && OHNE_ASK.test(t))
    const strictNever = !strictAsk && polaritaet === 'neg' && !NO_ASKING.test(t)
    if (strictAsk || strictNever) {
        wirkung = 'strenger'
        const arten = KIND_KEYWORDS.filter(([, pattern]) => pattern.test(t)).map(([kind]) => kind).filter(kind => AKTIONSARTEN[kind])
        if (arten.length) constraint = { mode: strictAsk ? 'fragen' : 'nie', arten: [...new Set(arten)] }
    } else if (PERMISSIVE.test(t)) wirkung = 'lockernd'
    let wirksam = true
    let nichtWirksamGrund: string | undefined
    if (wirkung === 'lockernd') {
        const limit = fixedLimit(t)
        if (limit) { wirksam = false; nichtWirksamGrund = `nicht wirksam: feste Grenze (${limit})` }
    }
    return {
        text: clip(body.replace(/[.!]+$/, ''), MAX_TEXT),
        warum,
        gueltigBis: parseValidity(t, now),
        polaritaet,
        themen: topicTokens(body),
        wirkung,
        wirksam,
        nichtWirksamGrund,
        constraint,
        ausdruecklich: EXPLICIT.test(t),
    }
}

/** Extracts up to three instruction sentences from one owner message. */
export function parseOwnerDirectives(text: unknown, now: number): ParsedDirective[] {
    const raw = String(text ?? '').trim()
    if (!raw || raw.length > MAX_MESSAGE || raw.startsWith('/')) return []
    const sentences = raw.split(/(?<=[.!?])\s+|\n+/).map(item => item.trim()).filter(Boolean)
    const out: ParsedDirective[] = []
    for (let index = 0; index < sentences.length && out.length < 3; index++) {
        if (!isDirectiveSentence(sentences[index])) continue
        const next = sentences[index + 1]
        const hint = next && /^(grund|weil|denn|begr(ü|ue)ndung)\b/i.test(next) ? next.replace(/^(grund:?|weil|denn|begr(ü|ue)ndung:?)\s*/i, '') : undefined
        const parsed = classifyDirective(sentences[index], now, hint)
        if (parsed.themen.length > 0) out.push(parsed)
    }
    return out
}

export function isRevocation(text: unknown): boolean {
    const t = lower(text)
    return !t.includes('?') && REVOKE.test(t)
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

let mainCheck: (() => boolean) | null = null

const fileOf = (opts: DecisionOptions) => join(opts.dataDir || getNovaDataDir(), 'decisions', 'decisions.json')
const nowOf = (opts: DecisionOptions) => (opts.now || Date.now)()
const isoOf = (opts: DecisionOptions) => new Date(nowOf(opts)).toISOString()
const mainOf = (opts: DecisionOptions) => {
    try { return (opts.isMain ? opts.isMain() : mainCheck ? mainCheck() : false) === true } catch { return false }
}

function readItems(opts: DecisionOptions): Decision[] {
    try {
        const raw = JSON.parse(readFileSync(fileOf(opts), 'utf8'))
        return raw?.version === 1 && Array.isArray(raw.items) ? raw.items : []
    } catch { return [] }
}

const INACTIVE: readonly DecisionStatus[] = ['ersetzt', 'widerrufen', 'abgelaufen', 'verworfen']

function writeItems(items: Decision[], opts: DecisionOptions): void {
    let list = items
    if (list.length > MAX_ITEMS) {
        // Drop the oldest inactive entries first, then the oldest non-binding ones.
        const drop = new Set<string>()
        for (const group of [list.filter(item => INACTIVE.includes(item.status)), list.filter(item => !item.bindend)]) {
            for (const item of group) { if (list.length - drop.size <= MAX_ITEMS) break; drop.add(item.id) }
        }
        list = list.filter(item => !drop.has(item.id))
    }
    atomicWriteJsonSync(fileOf(opts), { version: 1, items: list })
    constraintCache = null
}

/** Expired entries and stale questions fall out (status change, written on the Main only). */
function expire(items: Decision[], opts: DecisionOptions): boolean {
    const now = nowOf(opts)
    let changed = false
    for (const item of items) {
        if (item.status === 'aktiv' && item.gueltigBis && Date.parse(item.gueltigBis) < now) {
            item.status = 'abgelaufen'; item.statusAt = new Date(now).toISOString(); item.statusGrund = 'Gültigkeit abgelaufen'; changed = true
        }
        if (item.status === 'rueckfrage' && now - Date.parse(item.at) > CONFLICT_TTL_MS) {
            item.status = 'verworfen'; item.statusAt = new Date(now).toISOString(); item.statusGrund = 'Rückfrage nicht beantwortet — alte Entscheidung gilt'; changed = true
        }
    }
    return changed
}

/** All entries; expiry applied (persisted only on the Main). */
export function listDecisions(opts: DecisionOptions = {}): Decision[] {
    const items = readItems(opts)
    if (expire(items, opts) && mainOf(opts)) { try { writeItems(items, opts) } catch { /* next time */ } }
    return items
}

export function getDecision(id: string, opts: DecisionOptions = {}): Decision | null {
    return listDecisions(opts).find(item => item.id === id) ?? null
}

const newId = () => `d-${randomBytes(5).toString('hex')}`

function markDependents(items: Decision[], id: string): void {
    for (const item of items) {
        if (item.abhaengigVon.includes(id) && item.status === 'aktiv') item.statusGrund = `Grundlage ${id} gilt nicht mehr — prüfen`
    }
}

/** Same topic: at least two shared words covering half of the smaller topic, or the one word of a one-word topic. */
export function sameTopic(a: readonly string[], b: readonly string[]): boolean {
    const shared = overlap(a, b)
    const min = Math.min(a.length, b.length)
    if (min === 0) return false
    return (shared >= 2 && shared / min >= 0.5) || (min === 1 && shared === 1)
}

const isActiveBinding = (item: Decision) => item.status === 'aktiv' && item.bindend

/**
 * Generic insert. Binding entries only from owner sources; never on a worker.
 * Returns null when nothing was written.
 */
export function recordDecision(input: {
    text: string
    warum: string
    quelle: DecisionSource
    bindend: boolean
    gueltigBis?: string
    abhaengigVon?: string[]
    themen?: string[]
    polaritaet?: DecisionPolarity
    wirkung?: DecisionEffect
    wirksam?: boolean
    nichtWirksamGrund?: string
    constraint?: Decision['constraint']
    status?: DecisionStatus
    konfliktMit?: string
    ersetzt?: string
}, opts: DecisionOptions = {}): Decision | null {
    if (!mainOf(opts)) return null
    const ownerSource = input.quelle.art === 'owner-nachricht' || input.quelle.art === 'knopf' || input.quelle.art === 'befehl'
    const bindend = input.bindend === true && ownerSource
    const text = clip(input.text, MAX_TEXT)
    if (!text) return null
    const items = listDecisions(opts)
    const decision: Decision = {
        id: newId(),
        text,
        warum: clip(input.warum, MAX_WARUM) || 'ohne Begründung',
        quelle: { art: input.quelle.art, von: clip(input.quelle.von, 80), ...(input.quelle.kanal ? { kanal: clip(input.quelle.kanal, 30) } : {}), ...(input.quelle.ref ? { ref: clip(input.quelle.ref, 80) } : {}) },
        at: isoOf(opts),
        bindend,
        ...(input.gueltigBis ? { gueltigBis: input.gueltigBis } : {}),
        status: input.status ?? 'aktiv',
        abhaengigVon: (input.abhaengigVon || []).filter(id => /^d-[a-f0-9]{10}$/.test(id)).slice(0, 5),
        themen: (input.themen ?? topicTokens(text)).slice(0, 16),
        polaritaet: input.polaritaet ?? polarityOf(lower(text)),
        wirkung: bindend ? (input.wirkung ?? 'neutral') : 'neutral',
        wirksam: input.wirksam !== false,
        ...(input.nichtWirksamGrund ? { nichtWirksamGrund: clip(input.nichtWirksamGrund, 120) } : {}),
        ...(bindend && input.constraint && input.wirksam !== false ? { constraint: input.constraint } : {}),
        ...(input.konfliktMit ? { konfliktMit: input.konfliktMit } : {}),
        ...(input.ersetzt ? { ersetzt: input.ersetzt } : {}),
    }
    if (items.filter(item => !INACTIVE.includes(item.status) && item.bindend).length >= MAX_ITEMS) {
        console.warn('[Entscheidungen] Speicher voll — neue Entscheidung nicht gespeichert')
        return null
    }
    items.push(decision)
    writeItems(items, opts)
    return decision
}

function setStatus(items: Decision[], item: Decision, status: DecisionStatus, grund: string, opts: DecisionOptions): void {
    item.status = status
    item.statusAt = isoOf(opts)
    item.statusGrund = clip(grund, 160)
    if (INACTIVE.includes(status)) markDependents(items, item.id)
}

/** Owner revokes an entry (also used by /entscheidungen widerruf). */
export function revokeDecision(id: string, by: string, opts: DecisionOptions = {}): { ok: boolean; message: string } {
    if (!mainOf(opts)) return { ok: false, message: 'Nur der Main führt Entscheidungen.' }
    const items = listDecisions(opts)
    const item = items.find(entry => entry.id === id)
    if (!item) return { ok: false, message: `Unbekannte Entscheidung ${id}.` }
    if (item.status !== 'aktiv' && item.status !== 'rueckfrage') return { ok: false, message: `${id} ist bereits ${item.status}.` }
    setStatus(items, item, 'widerrufen', `widerrufen von ${by}`, opts)
    writeItems(items, opts)
    return { ok: true, message: `Widerrufen: ${item.text}` }
}

/** Settles an open question: 'neu' replaces the old entry, 'alt' discards the new one. */
export function resolveConflict(id: string, winner: 'neu' | 'alt', by: string, opts: DecisionOptions = {}): { ok: boolean; message: string; decision?: Decision } {
    if (!mainOf(opts)) return { ok: false, message: 'Nur der Main führt Entscheidungen.' }
    const items = listDecisions(opts)
    const item = items.find(entry => entry.id === id && entry.status === 'rueckfrage')
    if (!item) return { ok: false, message: `Keine offene Rückfrage ${id}.` }
    const old = items.find(entry => entry.id === item.konfliktMit)
    if (winner === 'neu') {
        setStatus(items, item, 'aktiv', `bestätigt von ${by}`, opts)
        item.ersetzt = old?.id
        if (old && old.status === 'aktiv') { setStatus(items, old, 'ersetzt', `ersetzt durch ${item.id} (${by})`, opts); old.ersetztDurch = item.id }
        writeItems(items, opts)
        return { ok: true, message: `Gilt jetzt: ${item.text}${old ? ` (ersetzt: ${old.text})` : ''}`, decision: item }
    }
    setStatus(items, item, 'verworfen', `${by}: alte Entscheidung gilt weiter`, opts)
    writeItems(items, opts)
    return { ok: true, message: `Bleibt bei: ${old?.text ?? 'der bisherigen Entscheidung'}`, decision: item }
}

/**
 * Looks at one incoming message and records what it decides. Only the owner
 * in a direct chat counts; groups, other users, system messages and commands
 * never create anything.
 */
export function observeOwnerMessage(message: OwnerMessage, opts: DecisionOptions = {}): ObserveResult {
    const result: ObserveResult = { created: [], confirmed: [], replaced: [], revoked: [], conflicts: [] }
    if (message.permission !== 'owner') return { ...result, skipped: 'kein Owner' }
    if (message.isGroup) return { ...result, skipped: 'Gruppe' }
    if (message.systemAuthored) return { ...result, skipped: 'systemerzeugt' }
    if (!mainOf(opts)) return { ...result, skipped: 'kein Main' }
    const text = String(message.text ?? '').trim()
    if (!text || text.startsWith('/')) return { ...result, skipped: 'leer oder Befehl' }
    const by = `owner:${message.principalId || '?'}`
    const now = nowOf(opts)

    // 1. Answer to an open question (asked once).
    const pending = listDecisions(opts).filter(item => item.status === 'rueckfrage').sort((a, b) => b.at.localeCompare(a.at))[0]
    const short = lower(text).trim()
    if (pending && short.length <= 60 && now - Date.parse(pending.at) <= ANSWER_WINDOW_MS) {
        const winner = ANSWER_NEU.test(short) ? 'neu' : ANSWER_ALT.test(short) ? 'alt' : null
        if (winner) {
            const settled = resolveConflict(pending.id, winner, by, opts)
            if (settled.ok && settled.decision) return { ...result, resolved: { decision: settled.decision, gewinner: winner } }
        }
    }

    // 2. Revocation ("vergiss die Entscheidung zu …", "… gilt nicht mehr").
    if (isRevocation(text) && !STRONG_MARKER.test(lower(text))) {
        const tokens = topicTokens(text)
        const items = listDecisions(opts)
        const scored = items.filter(isActiveBinding).filter(item => sameTopic(item.themen, tokens))
            .map(item => ({ item, score: topicSimilarity(item.themen, tokens) })).sort((a, b) => b.score - a.score)
        if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) {
            setStatus(items, scored[0].item, 'widerrufen', `widerrufen im Chat von ${by}`, opts)
            writeItems(items, opts)
            result.revoked.push(scored[0].item)
        }
        return result
    }

    // 3. New instructions.
    for (const directive of parseOwnerDirectives(text, now)) {
        const items = listDecisions(opts)
        const related = items.filter(isActiveBinding).filter(item => sameTopic(item.themen, directive.themen))
            .map(item => ({ item, score: topicSimilarity(item.themen, directive.themen) })).sort((a, b) => b.score - a.score)
        const same = related.find(entry => entry.item.polaritaet === directive.polaritaet && entry.score >= 0.8 && !directive.ausdruecklich)
        if (same) {
            same.item.bestaetigtAt = new Date(now).toISOString()
            writeItems(items, opts)
            result.confirmed.push(same.item)
            continue
        }
        const conflict = related.find(entry => entry.item.polaritaet !== directive.polaritaet || directive.ausdruecklich)
        const base = {
            text: directive.text,
            warum: directive.warum || `Anweisung von Alfred im Chat (${message.channel || 'Kanal ?'})`,
            quelle: { art: 'owner-nachricht' as const, von: by, kanal: message.channel },
            bindend: true,
            gueltigBis: directive.gueltigBis,
            themen: directive.themen,
            polaritaet: directive.polaritaet,
            wirkung: directive.wirkung,
            wirksam: directive.wirksam,
            nichtWirksamGrund: directive.nichtWirksamGrund,
            constraint: directive.constraint,
        }
        if (conflict && directive.ausdruecklich) {
            const created = recordDecision({ ...base, ersetzt: conflict.item.id }, opts)
            if (!created) continue
            const fresh = listDecisions(opts)
            const old = fresh.find(item => item.id === conflict.item.id)
            if (old) { setStatus(fresh, old, 'ersetzt', `ersetzt durch ${created.id} (ausdrücklich)`, opts); old.ersetztDurch = created.id; writeItems(fresh, opts) }
            result.created.push(created)
            if (old) result.replaced.push(old)
            continue
        }
        if (conflict) {
            const created = recordDecision({ ...base, status: 'rueckfrage', konfliktMit: conflict.item.id }, opts)
            if (created) result.conflicts.push({ neu: created, alt: conflict.item })
            continue
        }
        const created = recordDecision(base, opts)
        if (created) result.created.push(created)
    }
    return result
}

// ---------------------------------------------------------------------------
// using it: context, policy, briefing
// ---------------------------------------------------------------------------

const dateDe = (iso: string) => {
    const d = new Date(iso)
    return Number.isFinite(d.getTime()) ? `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}` : '?'
}
const whoOf = (item: Decision) => item.quelle.art === 'owner-nachricht' || item.quelle.art === 'befehl' ? 'Alfred'
    : item.quelle.art === 'knopf' ? 'Alfred per Knopf' : item.quelle.art === 'mission' ? 'Mission' : 'Delegation'

export function formatDecisionLine(item: Decision): string {
    const parts = [`[${item.id}] ${item.text}`, `${whoOf(item)} ${dateDe(item.at)}`, `Grund: ${item.warum}`]
    parts.push(item.gueltigBis ? `gilt bis ${dateDe(item.gueltigBis)}` : item.bindend ? 'gilt bis widerrufen' : 'Befund, nicht bindend')
    if (item.abhaengigVon.length) parts.push(`hängt ab von ${item.abhaengigVon.join(', ')}`)
    if (!item.wirksam) parts.push(item.nichtWirksamGrund || 'nicht wirksam: feste Grenze')
    if (item.statusGrund && item.status === 'aktiv' && /prüfen/.test(item.statusGrund)) parts.push(item.statusGrund)
    return parts.join(' · ')
}

/** Active entries that share topic words with the request (best first). */
export function relevantDecisions(query: unknown, opts: DecisionOptions = {}, limit = MAX_CONTEXT_ITEMS): Decision[] {
    const tokens = topicTokens(query)
    if (tokens.length === 0) return []
    return listDecisions(opts)
        .filter(item => item.status === 'aktiv')
        .map(item => ({ item, hits: overlap(item.themen, tokens) }))
        .filter(entry => entry.hits >= 1)
        .sort((a, b) => (b.hits - a.hits) || Number(b.item.bindend) - Number(a.item.bindend) || b.item.at.localeCompare(a.item.at))
        .slice(0, limit)
        .map(entry => entry.item)
}

/** Prompt block for the owner's request: matching decisions plus what this message just changed. */
export function buildDecisionContext(query: unknown, observed?: ObserveResult | null, opts: DecisionOptions = {}): string {
    const lines: string[] = []
    const relevant = relevantDecisions(query, opts)
    if (relevant.length) {
        lines.push('Passende Entscheidungen (halte dich daran; widerspricht die Anfrage einer davon, sag es):')
        for (const item of relevant) lines.push(`- ${formatDecisionLine(item)}`)
    }
    if (observed) {
        for (const item of observed.created) lines.push(`- NEU gemerkt: ${item.text}${item.wirksam ? '' : ` (${item.nichtWirksamGrund || 'nicht wirksam: feste Grenze'} — sag Alfred das kurz)`}`)
        for (const item of observed.replaced) lines.push(`- ERSETZT (gilt nicht mehr): ${item.text}`)
        for (const item of observed.revoked) lines.push(`- WIDERRUFEN: ${item.text}`)
        for (const conflict of observed.conflicts) {
            lines.push(`- WIDERSPRUCH: „${conflict.neu.text}“ widerspricht „${conflict.alt.text}“ (${whoOf(conflict.alt)} ${dateDe(conflict.alt.at)}, Grund: ${conflict.alt.warum}). Frag Alfred GENAU EINMAL, welche gilt (Antwort „ja, die neue“ oder „nein, die alte“). Bis dahin gilt die alte.`)
        }
        if (observed.resolved) lines.push(`- GEKLÄRT: ${observed.resolved.gewinner === 'neu' ? `gilt jetzt „${observed.resolved.decision.text}“` : 'die bisherige Entscheidung gilt weiter'}`)
    }
    if (lines.length === 0) return ''
    let block = `\n\n## ENTSCHEIDUNGEN (kausales Gedächtnis)\n${lines.join('\n')}`
    if (block.length > MAX_CONTEXT_CHARS) block = `${block.slice(0, MAX_CONTEXT_CHARS - 1)}…`
    return block
}

let constraintCache: { mtime: number; file: string; items: DecisionConstraint[] } | null = null

/** Tightening constraints for the action policy (binding, active, effective). */
export function activeConstraints(opts: DecisionOptions = {}): DecisionConstraint[] {
    const file = fileOf(opts)
    let mtime = -1
    try { mtime = statSync(file).mtimeMs } catch { return [] }
    if (constraintCache && constraintCache.file === file && constraintCache.mtime === mtime && !opts.now) return constraintCache.items
    const now = nowOf(opts)
    const items = readItems(opts)
        .filter(item => item.status === 'aktiv' && item.bindend && item.wirksam && item.constraint && (!item.gueltigBis || Date.parse(item.gueltigBis) >= now))
        .map(item => ({ id: item.id, mode: item.constraint!.mode, arten: item.constraint!.arten, text: item.text }))
    constraintCache = { mtime, file, items }
    return items
}

/** Entries created (or ended) in a window — for the evening report. */
export function decisionsForBriefing(since: number, now: number, opts: DecisionOptions = {}): string[] {
    const inWindow = (value?: string) => { const t = Date.parse(String(value)); return Number.isFinite(t) && t >= since && t <= now }
    const out: string[] = []
    for (const item of readItems(opts)) {
        if (inWindow(item.at) && item.bindend) {
            const state = item.status === 'rueckfrage' ? 'Rückfrage offen' : !item.wirksam ? (item.nichtWirksamGrund || 'nicht wirksam: feste Grenze') : item.gueltigBis ? `gilt bis ${dateDe(item.gueltigBis)}` : 'gilt bis widerrufen'
            out.push(`${item.text} (${whoOf(item)}, Grund: ${item.warum}; ${state})`)
        } else if (item.bindend && (item.status === 'widerrufen' || item.status === 'ersetzt' || item.status === 'abgelaufen') && inWindow(item.statusAt)) {
            out.push(`${item.status === 'widerrufen' ? 'Widerrufen' : item.status === 'ersetzt' ? 'Ersetzt' : 'Abgelaufen'}: ${item.text}`)
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// other sources: buttons, missions, delegations
// ---------------------------------------------------------------------------

/** Knopf answers with the card's evidence as the reason. The card module checked the owner. */
export function recordCardDecision(card: { id: string; art: string; titel: string; beleg: string; answer?: string; decidedBy?: string }, opts: DecisionOptions = {}): Decision | null {
    if (card.answer !== 'immer' && card.answer !== 'nein') return null
    const immer = card.answer === 'immer'
    const text = immer ? `Immer erlauben: ${card.titel}` : `Abgelehnt: ${card.titel}`
    const limit = immer ? fixedLimit(`${card.art} ${card.titel}`) : null
    return recordDecision({
        text,
        warum: `Knopf „${immer ? 'Immer erlauben' : 'Nein'}“ auf Karte ${card.id}; Beleg: ${card.beleg}`,
        quelle: { art: 'knopf', von: card.decidedBy || 'owner', ref: card.id },
        bindend: true,
        gueltigBis: immer ? undefined : new Date(nowOf(opts) + CARD_NEIN_TTL_MS).toISOString(),
        polaritaet: immer ? 'pos' : 'neg',
        wirkung: immer ? 'lockernd' : 'neutral',
        wirksam: !limit,
        nichtWirksamGrund: limit ? `nicht wirksam: feste Grenze (${limit})` : undefined,
        themen: topicTokens(`${card.art} ${card.titel}`),
    }, opts)
}

/** A finished mission becomes a finding linked to the owner decisions on the same topic. */
export function recordMissionDecision(mission: { id: string; titel: string; status: string; grund?: string; handoff?: string }, opts: DecisionOptions = {}): Decision | null {
    if (!['abgeschlossen', 'fehlgeschlagen', 'blockiert'].includes(mission.status)) return null
    const themen = topicTokens(mission.titel)
    const basis = listDecisions(opts).filter(isActiveBinding).filter(item => overlap(item.themen, themen) >= 1).map(item => item.id).slice(0, 3)
    return recordDecision({
        text: `Mission ${mission.titel}: ${mission.status}`,
        warum: mission.grund || mission.handoff || 'ohne Befund',
        quelle: { art: 'mission', von: 'xaventra', ref: mission.id },
        bindend: false,
        abhaengigVon: basis,
        themen,
    }, opts)
}

/** A delegation result — only Nova's own check is the evidence, never the (untrusted) answer text. */
export function recordDelegationDecision(record: { id: string; to: string; auftrag: string; status: string; missionId?: string; pruefung?: { ergebnis: string; detail: string } }, verified: boolean, opts: DecisionOptions = {}): Decision | null {
    if (record.status !== 'fertig' && record.status !== 'abgelehnt' && record.status !== 'abgelaufen') return null
    const items = listDecisions(opts)
    const missionEntry = record.missionId ? items.filter(item => item.quelle.art === 'mission' && item.quelle.ref === record.missionId).pop() : undefined
    return recordDecision({
        text: `Delegation an ${record.to}: ${record.auftrag.slice(0, 120)} → ${record.status}${record.status === 'fertig' ? (verified ? ' (geprüft)' : ' (ungeprüft)') : ''}`,
        warum: record.pruefung ? `eigene Prüfung: ${record.pruefung.ergebnis} — ${record.pruefung.detail}` : `Status ${record.status}`,
        quelle: { art: 'delegation', von: 'xaventra', ref: record.id },
        bindend: false,
        abhaengigVon: missionEntry ? [missionEntry.id] : [],
    }, opts)
}

// ---------------------------------------------------------------------------
// /entscheidungen
// ---------------------------------------------------------------------------

export function formatDecisions(opts: DecisionOptions = {}, limit = 15): string {
    const items = listDecisions(opts)
    const active = items.filter(item => item.status === 'aktiv' && item.bindend)
    const pending = items.filter(item => item.status === 'rueckfrage')
    const findings = items.filter(item => item.status === 'aktiv' && !item.bindend)
    const ended = items.filter(item => INACTIVE.includes(item.status)).slice(-5)
    const lines = [`Entscheidungen (${active.length} gültig, ${pending.length} Rückfrage, ${findings.length} Befunde)`]
    for (const item of active.slice(-limit)) lines.push(`- ${formatDecisionLine(item)}`)
    if (pending.length) {
        lines.push('', 'Rückfrage offen:')
        for (const item of pending) lines.push(`- [${item.id}] ${item.text} — widerspricht ${item.konfliktMit} · /entscheidungen gilt ${item.id} | /entscheidungen verwerfen ${item.id}`)
    }
    if (findings.length) {
        lines.push('', 'Befunde (Missionen/Delegationen, nicht bindend):')
        for (const item of findings.slice(-5)) lines.push(`- ${formatDecisionLine(item)}`)
    }
    if (ended.length) {
        lines.push('', 'Zuletzt beendet:')
        for (const item of ended) lines.push(`- [${item.id}] ${item.text} — ${item.status}${item.statusGrund ? ` (${item.statusGrund})` : ''}`)
    }
    if (items.length === 0) lines.push('Noch nichts gemerkt.')
    return lines.join('\n')
}

/** /entscheidungen [widerruf <id> | gilt <id> | verwerfen <id>] — owner only. */
export function handleEntscheidungenCommand(args: string, principal: { permission?: string; principalId?: string; rawUserId?: string } | undefined, opts: DecisionOptions = {}): string {
    if (principal?.permission !== 'owner') return '⛔ /entscheidungen ist nur für den Owner.'
    const [sub = '', id = ''] = String(args || '').trim().split(/\s+/)
    if (!sub) return formatDecisions(opts)
    if (!/^d-[a-f0-9]{10}$/.test(id)) return 'Nutzung: /entscheidungen | /entscheidungen widerruf <id> | /entscheidungen gilt <id> | /entscheidungen verwerfen <id>'
    const by = `owner:${principal.principalId || principal.rawUserId || '?'}`
    if (sub === 'widerruf' || sub === 'widerrufen') return revokeDecision(id, by, opts).message
    if (sub === 'gilt') return resolveConflict(id, 'neu', by, opts).message
    if (sub === 'verwerfen') return resolveConflict(id, 'alt', by, opts).message
    return 'Nutzung: /entscheidungen | /entscheidungen widerruf <id> | /entscheidungen gilt <id> | /entscheidungen verwerfen <id>'
}

// ---------------------------------------------------------------------------
// production wiring
// ---------------------------------------------------------------------------

/** Called once by the daemon. Workers record nothing; the policy reads constraints everywhere. */
export async function startDecisionMemory(options: { nodeOnly: boolean }): Promise<{ started: boolean; reason: string }> {
    setDecisionConstraintProvider(() => activeConstraints())
    if (options.nodeOnly) {
        mainCheck = () => false
        return { started: false, reason: 'Mesh-Worker: Entscheidungen führt nur der Main' }
    }
    const { hasGlobalAutonomyAuthority } = await import('./autonomy-authority.js')
    mainCheck = () => String(process.env.NOVA_NODE_ONLY || '').toLowerCase() !== 'true' && hasGlobalAutonomyAuthority()
    try {
        const { onDelegationSettled } = await import('./delegation.js')
        onDelegationSettled((record, info) => { try { recordDelegationDecision(record, info.verified) } catch { /* never break delegation */ } })
    } catch { /* delegation optional */ }
    return { started: true, reason: 'Owner-Anweisungen, Knöpfe, Missionen und Delegationen werden gemerkt' }
}

/** Test hook. */
export function _setDecisionMainCheckForTest(check: (() => boolean) | null): void { mainCheck = check; constraintCache = null }
