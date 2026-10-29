import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as router from '../tools/tool-router.js'
import { assignThread, formatThemen, TopicThreadStore, type ThreadInput } from './topic-threads.js'

const PROFILE = [
    { name: 'BYD Dolphin Surf', kind: 'vehicle', aliases: ['Dolphin'] },
    { name: 'Ozzy', kind: 'dog', aliases: [] },
    { name: 'Max', kind: 'dog', aliases: [] },
]
const T0 = Date.parse('2026-10-29T12:00:00Z')
const routesOf = (text: string) => router.requestRouteNames(text).map(item => item.route)

let dir: string, store: TopicThreadStore, now: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'threads-')); store = new TopicThreadStore(join(dir, 'topic-threads.json')); now = T0 })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ask = (content: string, extra: Partial<ThreadInput> = {}) => {
    now += 60_000
    return assignThread({ principalId: 'owner', content, routes: routesOf(content), profileEntities: PROFILE, now, ...extra }, store)
}

describe('2.91.0 Themen-Fäden: a sentence goes to its topic (real tool routes)', () => {
    it.each([
        ['Welche Lichter sind an?', 'haus'],
        ['Schalte das Licht im Wohnzimmer aus', 'haus'],
        ['Mach die Steckdose vom Drucker an', 'haus'],
        ['Ist der 3D-Drucker fertig mit dem Druck?', 'haus'],
        ['Wie voll ist der Akku vom Dolphin?', 'auto'],
        ['Lädt das Auto gerade an der Wallbox?', 'auto'],
        ['Wie weit komme ich noch mit dem Auto?', 'auto'],
        ['Wie heißen meine Hunde?', 'hunde'],
        ['Wann war Ozzy zuletzt beim Tierarzt?', 'hunde'],
        ['Max hat heute nichts gefressen', 'hunde'],
        ['Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist und wer ich bin.', 'infra'],
        ['Zeig mir die Pods im Cluster', 'infra'],
        ['Leg im Cluster einen Test-Pod mit busybox an', 'infra'],
        ['Wie viel RAM hat ns2?', 'infra'],
        ['Starte meine Test-VM', 'infra'],
        ['Welche Docker-Container laufen lokal?', 'infra'],
        ['wie geht es ns1?', 'infra'],
        ['Öffne greenchili.at auf deinem Computer', 'computer'],
        ['Mach einen Screenshot vom Desktop', 'computer'],
        ['Google nach photo-aigner.at', 'recherche'],
        ['Was ist die Schlagzeile auf heise.de?', 'recherche'],
        ['Verfolge DHL 12345678', 'pakete'],
    ])('„%s“ → %s', (content, key) => {
        const result = ask(content)
        expect(result.key).toBe(key)
        expect(result.rule).toBe('marke')
    })
})

describe('2.91.0 Gegenproben: no topic, no new thread', () => {
    it.each(['Wie spät ist es?', 'Wer bist du?', 'Erzähl mir einen Witz', 'Wie geht es dir heute?'])('„%s“ → Allgemein', content => {
        const result = ask(content)
        expect(result.key).toBe('allgemein')
        expect(result.rule).toBe('allgemein')
    })
    it.each(['danke', 'test', 'ok', 'hallo'])('small talk „%s“ never creates a thread', content => {
        const result = ask(content)
        expect(result.rule).toBe('smalltalk')
        expect(result.isNew).toBe(false)
        expect(store.threads('owner').length).toBeLessThanOrEqual(1)
    })
    it('small talk right after a topic stays in that topic', () => {
        ask('Welche Lichter sind an?')
        expect(ask('danke').key).toBe('haus')
    })
})

