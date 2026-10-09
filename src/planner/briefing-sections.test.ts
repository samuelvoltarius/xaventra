import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBriefing } from './briefing.js'
import { createThoughtStore } from './thoughts.js'
import { createPlannerTelegramPort } from '../core/planner-card-bridge.js'
import { pressNav } from '../channels/telegram-pages.js'

// Paket L 3+4: the report is short (traffic light + one line per section), every
// section opens behind its own button; unanswered expired questions are listed.

let dir: string
let t: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brief-sec-')); t = Date.parse('2026-10-06T05:00:00.000Z') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function sources(extra: Record<string, unknown> = {}) {
    const thoughts = createThoughtStore({ dataDir: dir, now: () => t })
    for (let i = 1; i <= 9; i++) thoughts.add({ source: 'test', title: `Frage ${i}: Gerät dev-00000000a${i} prüfen`, kind: 'vorschlag', permission: 'fragen', signature: `q${i}` })
    return { dataDir: dir, thoughts, runsFile: join(dir, 'runs.jsonl'), timeZone: 'Europe/Vienna', ...extra } as any
}

describe('Bericht mit Abschnitten', () => {
    it('lists expired unanswered questions once and keeps every line in its section', () => {
        const briefing = buildBriefing('morgen', sources({ cards: { bundled: () => [], release: () => 0, expiredSince: () => [{ titel: 'Hue Bridge koppeln?' }] } }), t - 12 * 3_600_000, t)
        expect(briefing.text).toContain('Ohne Antwort abgelaufen')
        expect(briefing.text).toContain('Hue Bridge koppeln?')
        const waiting = briefing.sections.find(section => section.titel === 'Wartet auf dich')!
        expect(waiting.zeilen).toHaveLength(9)
        expect(waiting.zeilen.join(' ')).not.toMatch(/dev-/)
        // 2.89.4: ONE question number with a meaning (same as the menu button).
        expect(briefing.kopf).toBe('🟡 Alles läuft — 1 Frage für dich, 8 danach')
        expect(briefing.fragen).toBe(9)
    })

    it('Telegram: short overview with one button per section; a press shows that section', async () => {
        const briefing = buildBriefing('morgen', sources(), t - 12 * 3_600_000, t)
        const tg = { hasCardAuthority: vi.fn(async () => true), getOwnerChatIds: vi.fn(() => ['111']), sendApprovalCard: vi.fn(async () => 42) }
        await createPlannerTelegramPort(tg).deliver({ id: 'out-000000000009', kind: 'briefing', title: briefing.title, text: briefing.text, sections: briefing.sections, kopf: briefing.kopf, fragen: briefing.fragen, urgency: 'normal', createdAt: new Date(t).toISOString() } as any)
        const [chatId, text, keyboard] = tg.sendApprovalCard.mock.calls[0] as unknown as [string, string, any[][]]
        expect(chatId).toBe('111')
        expect(text.length).toBeLessThanOrEqual(600)
        expect(text.startsWith('🟡')).toBe(true)
        // 2.89.4: top 3 open points as short sentences + one summary — not a counter wall.
        expect(text).toContain('• Frage 1')
        expect(text).toContain('• Frage 3')
        expect(text).not.toContain('• Frage 4')
        expect(text).toContain('9 Punkte brauchen dich')
        expect(text).not.toContain('Wartet auf dich: 9')
        const section = keyboard.flat().find(b => /Wartet auf dich/.test(b.text))!
        expect(keyboard.flat().map(b => b.text)).toEqual(expect.arrayContaining(['Status', 'Bericht', 'Mehr']))
        const opened = pressNav(section.callback_data, { userId: '111', ownerIds: ['111'], chatId: '111' })
        expect(opened.ok).toBe(true)
        expect(opened.edit!.text).toContain('Frage 1')
        expect(opened.edit!.keyboard.flat().some(b => /Übersicht/.test(b.text))).toBe(true)
    })
})
