/**
 * 2.89.4 Fix 2 — Morgenbericht: top 3 open points as short sentences, one
 * summary sentence, counters at most one line; one consistent question count
 * (never „Fragen warten 39“ vs „Wartet auf dich 31“). Nothing important =
 * „Alles ruhig“.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBriefing } from './briefing.js'
import { createThoughtStore } from './thoughts.js'
import { createPlannerTelegramPort } from '../core/planner-card-bridge.js'
import { overviewText, sectionedView } from '../channels/telegram-pages.js'

let dir: string
let t: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'morgen-')); t = Date.parse('2026-10-09T05:00:00.000Z') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function sources(extra: Record<string, unknown> = {}) {
    const thoughts = createThoughtStore({ dataDir: dir, now: () => t })
    return { dataDir: dir, thoughts, runsFile: join(dir, 'runs.jsonl'), timeZone: 'Europe/Vienna', ...extra } as any
}

describe('2.89.4 overviewText: a short story, not a counter wall', () => {
    it('top 3 open points + one summary + one counters line', () => {
        const text = overviewText({
            kopf: '🟡 Alles läuft — 1 Frage für dich, 2 danach',
            titel: 'Morgenbericht 09.10. 07:30',
            sections: [
                { titel: 'Wartet auf dich', zeilen: ['Frage zu den Lampen', 'Hue Bridge koppeln?', 'Paket abholen', 'Brief unterschreiben'] },
                { titel: 'Erledigt', zeilen: ['Backup fertig'] },
            ],
        })
        expect(text).toContain('• Frage zu den Lampen')
        expect(text).toContain('• Hue Bridge koppeln?')
        expect(text).toContain('• Paket abholen')
        expect(text).not.toContain('• Brief unterschreiben')
        expect(text).toContain('4 Punkte brauchen dich')
        expect(text).toContain('Erledigt 1')
        expect(text).not.toContain('Wartet auf dich:')
        expect(text).not.toMatch(/\d+\n.*\d+\n.*\d+\n.*\d+/)
    })

    it('nothing that needs the owner = „Alles ruhig“ in one sentence', () => {
        const text = overviewText({
            kopf: '🟢 Alles läuft — keine Frage offen',
            titel: 'Morgenbericht 09.10. 07:30',
            sections: [{ titel: 'Erledigt', zeilen: ['Backup fertig'] }],
        })
        expect(text).toContain('Alles ruhig – nichts, das dich gerade braucht.')
        expect(text).toContain('Erledigt 1')
    })

    it('nothing at all = „Alles ruhig – nichts Neues“', () => {
        expect(overviewText({ kopf: '🟢 Alles läuft — keine Frage offen', titel: 'Morgenbericht', sections: [] }))
            .toContain('Alles ruhig – nichts Neues.')
    })
})

describe('2.89.4 one question count with a meaning', () => {
    it('the head and the menu use the same number (waiting + queue + bundled)', async () => {
        const thoughts = sources().thoughts
        for (let i = 1; i <= 3; i++) thoughts.add({ source: 'test', title: `Frage ${i}`, kind: 'vorschlag', permission: 'fragen', signature: `q${i}` })
        const briefing = buildBriefing('morgen', {
            ...sources({ thoughts }),
            cards: { bundled: () => [{ id: 'c1', art: 'x', titel: 'Karte 1' }], release: () => 0, waiting: () => 2 },
        }, t - 12 * 3_600_000, t)
        expect(briefing.fragen).toBe(3 + 2 + 1)
        expect(briefing.kopf).toBe('🟡 Alles läuft — 1 Frage für dich, 5 danach')
        const tg = { hasCardAuthority: vi.fn(async () => true), getOwnerChatIds: () => ['111'], sendApprovalCard: vi.fn(async () => 1) }
        await createPlannerTelegramPort(tg).deliver({
            id: 'out-000000000001', kind: 'briefing', title: briefing.title, text: briefing.text,
            sections: briefing.sections, kopf: briefing.kopf, fragen: briefing.fragen,
            urgency: 'normal', createdAt: new Date(t).toISOString(),
        })
        const sent = String(tg.sendApprovalCard.mock.calls[0][1])
        expect(sent).toContain('1 Frage für dich')
        expect(sent).not.toMatch(/Fragen warten/)
        expect(sent).not.toContain('Wartet auf dich:')
    })
})

describe('2.89.4 sectionedView uses overviewText', () => {
    it('renders the narrative overview with section buttons', () => {
        const view = sectionedView('111', {
            kopf: '🟡 Alles läuft — 1 Frage für dich',
            titel: 'Morgenbericht',
            sections: [{ titel: 'Wartet auf dich', zeilen: ['Hue Bridge koppeln?'] }],
        }, { dataDir: dir, counts: { fragen: 1 } })
        expect(view.text).toContain('• Hue Bridge koppeln?')
        expect(view.text).toContain('Kurz: der eine Punkt braucht dich')
        expect(view.keyboard.flat().some(b => /Wartet auf dich/.test(b.text))).toBe(true)
    })
})
