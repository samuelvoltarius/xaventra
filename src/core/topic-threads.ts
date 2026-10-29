/**
 * 2.91.0 Themen-Fäden („ich schreib ihr x und sie teilt es x zu“).
 *
 * Alfred sees ONE chat. Internally every message of the owner is assigned to
 * a topic thread (Haus, Auto, Hunde, Infra, …). Verlauf and Zusammenfassung
 * already hang on (userId, conversationId, botId) (agents/session-checkpoints.ts),
 * so from 2.91.1 a thread is only a conversationId per topic. 2.91.0 runs in
 * shadow: the assignment is made and measured, the history stays `default`.
 *
 * Deterministic first, first match wins:
 *   raum        a chosen Desktop room
 *   antwort     a reply to an earlier message inherits its thread
 *   rueckfrage  one-time code / /freigabe → the thread waiting for approval;
 *               a short answer → the thread that asked a question
 *   smalltalk   „danke“, „test“ … never creates a thread
 *   marke       topic from the tool route (tool-router.ts) and owner-profile entities
 *   folge       short follow-up with a cue („und jetzt …“) → last active thread (≤ 15 min)
 *   unklar      two topics → the last active of them, else the first by priority
 *   allgemein   nothing matched
 * No message text is stored: thread names, times, counts and rules only.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getNovaDataDir } from './data-root.js'

const threadContext = new AsyncLocalStorage<string>()
/** Run the agent turn inside its thread: background work it starts (subagents, missions) records the threadId. */
export function runInThread<T>(threadId: string | undefined, fn: () => T): T {
    return threadId ? threadContext.run(threadId, fn) : fn()
}
export function currentThreadId(): string | undefined {
    return threadContext.getStore()
}

export type ThreadRule = 'raum' | 'antwort' | 'rueckfrage' | 'smalltalk' | 'marke' | 'folge' | 'unklar' | 'allgemein' | 'aus'

export interface TopicThread { id: string; key: string; name: string; createdAt: number; lastAt: number; turns: number }

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
const ANSWER_WORDS = 8
const FOLLOW_WORDS = 8
const FOLLOW_MS = 15 * 60_000
const QUESTION_MS = 10 * 60_000
const APPROVAL_MS = 30 * 60_000
const RECENT = 12
const DAY_MS = 24 * 60 * 60_000

const fold = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

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
}

export class TopicThreadStore {
    private data: Record<string, PrincipalState> = {}
    private dirty = false

