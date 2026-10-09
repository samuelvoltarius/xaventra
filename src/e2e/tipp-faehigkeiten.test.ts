/**
 * 2.89.4 Fix 5 over the real Telegram entry: no tip without a real capability,
 * never a promise, switchable off.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => {
    await h?.close(); h = undefined
})
const T = 90_000

describe('2.89.4 Tipps nur für echte Fähigkeiten (realer Telegram-Weg)', () => {
    it('no printer, no printer tip — and no promise wording', async () => {
        h = await createE2EHarness()
        await h.telegram('Hallo', [{ text: 'Alles klar.' }])
        const adapter = h!.state.channels.telegram
        const sent: string[] = []
        const send = async (_c: string, text: string) => { sent.push(String(text)); return 1 }
        adapter.sendWithButtons = send as any
        adapter.sendApprovalCard = send as any
        const guided = await h!.module('guided/guided-runtime.js')
        const fakeTg = {
            canSend: async () => true,
            ownerChatIds: () => ['700000001'],
            send,
            edit: async () => {},
        }
        // A title that merely contains „Drucker“ — not a printer protocol.
        await guided.runGuidedTelegramTick(fakeTg, {
            dataDir: h!.root,
            inventory: null,
            verbunden: async () => [{ id: 'x', title: 'Drucker im Titel ohne Protokoll' }],
            ruhezeit: () => false,
            kritisch: () => 0,
            fragen: async () => ({ frage: null, wartend: 0 }),
            checklist: { overview: async () => ({ gefunden: [], verbunden: [] }), telegramGekoppelt: () => true },
            isMain: () => true,
        })
        const text = sent.join('\n')
        expect(text).not.toMatch(/Druck fertig|sag dir Bescheid, sobald/)
        expect(text).not.toContain('sobald der Druck')
    }, T)

    it('a real printer may get the tip — phrased as something you can ask', async () => {
        h = await createE2EHarness()
        await h.telegram('Hallo', [{ text: 'Alles klar.' }])
        const sent: string[] = []
        const keyboards: any[][][] = []
        const send = async (_c: string, text: string, keyboard: any[][]) => { sent.push(String(text)); keyboards.push(keyboard); return 1 }
        const guided = await h!.module('guided/guided-runtime.js')
        const fakeTg = { canSend: async () => true, ownerChatIds: () => ['700000001'], send, edit: async () => {} }
        await guided.runGuidedTelegramTick(fakeTg, {
            dataDir: h!.root,
            inventory: null,
            verbunden: async () => [{ id: 'geraet:moonraker:192.0.2.20:7125', title: 'Drucker (Klipper)', connectorId: 'moonraker' }],
            ruhezeit: () => false,
            kritisch: () => 0,
            fragen: async () => ({ frage: null, wartend: 0 }),
            checklist: { overview: async () => ({ gefunden: [], verbunden: [] }), telegramGekoppelt: () => true },
            isMain: () => true,
        })
        const tip = sent.find(text => text.startsWith('💡'))
        expect(tip).toBeDefined()
        expect(tip).toMatch(/Du kannst fragen|Wusstest du\?/)
        expect(tip).not.toMatch(/sag dir Bescheid, sobald/)
        expect(keyboards[sent.indexOf(tip!)].flat().map(button => button.text)).toContain('Tipps aus')
    }, T)
})
