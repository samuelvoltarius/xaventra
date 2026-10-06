import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundledCards, createApprovalCard, expiredCardsSince, formatCardTextShort, listApprovalCards, maintainApprovalCards } from './approval-cards.js'
import { deliverPendingCards } from './approval-card-sources.js'

// Paket L 3: cards never expire silently — one reminder, then the report.

let dir: string
let t: number
const HOUR = 60 * 60_000
const opts = () => ({ dataDir: dir, now: () => t, ledger: null })
const sender = (sent: string[]) => ({ canSend: async () => true, ownerChatIds: () => ['111'], send: async (_c: string, text: string) => { sent.push(text); return sent.length } })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'card-remind-')); t = Date.parse('2026-10-06T10:00:00.000Z') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Karten laufen nicht still ab', () => {
    it('reminds exactly once before expiry, with the same buttons', async () => {
        const created = createApprovalCard({ art: 'install', titel: 'ffmpeg installieren?', beleg: 'Katalog', vorschlag: 'Installieren', aktion: { kind: 'install', ref: 'iq-1' }, wichtigkeit: 'hoch' }, opts())
        expect(created.ok).toBe(true)
        const sent: string[] = []
        expect(await deliverPendingCards(sender(sent), opts())).toBe(1)
        t += 10 * HOUR
        expect(maintainApprovalCards(opts()).reminded).toHaveLength(0)
        t += 9 * HOUR // 5 h left of 24 h
        const first = maintainApprovalCards(opts())
        expect(first.reminded.map(c => c.titel)).toEqual(['ffmpeg installieren?'])
        expect(await deliverPendingCards(sender(sent), opts())).toBe(1)
        expect(sent).toHaveLength(2)
        const card = listApprovalCards(opts())[0]
        expect(card.buttons.map(b => b.token)).toEqual((created as any).card.buttons.map((b: any) => b.token))
        t += HOUR
        expect(maintainApprovalCards(opts()).reminded).toHaveLength(0)
        expect(await deliverPendingCards(sender(sent), opts())).toBe(0)
    })

    it('an expired card is listed for the next report', () => {
        createApprovalCard({ art: 'install', titel: 'ffmpeg installieren?', beleg: 'Katalog', vorschlag: 'Installieren', aktion: { kind: 'install', ref: 'iq-2' } }, opts())
        const since = t
        t += 25 * HOUR
        expect(maintainApprovalCards(opts()).expired).toHaveLength(1)
        expect(expiredCardsSince(since, t, opts()).map(c => c.titel)).toEqual(['ffmpeg installieren?'])
        expect(expiredCardsSince(t, t + HOUR, opts())).toHaveLength(0)
    })

    it('bundled cards are not sent one by one and not listed as report questions', async () => {
        createApprovalCard({ art: 'geraet-verbinden', titel: 'Hue Bridge koppeln?', beleg: 'x', vorschlag: 'y', aktion: { kind: 'geraet-verbinden', ref: 'dev-0000000001' }, buendel: 'geraete', kurz: 'Hue Bridge' }, opts())
        const sent: string[] = []
        expect(await deliverPendingCards(sender(sent), opts())).toBe(0)
        expect(bundledCards(opts())).toHaveLength(0)
        expect(listApprovalCards(opts())[0]).toMatchObject({ buendel: 'geraete', kurz: 'Hue Bridge' })
    })
})

describe('Kurztext der Karte (Telegram)', () => {
    it('is short and free of technical identifiers; details stay available', () => {
        const created = createApprovalCard({
            art: 'patch', titel: 'Patch für src/core/message-pipeline.ts anwenden?',
            beleg: 'Datei /opt/xaventra-native/2.85.9/dist/core/message-pipeline.js, Fall dev-0123456789, Hash 0123456789abcdef0123456789abcdef, L05 Tool Executor. ' + 'Langer Beleg. '.repeat(80),
            vorschlag: 'Über PATCH_GATE anwenden (Gedanke th-0123456789ab).', aktion: { kind: 'patch', ref: 'p-1' },
        }, opts())
        const text = formatCardTextShort((created as any).card)
        expect(text.length).toBeLessThanOrEqual(600)
        expect(text).not.toMatch(/dev-[a-f0-9]{10}|th-[a-f0-9]{12}|[a-f0-9]{16,}|\/opt\/|\bL05\b|Gültig bis|Art: patch/)
        expect(text).toMatch(/^🔘 Patch/)
    })
})
