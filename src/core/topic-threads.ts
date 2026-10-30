/**
 * 2.91.0 Themen-Fäden („ich schreib ihr x und sie teilt es x zu“) — fully automatic.
 *
 * Alfred sees ONE chat and never has to type a command. Internally every
 * message of the owner is assigned to a topic thread. Verlauf and
 * Zusammenfassung already hang on (userId, conversationId, botId)
 * (agents/session-checkpoints.ts), so from 2.91.1 a thread is only a
 * conversationId per topic. 2.91.0 runs in shadow: assignment, naming,
 * merging, resting and correction happen in the thread store and are measured;
 * the history stays `default`.
 *
 * Deterministic first, first match wins:
 *   raum        a chosen Desktop room
 *   antwort     a reply to an earlier message inherits its thread
 *   rueckfrage  one-time code / /freigabe → the thread waiting for approval;
 *               a short answer → the thread that asked a question
 *   korrektur   „nein, ich meine das Auto“ → moves the previous message too and learns its keywords
 *   smalltalk   „danke“, „test“, „wie spät ist es?“ … never creates a thread
 *   inhalt      shared keywords with a thread (a sentence joining two threads merges them);
 *               real content without a fixed topic opens its own thread, named from the content
 *   marke       fixed topic from the tool route (tool-router.ts) and owner-profile entities
 *   folge       short follow-up with a cue („und jetzt …“) → last active thread (≤ 15 min)
 *   unklar      two fixed topics → the last active of them, else the first by priority
 *   allgemein   nothing matched
 * Threads rest after 7 days without activity and wake when their topic comes back.
 * Stored per thread: name, times, counts and at most 12 keywords — never a sentence.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getNovaDataDir } from './data-root.js'
import { detectClockQuestion } from './clock-answer.js'
import { relayQuestionText } from './relay-text.js'

const threadContext = new AsyncLocalStorage<string>()
/** Run the agent turn inside its thread: background work it starts (subagents, missions) records the threadId. */
export function runInThread<T>(threadId: string | undefined, fn: () => T): T {
    return threadId ? threadContext.run(threadId, fn) : fn()
}
export function currentThreadId(): string | undefined {
    return threadContext.getStore()
}

export type ThreadRule = 'raum' | 'antwort' | 'rueckfrage' | 'korrektur' | 'smalltalk' | 'inhalt' | 'marke' | 'folge' | 'unklar' | 'allgemein' | 'aus'

export interface TopicThread {
    id: string
    /** Fixed topic key (haus, auto, …), 'frei' for a thread named from its content, 'allgemein'. */
    key: string
    name: string
    createdAt: number
    lastAt: number
    turns: number
    status: 'aktiv' | 'ruhend'
    /** At most 12 keywords (nouns of the messages), never a sentence. */
    terms: string[]
}

export interface ThreadInput {
    principalId: string
    content: string
    /** Routes the request activates (tool-router.ts `requestRouteNames`), e.g. `pack:smart-home`, `live:mesh`. */
    routes: readonly string[]
    profileEntities?: ReadonlyArray<{ name: string; kind: string; aliases?: string[] }>
    roomId?: string
    /** Channel message key this message replies to (e.g. `tg:<chat>:<message_id>`). */
    replyTo?: string
    isGroup?: boolean
    now?: number
}

export interface ThreadAssignment {
    threadId: string
    key: string
    name: string
    rule: ThreadRule
    isNew: boolean
    /** Share of the recent turns (≤ 12, 24 h) that belong to other threads: what a shared history drags in. */
    foreignHistoryShare: number
    /** Threads merged into this one by this message. */
    merged: number
    /** The thread was resting and this message woke it. */
    woke: boolean
    /** This message corrected the previous assignment („nein, ich meine …“). */
    corrected: boolean
    activeThreads: number
    restingThreads: number
}

/** Topic key → display name; order = priority when a sentence hits several. */
const TOPICS: ReadonlyArray<[string, string]> = [
    ['auto', 'Auto'], ['hunde', 'Hunde'], ['tiere', 'Tiere'], ['haus', 'Haus'], ['computer', 'Computer'],
    ['infra', 'Infra'], ['pakete', 'Pakete'], ['arbeit', 'Arbeit/Projekte'], ['xaventra', 'Xaventra'], ['recherche', 'Recherche'],
]
const NAME = new Map<string, string>([...TOPICS, ['allgemein', 'Allgemein']])
const PRIORITY = TOPICS.map(([key]) => key)

