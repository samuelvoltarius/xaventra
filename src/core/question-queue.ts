/**
 * 2.86 Paket M „Geführt“, Punkt 2 — immer nur EINE Frage zur Zeit.
 *
 * The card loop asks this queue which questions may go out now:
 * - At most ONE question is visible (pushed and unanswered) at a time. A
 *   bundle (card-bundle.ts, e.g. all found devices) counts as one question.
 * - The next one only goes out when the visible one is answered, declined,
 *   snoozed („Später“), expired or settled elsewhere.
 * - Waiting questions are ordered by importance: critical (security/outage
 *   wording or `wichtig`) → real deadline (< 2 h left) → physical/outward →
 *   the rest; then the earlier deadline, then the older question.
 * - Critical questions and those with a real deadline may jump the queue:
 *   they go out even while another question is visible.
 * - 2.86: so does the DIRECT answer to what the owner asked for just now
 *   (device preview of „mach die Stehlampe aus“, the device list after
 *   „Welche Geräte findest du?“, the card after pressing „Sprachdienst
 *   einrichten“) — but only for `DIREKT_FENSTER_MS`; follow-ups such as
 *   error offers („Nochmal versuchen, wenn es wieder an ist?“) wait.
 * - Nothing is lost: waiting questions stay open cards (in „Heute“, in the
 *   menu „Braucht mich“) and the report lists how many wait.
 *
 * Pure functions over the card store; delivery stays in approval-card-sources
 * and card-bundle.
 */
import { BUNDLE_MIN_REMAINING_MS, isCardDue, listApprovalCards, type ApprovalCard, type CardStoreOptions } from './approval-cards.js'

export type QuestionRank = 0 | 1 | 2 | 3
const URGENT = /sicherheit|security|ausfall|outage|offline|nicht erreichbar|unreachable|\bdown\b|alarm|kritisch|critical|notfall|einbruch|intrusion|angriff|attack|leck|leak/i

/** 0 = critical, 1 = real deadline, 2 = physical/outward, 3 = the rest. */
export function questionRank(card: Pick<ApprovalCard, 'art' | 'titel' | 'beleg' | 'quelle' | 'wirkung' | 'expiresAt'> & { wichtig?: boolean }, now: number): QuestionRank {
    if (card.wichtig === true || URGENT.test(`${card.art} ${card.quelle} ${card.titel} ${card.beleg}`)) return 0
    if (Date.parse(card.expiresAt) - now < BUNDLE_MIN_REMAINING_MS) return 1
    if (card.wirkung !== 'intern') return 2
    return 3
}

/** May this question go out while another one is visible? */
export const mayJumpQueue = (rank: QuestionRank) => rank <= 1

/** How long „the owner just asked for it“ holds (a direct answer may jump the queue). */
export const DIREKT_FENSTER_MS = 10 * 60_000
export const isDirectAnswer = (direktAt: string | undefined, now: number) => {
    const at = Date.parse(String(direktAt || ''))
    return Number.isFinite(at) && now - at >= 0 && now - at < DIREKT_FENSTER_MS
}

export interface QueueItem { kind: 'karte' | 'buendel'; id: string; rank: QuestionRank; expiresAt: number; createdAt: number; anzahl: number; direkt?: boolean }
export interface QueuePlan {
    /** Standalone cards to deliver now. */
    karten: string[]
    /** Bundle keys that may be sent as a NEW message now (edits of a visible bundle are always fine). */
    buendel: string[]
    /** Questions that wait (bundles count their devices). */
    wartend: number
    /** What the owner sees right now (null = nothing open). */
    sichtbar: { kind: 'karte' | 'buendel'; id: string } | null
}

const compare = (a: QueueItem, b: QueueItem) => a.rank - b.rank || a.expiresAt - b.expiresAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id)

/**
 * The plan for one loop pass. `bundleVisible(key)` tells whether a bundle
 * message is currently out (sent and not closed).
 */