describe('2.91.0 follow-ups, questions back and approvals stay in the asking thread', () => {
    it('a short follow-up with a cue goes to the last active thread', () => {
        ask('Welche Lichter sind an?')
        const result = ask('und jetzt alle aus')
        expect(result.key).toBe('haus')
        expect(['folge', 'marke']).toContain(result.rule)
        expect(ask('nochmal bitte').key).toBe('haus')
    })
    it('a follow-up after 15 minutes does not stick to the old thread', () => {
        ask('Welche Lichter sind an?')
        now += 20 * 60_000
        expect(ask('und jetzt?').key).toBe('allgemein')
    })
    it('an answer to Xaventra’s question goes to the thread that asked, even after another topic', () => {
        const pod = ask('Leg im Cluster einen Test-Pod mit busybox an')
        store.noteOutcome('owner', pod.threadId, { askedQuestion: true, now })
        ask('Welche Lichter sind an?')
        const answer = ask('ja, mit busybox')
        expect(answer.key).toBe('infra')
        expect(answer.rule).toBe('rueckfrage')
    })
    it('an open question expires after 10 minutes', () => {
        const pod = ask('Leg im Cluster einen Test-Pod mit busybox an')
        store.noteOutcome('owner', pod.threadId, { askedQuestion: true, now })
        now += 11 * 60_000
        expect(ask('ja').rule).not.toBe('rueckfrage')
    })
    it('the one-time code and /freigabe go to the thread waiting for approval', () => {
        const printer = ask('Mach die Steckdose vom Drucker an')
        store.noteOutcome('owner', printer.threadId, { awaitingApproval: true, now })
        ask('Wie voll ist der Akku vom Dolphin?')
        expect(ask('/freigabe hass_turn_on switch.k1').key).toBe('haus')
        const code = ask('482913')
        expect(code.key).toBe('haus')
        expect(code.rule).toBe('rueckfrage')
        // the code closes the open approval: a later number is not pulled into Haus
        expect(ask('123456').rule).not.toBe('rueckfrage')
    })
})

describe('2.91.0 room, reply and unclear cases', () => {
    it('a chosen desktop room wins', () => {
        const result = ask('Welche Lichter sind an?', { roomId: 'room-7' })
        expect(result.threadId).toBe('room:room-7')
        expect(result.rule).toBe('raum')
    })
    it('a reply to an earlier message inherits its thread', () => {
        const dog = ask('Wie heißen meine Hunde?')
        store.noteOutgoing('owner', 'tg:1:555', dog.threadId)
        ask('Welche Lichter sind an?')
        const reply = ask('und wie alt ist der?', { replyTo: 'tg:1:555' })
        expect(reply.key).toBe('hunde')
        expect(reply.rule).toBe('antwort')
    })
    it('two topics in one sentence are unclear; the last active one of them wins', () => {
        ask('Zeig mir die Pods im Cluster')
        const result = ask('Schalte das Licht im Wohnzimmer aus und zeig mir die Pods im Cluster')
        expect(result.rule).toBe('unklar')
        expect(result.key).toBe('infra')
    })
    it('the same topic reuses its thread; a new topic creates exactly one', () => {
        const first = ask('Welche Lichter sind an?')
        const second = ask('Schalte das Licht im Wohnzimmer aus')
        expect(second.threadId).toBe(first.threadId)
        expect(first.isNew).toBe(true)
        expect(second.isNew).toBe(false)
    })
})

describe('2.91.0 measurement and privacy', () => {
    it('foreign history share: the part of the recent turns that belongs to other topics', () => {
        ask('Welche Lichter sind an?'); ask('Wie voll ist der Akku vom Dolphin?'); ask('Zeig mir die Pods im Cluster')
        const result = ask('Schalte das Licht im Wohnzimmer aus')
        expect(result.foreignHistoryShare).toBeCloseTo(2 / 3, 2)
    })
    it('the store keeps no sentence, only a few keywords per thread', () => {
        ask('Wann war Ozzy zuletzt beim Tierarzt?')
        ask('Wie ist der Stand bei der Bricks Website für die Termine?')
        store.save()
        const raw = readFileSync(join(dir, 'topic-threads.json'), 'utf8')
        expect(raw).not.toContain('Wann war Ozzy')
        expect(raw).not.toContain('Stand bei der Bricks')
        expect(raw).toContain('hunde')
        for (const thread of store.threads('owner')) expect(thread.terms.length).toBeLessThanOrEqual(12)
    })
    it('groups and guests get no threads', () => {
        const result = ask('Welche Lichter sind an?', { isGroup: true })
        expect(result.rule).toBe('aus')
        expect(store.threads('owner')).toHaveLength(0)
    })
})