const ROUTE_TOPIC: Readonly<Record<string, string>> = {
    'pack:smart-home': 'haus', 'pack:printer': 'haus',
    'pack:mesh-network': 'infra', 'pack:system-shell': 'infra', 'pack:docker': 'infra', 'pack:monitoring': 'infra',
    'pack:process-management': 'infra', 'pack:system-config': 'infra',
    'live:mesh': 'infra', 'live:environment': 'infra', 'live:proxmox': 'infra', 'live:kubernetes': 'infra',
    'live:kubernetes-test-pods': 'infra', 'live:mesh-handoff': 'infra', 'live:tailnet': 'infra',
    'pack:computer-use': 'computer', 'pack:desktop-capture': 'computer', 'live:workstation-action': 'computer', 'live:screenshot': 'computer',
    'pack:files': 'arbeit', 'pack:documents': 'arbeit', 'pack:code-analysis': 'arbeit', 'pack:developer-harness': 'arbeit',
    'pack:git-updates': 'arbeit', 'pack:projects': 'arbeit',
    'pack:self-evolution': 'xaventra', 'pack:self-setup': 'xaventra', 'pack:patch-management': 'xaventra',
    'pack:llm-management': 'xaventra', 'pack:self-doctor': 'xaventra',
    'pack:web-search': 'recherche', 'live:open-site': 'recherche', 'pack:search-extended': 'recherche',
    'live:parcel': 'pakete',
}
const KIND_TOPIC: Readonly<Record<string, string>> = { vehicle: 'auto', dog: 'hunde', cat: 'tiere' }

/** Topic words that no tool route carries (the vehicle and the dogs are profile topics, not tools). */
const WORD_TOPIC: ReadonlyArray<[RegExp, string]> = [
    [/(?<![\p{L}])(?:auto|autos|fahrzeug\p{L}*|akku|ladestand|lädt|laden|ladung|wallbox|reichweite|tanken)(?![\p{L}])/iu, 'auto'],
    [/(?<![\p{L}])(?:hund\p{L}*|gassi|tierarzt\p{L}*|welpe\p{L}*|leine)(?![\p{L}])/iu, 'hunde'],
    // A web address in the sentence is something to look up, even without a read verb.
    [/(?<![\p{L}\p{N}@.-])(?:https?:\/\/)?(?:[a-z0-9][a-z0-9-]*\.)+(?:de|at|ch|com|org|net|io|eu|info|dev|app|news)(?![\p{L}\p{N}-])/iu, 'recherche'],
]

/** A stronger topic absorbs a weaker one the same sentence also touches. */
const ABSORBS: ReadonlyArray<[string, string[]]> = [
    ['auto', ['haus']], ['hunde', ['haus']], ['tiere', ['haus']],
    ['computer', ['arbeit', 'recherche']], ['pakete', ['recherche']],
]

const SMALLTALK = /^(?:hallo|hi|hey|servus|guten (?:morgen|abend|tag)|danke(?: dir| schön| schoen)?|merci|ok(?:ay)?|passt|super|perfekt|top|cool|test|gut)[!.? ]*$/i
const FOLLOW_CUE = /^(?:und|aber|dann|nochmal|noch mal|noch|jetzt|auch|wieder|genau|stopp|stop|weiter|mach (?:das|es|weiter)|bitte nochmal)(?![\p{L}])/iu
const APPROVAL = /^\s*(?:\/freigabe\b.*|(?:freigabe-?code\s*)?\d{4,8})\s*$/i
/** „nein, ich meine das Auto“, „falsch, es geht um Bricks“ — the rest names what was meant. */
const CORRECTION = /^(?:nein|nee|ne|falsch|nicht (?:das|den|die))[\s,!.:-]+(?:(?:ich )?mein(?:e|te)|gemeint (?:ist|war)|es geht um|ich rede von|ich spreche von)\s+(.+)$/iu
const ANSWER_WORDS = 8
const FOLLOW_WORDS = 8
const FOLLOW_MS = 15 * 60_000
const QUESTION_MS = 10 * 60_000
const APPROVAL_MS = 30 * 60_000
const REST_MS = 7 * 24 * 60 * 60_000
const RECENT = 12
const DAY_MS = 24 * 60 * 60_000
const MAX_TERMS = 12
const STYLE_NOTE_TERMS = new Set(['antworte', 'markdown', 'deutsch', 'knapp', 'kurz'])