    constructor(private readonly path: string) {
        try { if (existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf8'))?.principals ?? {} } catch { this.data = {} }
    }

    state(principalId: string): PrincipalState {
        return this.data[principalId] ??= { threads: [], recent: [], outgoing: [] }
    }

    threads(principalId: string): TopicThread[] {
        return [...(this.data[principalId]?.threads ?? [])].sort((a, b) => b.lastAt - a.lastAt)
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
        writeFileSync(temp, JSON.stringify({ version: 1, principals: this.data }), { mode: 0o600 })
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

export function assignThread(input: ThreadInput, store: TopicThreadStore): ThreadAssignment {
    const now = input.now ?? Date.now()
    const content = String(input.content || '').trim()
    if (input.roomId) return { threadId: `room:${input.roomId}`, key: 'raum', name: `Raum ${input.roomId}`, rule: 'raum', isNew: false, foreignHistoryShare: 0 }
    if (input.isGroup || !input.principalId) return { threadId: 'default', key: 'allgemein', name: 'Allgemein', rule: 'aus', isNew: false, foreignHistoryShare: 0 }

    const state = store.state(input.principalId)
    const byId = (id?: string) => (id ? state.threads.find(thread => thread.id === id) : undefined)
    const last = [...state.threads].sort((a, b) => b.lastAt - a.lastAt)[0]
    const lastFresh = last && now - last.lastAt <= FOLLOW_MS ? last : undefined
    const keys = topicKeys(input)

    let chosen: TopicThread | undefined, key = '', rule: ThreadRule = 'allgemein'
    const reply = input.replyTo ? state.outgoing.find(item => item.key === input.replyTo) : undefined
    if (reply && byId(reply.threadId)) { chosen = byId(reply.threadId); rule = 'antwort' }
    else if (APPROVAL.test(content) && state.pendingApproval && now - state.pendingApproval.at <= APPROVAL_MS && byId(state.pendingApproval.threadId)) {
        chosen = byId(state.pendingApproval.threadId); rule = 'rueckfrage'
        if (/^\s*\d/.test(content)) state.pendingApproval = undefined
    } else if (SMALLTALK.test(content)) { chosen = lastFresh; key = chosen ? chosen.key : 'allgemein'; rule = 'smalltalk' }
    else if (state.pendingQuestion && now - state.pendingQuestion.at <= QUESTION_MS && words(content) <= ANSWER_WORDS
        && byId(state.pendingQuestion.threadId) && (keys.length === 0 || keys.includes(byId(state.pendingQuestion.threadId)!.key))) {
        chosen = byId(state.pendingQuestion.threadId); rule = 'rueckfrage'; state.pendingQuestion = undefined
    } else if (keys.length === 1) { key = keys[0]; rule = 'marke' }
    else if (keys.length > 1) { key = lastFresh && keys.includes(lastFresh.key) ? lastFresh.key : keys[0]; rule = 'unklar' }
    else if (lastFresh && words(content) <= FOLLOW_WORDS && FOLLOW_CUE.test(content)) { chosen = lastFresh; rule = 'folge' }
    else { key = 'allgemein'; rule = 'allgemein' }

    let isNew = false
    if (!chosen && rule === 'smalltalk' && key === 'allgemein') chosen = state.threads.find(thread => thread.key === 'allgemein')
    if (!chosen && rule !== 'smalltalk') {
        chosen = state.threads.find(thread => thread.key === key)
        if (!chosen) {
            chosen = { id: `thread:${key}`, key, name: NAME.get(key) ?? key, createdAt: now, lastAt: now, turns: 0 }
            state.threads.push(chosen)
            isNew = true
        }
    }
    if (!chosen) {
        // Small talk with no active thread: Allgemein, but never created for it.
        const foreignHistoryShare = share(state.recent, 'thread:allgemein', now)
        state.recent = [...state.recent, { at: now, threadId: 'thread:allgemein', rule }].slice(-50)
        store.markDirty()
        return { threadId: 'thread:allgemein', key: 'allgemein', name: 'Allgemein', rule, isNew: false, foreignHistoryShare }
    }
    const foreignHistoryShare = share(state.recent, chosen.id, now)
    chosen.lastAt = now
    chosen.turns++
    state.recent = [...state.recent, { at: now, threadId: chosen.id, rule }].slice(-50)
    store.markDirty()
    return { threadId: chosen.id, key: chosen.key, name: chosen.name, rule, isNew, foreignHistoryShare }
}

function ago(ms: number): string {
    const minutes = Math.round(ms / 60_000)
    if (minutes < 1) return 'gerade eben'
    if (minutes < 60) return `vor ${minutes} min`
    const hours = Math.round(minutes / 60)
    return hours < 24 ? `vor ${hours} h` : `vor ${Math.round(hours / 24)} Tagen`
}

/** /themen: view only. */
export function formatThemen(threads: readonly TopicThread[], now = Date.now(), mode = 'shadow'): string {
    if (!threads.length) return '🧵 Noch keine Themen erkannt.'
    const lines = threads.slice(0, 20).map(thread => `• ${thread.name} — ${thread.turns} Nachricht${thread.turns === 1 ? '' : 'en'}, zuletzt ${ago(now - thread.lastAt)}`)
    const note = mode === 'on' ? '' : '\n\n(Probebetrieb: Themen werden erkannt und gemessen, der Verlauf ist noch gemeinsam.)'
    return `🧵 *Themen*\n${lines.join('\n')}${note}`
}
