/**
 * 2.89.4 Fix 2 over the real Telegram entry: the morning report is a short
 * story (top 3 open points + one summary), counters at most one line, one
 * consistent question count — never two numbers that disagree.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => {
    await h?.close(); h = undefined
})
const T = 90_000

describe('2.89.4 Morgenbericht (realer Telegram-Weg)', () => {
    it('top open points + one summary sentence, no counter wall, one question number', async () => {
        h = await createE2EHarness()
        const turn = await h.telegram('Hallo', [{ text: 'Alles klar.' }])
        expect(turn.error).toBeUndefined()
        const adapter = h!.state.channels.telegram
        const sent: string[] = []
        adapter.sendApprovalCard = async (_chatId: string, text: string) => { sent.push(String(text)); return 1 }
        const briefingMod = await h!.module('planner/briefing.js')
        const thoughts = await h!.module('planner/thoughts.js')
        const planner = await h!.module('planner/index.js')
        const bridge = await h!.module('core/planner-card-bridge.js')
        const store = planner.getThoughtStore()
        for (let i = 1; i <= 5; i++) {
            store.add({ source: 'test', title: `Offener Punkt ${i}: Geräte-Name prüfen`, kind: 'vorschlag', permission: 'fragen', signature: `e2e-m-${i}` })
        }
        const now = Date.now()
        const briefing = briefingMod.buildBriefing('morgen', {
            dataDir: h!.root, thoughts: store, runsFile: `${h!.root}/runs.jsonl`, timeZone: 'Europe/Vienna',
            cards: { bundled: () => [], release: () => 0, waiting: () => 1 },
        }, now - 12 * 3_600_000, now)
        expect(briefing.fragen).toBe(6)
        await bridge.createPlannerTelegramPort(adapter).deliver({
            id: 'out-e2e-morgen', kind: 'briefing', title: briefing.title, text: briefing.text,
            sections: briefing.sections, kopf: briefing.kopf, fragen: briefing.fragen,
            urgency: 'normal', createdAt: new Date(now).toISOString(),
        })
        expect(sent.length).toBeGreaterThan(0)
        const message = sent.join('\n')
        expect(message).toContain('• Offener Punkt 1')
        expect(message).toContain('• Offener Punkt 3')
        expect(message).not.toContain('• Offener Punkt 4')
        expect(message).toMatch(/6 Punkte brauchen dich|1 Frage für dich/)
        expect(message).not.toContain('Wartet auf dich:')
        expect(message).not.toMatch(/Fragen gesammelt: /)
        expect(message).not.toContain('…')
    }, T)

    it('nothing important is one „Alles ruhig“ sentence', async () => {
        h = await createE2EHarness()
        await h.telegram('Hallo', [{ text: 'Alles klar.' }])
        const adapter = h!.state.channels.telegram
        const sent: string[] = []
        adapter.sendApprovalCard = async (_chatId: string, text: string) => { sent.push(String(text)); return 1 }
        const briefingMod = await h!.module('planner/briefing.js')
        const thoughts = await h!.module('planner/thoughts.js')
        const planner = await h!.module('planner/index.js')
        const bridge = await h!.module('core/planner-card-bridge.js')
        const now = Date.now()
        const briefing = briefingMod.buildBriefing('morgen', {
            dataDir: h!.root, thoughts: planner.getThoughtStore(), runsFile: `${h!.root}/runs.jsonl`, timeZone: 'Europe/Vienna',
        }, now - 12 * 3_600_000, now)
        await bridge.createPlannerTelegramPort(adapter).deliver({
            id: 'out-e2e-ruhig', kind: 'briefing', title: briefing.title, text: briefing.text,
            sections: briefing.sections, kopf: briefing.kopf, fragen: briefing.fragen,
            urgency: 'normal', createdAt: new Date(now).toISOString(),
        })
        const message = sent.join('\n')
        expect(message).toMatch(/Alles ruhig/)
        expect(message).not.toContain('Wartet auf dich:')
    }, T)
})