const fold = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

/** Capitalised words that carry no topic (pronouns, sentence words, time words). */
const GENERIC = new Set([
    'ich', 'du', 'sie', 'er', 'es', 'wir', 'ihr', 'mir', 'dir', 'uns', 'euch', 'man', 'bitte', 'danke', 'hallo',
    'stand', 'frage', 'sache', 'problem', 'zeit', 'ding', 'info', 'infos', 'thema', 'hilfe', 'idee', 'mal', 'ende', 'anfang',
    'heute', 'morgen', 'gestern', 'tag', 'tage', 'woche', 'monat', 'jahr', 'uhr', 'minute', 'minuten', 'stunde', 'stunden',
    'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag',
    'januar', 'februar', 'marz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember',
    'herr', 'frau', 'leute', 'alles', 'nichts', 'etwas', 'was', 'wer', 'wie', 'wo', 'wann', 'warum',
])

/**
 * Keywords of a message: capitalised words inside a sentence (German nouns and names),
 * minus generic words; the first word of a sentence is capitalised anyway. Only these ever reach the store.
 */
export function contentTerms(content: string): string[] {
    // Explicit type: tsc can mis-infer regex match results to `never` depending on the import graph (see llm-factory.ts).
    const text = String(content || '')
    const tokens = Array.from(text.matchAll(/[\p{L}][\p{L}\p{N}-]*/gu))
    const out: string[] = []
    tokens.forEach((match, index) => {
        const token = match[0]
        const sentenceStart = /[.:!?\n]\s*$/.test(text.slice(0, match.index))
        if (index === 0 || sentenceStart || token.length < 3 || !/^\p{Lu}/u.test(token)) return
        const term = fold(token).replace(/-+$/, '')
        if (!GENERIC.has(term) && !out.includes(term)) out.push(term)
    })
    return out.slice(0, MAX_TERMS)
}

/** Topic keys a message carries: profile entities, topic words, then tool routes; in priority order. */
export function topicKeys(input: Pick<ThreadInput, 'content' | 'routes' | 'profileEntities'>): string[] {
    const found = new Set<string>()
    const text = fold(String(input.content || ''))
    for (const entity of input.profileEntities ?? []) {
        const topic = KIND_TOPIC[entity.kind]
        if (!topic) continue
        const names = [entity.name, ...(entity.aliases ?? [])].map(fold).filter(name => name.length >= 2)
        if (names.some(name => new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, 'u').test(text))) found.add(topic)
    }
    for (const [pattern, topic] of WORD_TOPIC) if (pattern.test(text)) found.add(topic)
    for (const route of input.routes) { const topic = ROUTE_TOPIC[route]; if (topic) found.add(topic) }
    for (const [strong, weak] of ABSORBS) if (found.has(strong)) for (const key of weak) found.delete(key)
    // Looking something up is the weakest topic: any concrete topic of the same sentence wins.
    if (found.size > 1) found.delete('recherche')
    return PRIORITY.filter(key => found.has(key))
}

interface PrincipalState {
    threads: TopicThread[]
    recent: Array<{ at: number; threadId: string; rule: ThreadRule }>
    outgoing: Array<{ key: string; threadId: string; at: number }>
    pendingQuestion?: { threadId: string; at: number }
    pendingApproval?: { threadId: string; at: number }
    /** Merged thread → the thread it went into (old references keep working). */
    aliases: Record<string, string>
    /** Keywords of the last message (learned by its thread when the owner corrects it). */
    lastTerms: string[]
    seq: number
    corrections: number
    merges: number
}

export class TopicThreadStore {
    private data: Record<string, PrincipalState> = {}
    private dirty = false

