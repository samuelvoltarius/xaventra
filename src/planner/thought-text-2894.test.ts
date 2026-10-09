/**
 * 2.89.4 Fix 1 — proaktive Meldung: one understandable sentence, never
 * title/text/Beleg three times, no raw JSON, no mid-word „…“, and pure info
 * that already came is summarized instead of re-pushed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanText as sensingCleanText } from '../sensing/ports.js'
import { cleanText as plannerCleanText } from './delivery-port.js'
import { createSensingThoughtSink } from '../core/thought-hub.js'
import { deviceDisplayName, connectionSentence } from '../sensing/adapters/hardware.js'
import { createPlannerTelegramPort } from '../core/planner-card-bridge.js'
import { createThoughtStore, deliverPendingThoughts, formatThoughtText, type Thought } from './thoughts.js'

let dir: string
let t: number
const DAY = Date.parse('2026-10-09T08:00:00.000Z') // 10:00 Vienna

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'th-text-')); t = DAY })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

const thought = (over: Partial<Thought> = {}): Thought => ({
    id: 'th-000000000001', createdAt: new Date(t).toISOString(), updatedAt: new Date(t).toISOString(), lastSeenAt: new Date(t).toISOString(),
    source: 'wahrnehmen-discovery', kind: 'ereignis',
    title: 'Unbekanntes Gerät im Netz (Tuya) war im letzten Suchlauf nicht sichtbar – nur keine Anmeldung, für dich ändert sich nichts.',
    evidence: '', importance: 'wichtig', rule: 'regel:warnung', permission: 'selbst', status: 'offen',
    signature: 's1', seen: 1, notice: 'ausstehend', ...over,
})

describe('2.89.4 formatThoughtText: one understandable message', () => {
    it('never repeats the title as Beleg and never emits raw JSON', () => {
        const text = formatThoughtText(thought({
            evidence: `${thought().title} · geraet: Unbekanntes Gerät im Netz (Tuya), erreichbar: nein`,
        }))
        expect(text).not.toMatch(/\{.*\}/)
        expect(text).not.toContain('JSON')
        expect(text.split('\n').filter(line => line.includes('Unbekanntes Gerät im Netz (Tuya) war')).length).toBe(1)
        expect(text).not.toContain('Beleg:')
    })

    it('folds repeats into one sentence for pure info', () => {
        const text = formatThoughtText(thought({ seen: 18 }))
        expect(text).toBe(`⚠️ ${thought().title} (zusammengefasst: 18× gesehen)`)
        expect(text).not.toContain('Beleg:')
        expect(text).not.toMatch(/\{/)
    })
})

describe('2.89.4 cleanText: never a mid-word cut', () => {
    const long = 'Tuya-LAN-Gerät, konkrete Geräteart noch unbekannt: im begrenzten Zeitfenster keine passende Tuya-Ankündigung; daraus folgt nicht, dass das Gerät offline ist.'
    it.each([
        ['sensing', sensingCleanText],
        ['planner', plannerCleanText],
    ])('%s keeps whole words and whole sentences', (_name, clean) => {
        const text = clean(long, 80)
        expect(text).not.toMatch(/fo…$/)
        expect(text).not.toMatch(/\w…$/)
        expect(text.length).toBeLessThanOrEqual(80)
        expect(text.split(' ').every(word => word.length > 0)).toBe(true)
    })
    it('keeps a complete sentence when one fits', () => {
        expect(sensingCleanText('Alles gut. Zweiter Satz der sehr lang ist und weg muss.', 12)).toBe('Alles gut.')
    })
})

describe('2.89.4 hardware notice wording', () => {
    const tuya = {
        id: 'dev-abc0123456', name: 'Tuya-kompatibles Gerät (Typ noch unbekannt)',
        hardware: { kind: 'unknown' as const, label: 'Tuya-LAN-Gerät, konkrete Geräteart noch unbekannt', certainty: 'confirmed' as const, connector: 'tuya-announcements' as const, ecosystem: 'tuya' as const, observedAt: new Date().toISOString() },
    }
    it('names unknown Tuya gear honestly and explains what it means', () => {
        expect(deviceDisplayName(tuya)).toBe('Unbekanntes Gerät im Netz (Tuya)')
    })
    it('emits one plain sentence, no JSON evidence keys as the message', () => {
        const miss = connectionSentence(tuya, false)
        expect(miss).toBe('Unbekanntes Gerät im Netz (Tuya) war im letzten Suchlauf nicht sichtbar – nur keine Anmeldung, für dich ändert sich nichts.')
        expect(miss).not.toMatch(/\{/)
        expect(miss).not.toContain('…')
        expect(miss).not.toMatch(/ausfall|offline|nicht erreichbar|down/i)
        expect(connectionSentence(tuya, true)).toBe('Unbekanntes Gerät im Netz (Tuya) ist wieder im Netz sichtbar.')
    })
})

describe('2.89.4 sensing evidence never becomes JSON in a thought', () => {
    it('writes a readable evidence line instead of JSON.stringify', async () => {
        // The planner store is file-based on the process data dir; isolate via cwd.
        const previous = process.cwd()
        process.chdir(dir)
        try {
            await createSensingThoughtSink().writeThought({
                schema: 'xaventra.sensing.thought/1', id: 'st_1', at: new Date(t).toISOString(), source: 'discovery',
                title: 'Unbekanntes Gerät im Netz (Tuya) war im letzten Suchlauf nicht sichtbar – nur keine Anmeldung, für dich ändert sich nichts.',
                summary: 'Unbekanntes Gerät im Netz (Tuya) war im letzten Suchlauf nicht sichtbar – nur keine Anmeldung, für dich ändert sich nichts.',
                evidence: { geraet: 'Unbekanntes Gerät im Netz (Tuya)', erreichbar: false },
                importance: 'hoch', level: 'selbst', status: 'neu',
                delivery: { notify: true, urgent: false, reason: 'ok' },
                origin: { nodeId: 'local', role: 'main' }, dedupeKey: 'hardware:dev-abc:false',
            } as any)
            const { listThoughts } = await import('./index.js')
            const stored = listThoughts({ limit: 20 }).find(item => item.title.includes('Tuya'))!
            expect(stored.evidence).not.toMatch(/\{/)
            expect(stored.evidence).toContain('erreichbar: nein')
            expect(stored.evidence).toContain('Unbekanntes Gerät im Netz (Tuya)')
        } finally {
            process.chdir(previous)
        }
    })
})

describe('2.89.4 Wiederholungs-Unterdrückung für reine Info', () => {
    it('after the first notice the same pure info is only summarized, never re-pushed', async () => {
        const store = createThoughtStore({ dataDir: dir, now: () => t, settings: { dedupeMinutes: 60 } })
        const sent: string[] = []
        const port = { name: 'test', deliver: async (msg: any) => { sent.push(msg.text); return { status: 'zugestellt' as const } } }
        store.add({ source: 'wahrnehmen', title: 'Unbekanntes Gerät im Netz (Tuya) war im letzten Suchlauf nicht sichtbar – nur keine Anmeldung, für dich ändert sich nichts.', severity: 'warning', kind: 'ereignis', signature: 'hw:tuya:false' })
        await deliverPendingThoughts(store, port, { briefingEnabled: false })
        expect(sent).toHaveLength(1)
        t += 61 * 60_000
        store.add({ source: 'wahrnehmen', title: 'Unbekanntes Gerät im Netz (Tuya) war im letzten Suchlauf nicht sichtbar – nur keine Anmeldung, für dich ändert sich nichts.', severity: 'warning', kind: 'ereignis', signature: 'hw:tuya:false' })
        await deliverPendingThoughts(store, port, { briefingEnabled: false })
        expect(sent).toHaveLength(1)
        const item = store.list()[0]
        expect(item.seen).toBe(2)
        expect(item.notice).toBe('zurueckgehalten')
        expect(item.noticeReason).toBe('wiederholung')
    })
})

describe('2.89.4 planner → Telegram: no triple title', () => {
    it('sends the title once (mark + title), never title again as a prefix', async () => {
        const store = createThoughtStore({ dataDir: dir, now: () => t })
        const { thought: item } = store.add({
            source: 'wahrnehmen', title: 'Unbekanntes Gerät im Netz (Tuya) war im letzten Suchlauf nicht sichtbar – nur keine Anmeldung, für dich ändert sich nichts.',
            severity: 'warning', kind: 'ereignis', signature: 'hw:tuya:bridge',
        })
        const text = formatThoughtText(item)
        const tg = {
            hasCardAuthority: async () => true,
            getOwnerChatIds: () => ['1001'],
            sendApprovalCard: vi.fn(async () => 7),
        }
        await createPlannerTelegramPort(tg).deliver({
            id: 'out-000000000001', kind: 'gedanke', title: item.title, text, urgency: 'normal',
            createdAt: new Date(t).toISOString(), thoughtId: item.id, permission: 'selbst',
        })
        const sent = String(tg.sendApprovalCard.mock.calls[0][1])
        const titleCount = sent.split('Unbekanntes Gerät im Netz (Tuya)').length - 1
        expect(titleCount).toBe(1)
        expect(sent).not.toMatch(/\{/)
        expect(sent).not.toContain('…')
    })
})