describe('2.91.0 /themen', () => {
    it('lists the threads with last activity, view only', () => {
        ask('Welche Lichter sind an?'); ask('Schalte das Licht im Wohnzimmer aus'); ask('Wie heißen meine Hunde?')
        const text = formatThemen(store.threads('owner'), now, 'shadow')
        expect(text).toContain('Haus')
        expect(text).toContain('2 Nachrichten')
        expect(text).toContain('Hunde')
        expect(text).toMatch(/Probe|Schatten/)
        expect(formatThemen([], now, 'shadow')).toContain('Noch keine')
    })
})

describe('2.91.0 automatic: threads appear, get a name, merge, rest and correct themselves (no command needed)', () => {
    it('real content without a fixed topic opens its own thread with a short name from the content', () => {
        const first = ask('Wie ist der Stand bei der Bricks Website für die Termine?')
        expect(first.isNew).toBe(true)
        expect(first.rule).toBe('inhalt')
        expect(first.name).toMatch(/Bricks/)
        expect(first.name.split(/\s+/).length).toBeLessThanOrEqual(3)
        const again = ask('Kannst du bei Bricks die Termine für Samstag eintragen?')
        expect(again.threadId).toBe(first.threadId)
        expect(again.rule).toBe('inhalt')
        expect(again.isNew).toBe(false)
    })
    it('a sentence that joins two threads merges them into the older one', () => {
        const wedding = ask('Plane die Hochzeit von Lisa im Mai')
        const party = ask('Wie viele Gäste kommen zur Gartenparty?')
        expect(party.threadId).not.toBe(wedding.threadId)
        const bridge = ask('Die Gartenparty gehört eigentlich zur Hochzeit')
        expect(bridge.threadId).toBe(wedding.threadId)
        expect(bridge.merged).toBe(1)
        expect(store.threads('owner').some(thread => thread.id === party.threadId)).toBe(false)
        expect(ask('Wer kommt zur Gartenparty?').threadId).toBe(wedding.threadId)
    })
    it('a thread rests after 7 days without activity and wakes when its topic comes back', () => {
        const bricks = ask('Wie ist der Stand bei der Bricks Website für die Termine?')
        now += 8 * 24 * 60 * 60_000
        ask('Welche Lichter sind an?')
        expect(store.threads('owner').find(thread => thread.id === bricks.threadId)?.status).toBe('ruhend')
        const back = ask('Trag bei Bricks den nächsten Termin ein')
        expect(back.threadId).toBe(bricks.threadId)
        expect(back.woke).toBe(true)
        expect(store.threads('owner').find(thread => thread.id === bricks.threadId)?.status).toBe('aktiv')
    })
    it('„nein, ich meine das Auto“ moves the previous message to Auto and counts a correction', () => {
        ask('Mach die Steckdose vom Drucker an')
        const vague = ask('und wie lange noch?')
        expect(vague.key).toBe('haus')
        const fix = ask('nein, ich meine das Auto')
        expect(fix.key).toBe('auto')
        expect(fix.rule).toBe('korrektur')
        expect(fix.corrected).toBe(true)
        const haus = store.threads('owner').find(thread => thread.key === 'haus')!
        expect(haus.turns).toBe(1)
        expect(store.threads('owner').find(thread => thread.key === 'auto')!.turns).toBe(2)
    })
    it.each(['nein, das stimmt nicht', 'Nein danke', 'nein'])('„%s“ is no correction', content => {
        ask('Welche Lichter sind an?')
        expect(ask(content).rule).not.toBe('korrektur')
    })
})