    constructor(private readonly path: string) {
        try { if (existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf8'))?.principals ?? {} } catch { this.data = {} }
        this.repairStyleNoteThreads()
    }

    /** Until 2.92.3 the relay's style note was read as content (live: a thread named „Antworte Deutsch“). Only the wrong words go. */
    private repairStyleNoteThreads(): void {
        for (const state of Object.values(this.data)) {
            for (const thread of state?.threads ?? []) {
                if (!thread.terms?.some(term => term === 'antworte' || term === 'markdown')) continue
                thread.terms = thread.terms.filter(term => !STYLE_NOTE_TERMS.has(term))
                if (thread.key === 'frei') thread.name = nameFrom(thread.terms) || 'Ohne Thema'
                this.dirty = true
            }
        }
    }

    state(principalId: string): PrincipalState {
        const state = this.data[principalId] ??= { threads: [], recent: [], outgoing: [], aliases: {}, lastTerms: [], seq: 0, corrections: 0, merges: 0 }
        state.aliases ??= {}; state.lastTerms ??= []; state.seq ??= 0; state.corrections ??= 0; state.merges ??= 0
        for (const thread of state.threads) { thread.status ??= 'aktiv'; thread.terms ??= [] }
        return state
    }

    threads(principalId: string): TopicThread[] {
        return [...(this.data[principalId] ? this.state(principalId).threads : [])].sort((a, b) => b.lastAt - a.lastAt)
    }

    /** After the run: Xaventra asked back, or an approval (one-time code) is open in this thread. */
    noteOutcome(principalId: string, threadId: string, outcome: { askedQuestion?: boolean; awaitingApproval?: boolean; now?: number }): void {
        if (!threadId || threadId.startsWith('room:')) return
        const at = outcome.now ?? Date.now()
        const state = this.state(principalId)
        if (outcome.awaitingApproval) state.pendingApproval = { threadId, at }
        if (outcome.askedQuestion) state.pendingQuestion = { threadId, at }
        this.dirty = true
    }

    /** An outgoing channel message of this thread (a later reply to it inherits the thread). */
    noteOutgoing(principalId: string, messageKey: string, threadId: string, now = Date.now()): void {
        const state = this.state(principalId)
        state.outgoing = [...state.outgoing.filter(item => item.key !== messageKey), { key: messageKey, threadId, at: now }].slice(-200)
        this.dirty = true
    }

    markDirty(): void { this.dirty = true }

    save(): void {
        if (!this.dirty) return
        mkdirSync(dirname(this.path), { recursive: true })
        const temp = `${this.path}.tmp`
        writeFileSync(temp, JSON.stringify({ version: 2, principals: this.data }), { mode: 0o600 })
        renameSync(temp, this.path)
        this.dirty = false
    }
}

let shared: TopicThreadStore | null = null
/** The one live store (.nova-data/topic-threads.json): pipeline and /themen read the same threads. */
export function sharedTopicThreadStore(): TopicThreadStore {
    return shared ??= new TopicThreadStore(getNovaDataDir('topic-threads.json'))
}

const share = (recent: PrincipalState['recent'], threadId: string, now: number) => {
    const window = recent.filter(item => now - item.at <= DAY_MS).slice(-RECENT)
    return window.length ? window.filter(item => item.threadId !== threadId).length / window.length : 0
}

const learn = (thread: TopicThread, terms: readonly string[]) => {
    thread.terms = [...new Set([...thread.terms, ...terms])].slice(-MAX_TERMS)
}

/** Short name from the content: the first two keywords, capitalised. */
const nameFrom = (terms: readonly string[]) => terms.slice(0, 2).map(term => term.charAt(0).toUpperCase() + term.slice(1)).join(' ')

/** A message with real content (≥ 2 keywords, or 1 keyword in a sentence of ≥ 6 words) may open its own thread. */
const opensThread = (content: string, terms: readonly string[]) => terms.length >= 2 || (terms.length === 1 && words(content) >= 6)

export function assignThread(input: ThreadInput, store: TopicThreadStore): ThreadAssignment {
    const now = input.now ?? Date.now()
    const content = relayQuestionText(String(input.content || '')).trim()
    const none = { merged: 0, woke: false, corrected: false, activeThreads: 0, restingThreads: 0, foreignHistoryShare: 0, isNew: false }
    if (input.roomId) return { ...none, threadId: `room:${input.roomId}`, key: 'raum', name: `Raum ${input.roomId}`, rule: 'raum' }
    if (input.isGroup || !input.principalId) return { ...none, threadId: 'default', key: 'allgemein', name: 'Allgemein', rule: 'aus' }

    const state = store.state(input.principalId)
    for (const thread of state.threads) if (thread.status === 'aktiv' && now - thread.lastAt > REST_MS) thread.status = 'ruhend'
    const resolve = (id?: string) => {
        let current = id
        for (let hop = 0; current && state.aliases[current] && hop < 10; hop++) current = state.aliases[current]
        return current ? state.threads.find(thread => thread.id === current) : undefined
    }
    const last = [...state.threads].sort((a, b) => b.lastAt - a.lastAt)[0]
    const lastFresh = last && now - last.lastAt <= FOLLOW_MS ? last : undefined
    const keys = topicKeys({ ...input, content })
    const terms = contentTerms(content)
    const overlap = (thread: TopicThread) => terms.filter(term => thread.terms.includes(term)).length
    const fixed = (key: string) => state.threads.find(thread => thread.key === key)
    const create = (key: string, name: string): TopicThread => {
        const id = key === 'frei' ? `thread:frei-${++state.seq}` : `thread:${key}`
        const thread: TopicThread = { id, key, name, createdAt: now, lastAt: now, turns: 0, status: 'aktiv', terms: [] }
        state.threads.push(thread)
        return thread
    }

    let chosen: TopicThread | undefined, key = '', rule: ThreadRule = 'allgemein', merged = 0, corrected = false
    const reply = input.replyTo ? state.outgoing.find(item => item.key === input.replyTo) : undefined
    const correction = CORRECTION.exec(content)
    const correctionTarget = (() => {
        if (!correction) return undefined
        const rest = correction[1]
        const restKeys = topicKeys({ content: rest, routes: [], profileEntities: input.profileEntities })
        if (restKeys.length) return { key: restKeys[0], thread: fixed(restKeys[0]) }
        // `x` stands in for the first word, which contentTerms never counts as a keyword.
        const restTerms = contentTerms(`x ${rest}`)
        const byTerms = state.threads.map(thread => ({ thread, hits: restTerms.filter(term => thread.terms.includes(term)).length })).filter(item => item.hits > 0)
            .sort((a, b) => b.hits - a.hits)[0]
        return byTerms ? { key: byTerms.thread.key, thread: byTerms.thread } : undefined
    })()
    const previous = state.recent.at(-1)

    if (reply && resolve(reply.threadId)) { chosen = resolve(reply.threadId); rule = 'antwort' }
    else if (APPROVAL.test(content) && state.pendingApproval && now - state.pendingApproval.at <= APPROVAL_MS && resolve(state.pendingApproval.threadId)) {
        chosen = resolve(state.pendingApproval.threadId); rule = 'rueckfrage'
        if (/^\s*\d/.test(content)) state.pendingApproval = undefined
    } else if (correctionTarget && previous && (correctionTarget.thread?.id ?? `thread:${correctionTarget.key}`) !== resolve(previous.threadId)?.id) {
        // „nein, ich meine das Auto“: this message and the previous one belong to the meant thread.
        chosen = correctionTarget.thread ?? create(correctionTarget.key, NAME.get(correctionTarget.key) ?? correctionTarget.key)
        rule = 'korrektur'; corrected = true; state.corrections++
        const wrong = resolve(previous.threadId)
        if (wrong) wrong.turns = Math.max(0, wrong.turns - 1)
        chosen.turns++
        learn(chosen, state.lastTerms)
        previous.threadId = chosen.id; previous.rule = 'korrektur'
    } else if (SMALLTALK.test(content) || detectClockQuestion(content)) { chosen = lastFresh; key = chosen ? chosen.key : 'allgemein'; rule = 'smalltalk' }
    else if (state.pendingQuestion && now - state.pendingQuestion.at <= QUESTION_MS && words(content) <= ANSWER_WORDS
        && resolve(state.pendingQuestion.threadId) && (keys.length === 0 || keys.includes(resolve(state.pendingQuestion.threadId)!.key))) {
        chosen = resolve(state.pendingQuestion.threadId); rule = 'rueckfrage'; state.pendingQuestion = undefined
    } else {
        const hits = state.threads.map(thread => ({ thread, hits: overlap(thread) })).filter(item => item.hits > 0).sort((a, b) => b.hits - a.hits || a.thread.createdAt - b.thread.createdAt)
        const best = hits[0]
        const freeHits = hits.filter(item => item.thread.key === 'frei')
        if (keys.length === 0 && freeHits.length > 1) {
            // A sentence joining two own threads: they are one topic — merge into the oldest.
            const [target, ...rest] = [...freeHits].sort((a, b) => a.thread.createdAt - b.thread.createdAt).map(item => item.thread)
            for (const other of rest) {
                learn(target, other.terms); target.turns += other.turns
                state.aliases[other.id] = target.id
                state.threads = state.threads.filter(thread => thread.id !== other.id)
                merged++; state.merges++
            }
            chosen = target; rule = 'inhalt'
        } else if (best && best.thread.key === 'frei' && (keys.length === 0 || best.hits >= 2)) { chosen = best.thread; rule = 'inhalt' }
        else if (keys.length === 1) { key = keys[0]; rule = 'marke' }
        else if (keys.length > 1) { key = lastFresh && keys.includes(lastFresh.key) ? lastFresh.key : keys[0]; rule = 'unklar' }
        else if (best) { chosen = best.thread; rule = 'inhalt' }
        else if (lastFresh && words(content) <= FOLLOW_WORDS && FOLLOW_CUE.test(content)) { chosen = lastFresh; rule = 'folge' }
        else if (opensThread(content, terms)) { chosen = create('frei', nameFrom(terms)); rule = 'inhalt' }
        else { key = 'allgemein'; rule = 'allgemein' }
    }

    let isNew = Boolean(chosen && chosen.turns === 0 && chosen.createdAt === now && rule !== 'korrektur')
    if (!chosen && rule === 'smalltalk' && key === 'allgemein') chosen = fixed('allgemein')
    if (!chosen && rule !== 'smalltalk') {
        chosen = fixed(key)
        if (!chosen) { chosen = create(key, NAME.get(key) ?? key); isNew = true }
    }
    const counts = () => ({
        activeThreads: state.threads.filter(thread => thread.status === 'aktiv').length,
        restingThreads: state.threads.filter(thread => thread.status === 'ruhend').length,
    })
    state.lastTerms = terms
    if (!chosen) {
        // Small talk with no active thread: Allgemein, but never created for it.
        const foreignHistoryShare = share(state.recent, 'thread:allgemein', now)
        state.recent = [...state.recent, { at: now, threadId: 'thread:allgemein', rule }].slice(-50)
        store.markDirty()
        return { threadId: 'thread:allgemein', key: 'allgemein', name: 'Allgemein', rule, isNew: false, foreignHistoryShare, merged, woke: false, corrected, ...counts() }
    }
    const woke = chosen.status === 'ruhend'
    chosen.status = 'aktiv'
    const foreignHistoryShare = share(state.recent, chosen.id, now)
    chosen.lastAt = now
    chosen.turns++
    if (rule !== 'smalltalk' && rule !== 'rueckfrage') learn(chosen, terms)
    state.recent = [...state.recent, { at: now, threadId: chosen.id, rule }].slice(-50)
    store.markDirty()
    return { threadId: chosen.id, key: chosen.key, name: chosen.name, rule, isNew, foreignHistoryShare, merged, woke, corrected, ...counts() }
}

function ago(ms: number): string {
    const minutes = Math.round(ms / 60_000)
    if (minutes < 1) return 'gerade eben'
    if (minutes < 60) return `vor ${minutes} min`
    const hours = Math.round(minutes / 60)
    return hours < 24 ? `vor ${hours} h` : `vor ${Math.round(hours / 24)} Tagen`
}

/** /themen: optional view, never a required step. */
export function formatThemen(threads: readonly TopicThread[], now = Date.now(), mode = 'shadow'): string {
    if (!threads.length) return '🧵 Noch keine Themen erkannt.'
    const lines = threads.slice(0, 20).map(thread =>
        `• ${thread.name}${thread.status === 'ruhend' ? ' (ruht)' : ''} — ${thread.turns} Nachricht${thread.turns === 1 ? '' : 'en'}, zuletzt ${ago(now - thread.lastAt)}`)
    const note = mode === 'on' ? '' : '\n\n(Probebetrieb: Themen werden automatisch erkannt, benannt und zusammengeführt und gemessen; der Verlauf ist noch gemeinsam.)'
    return `🧵 *Themen*\n${lines.join('\n')}${note}`
}