export function planQuestions(input: { cards: ApprovalCard[]; bundleVisible: (key: string) => boolean; bundleIntoReport?: boolean; now: number; bundleDirect?: (key: string) => boolean }): QueuePlan {
    const now = input.now
    const open = input.cards.filter(card => card.status === 'offen' && Date.parse(card.expiresAt) > now)
    const visibleCards = open.filter(card => !card.buendel && card.deliveredAt)
    const pendingCards = open.filter(card => !card.buendel && !card.deliveredAt && isCardDue(card, { bundleIntoReport: input.bundleIntoReport, now }))
    const bundles = new Map<string, ApprovalCard[]>()
    for (const card of open) if (card.buendel) bundles.set(card.buendel, [...(bundles.get(card.buendel) || []), card])
    const groupsOf = (cards: ApprovalCard[]) => new Set(cards.map(card => card.gruppe || card.id)).size

    const visibleBundles = [...bundles.keys()].filter(key => input.bundleVisible(key))
    const items: QueueItem[] = [
        ...pendingCards.map(card => ({ kind: 'karte' as const, id: card.id, rank: questionRank(card, now), expiresAt: Date.parse(card.expiresAt), createdAt: Date.parse(card.createdAt), anzahl: 1, direkt: isDirectAnswer(card.direktAt, now) })),
        ...[...bundles].filter(([key]) => !visibleBundles.includes(key)).map(([key, cards]) => ({
            kind: 'buendel' as const, id: key,
            rank: Math.min(...cards.map(card => questionRank(card, now))) as QuestionRank,
            expiresAt: Math.min(...cards.map(card => Date.parse(card.expiresAt))),
            createdAt: Math.min(...cards.map(card => Date.parse(card.createdAt))),
            anzahl: groupsOf(cards),
            direkt: input.bundleDirect?.(key) === true || cards.some(card => isDirectAnswer(card.direktAt, now)),
        })),
    ].sort(compare)

    const chosen: QueueItem[] = items.filter(item => mayJumpQueue(item.rank) || item.direkt)
    const anythingVisible = visibleCards.length > 0 || visibleBundles.length > 0 || chosen.length > 0
    if (!anythingVisible && items.length) chosen.push(items[0])
    const chosenIds = new Set(chosen.map(item => `${item.kind}:${item.id}`))
    const wartend = items.filter(item => !chosenIds.has(`${item.kind}:${item.id}`)).reduce((sum, item) => sum + item.anzahl, 0)
    const shown = visibleCards.length ? { kind: 'karte' as const, id: [...visibleCards].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0].id }
        : visibleBundles.length ? { kind: 'buendel' as const, id: visibleBundles[0] }
            : chosen.length ? { kind: chosen[0].kind, id: chosen[0].id } : null
    return {
        karten: chosen.filter(item => item.kind === 'karte').map(item => item.id),
        buendel: chosen.filter(item => item.kind === 'buendel').map(item => item.id),
        wartend,
        sichtbar: shown,
    }
}

/**
 * All open questions in queue order (for „Heute“ and the menu): the visible
 * one first, then the waiting ones by importance.
 */
export function orderedOpenQuestions(cards: ApprovalCard[], now: number): ApprovalCard[] {
    const open = cards.filter(card => card.status === 'offen')
    const shownFirst = (card: ApprovalCard) => (card.deliveredAt || card.buendel ? 0 : 1)
    return [...open].sort((a, b) => shownFirst(a) - shownFirst(b) || questionRank(a, now) - questionRank(b, now)
        || Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.createdAt.localeCompare(b.createdAt))
}

/** How many questions wait behind the visible one (for the report). */
export function waitingQuestionCount(opts: CardStoreOptions & { bundleVisible?: (key: string) => boolean; bundleIntoReport?: boolean } = {}): number {
    const now = (opts.now || Date.now)()
    return planQuestions({ cards: listApprovalCards({ ...opts, status: 'offen' }), bundleVisible: opts.bundleVisible || (() => false), bundleIntoReport: opts.bundleIntoReport, now }).wartend
}
