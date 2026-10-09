/**
 * 2.89.4 Fix 1 over the real Telegram entry (createE2EHarness → real adapter,
 * planner card bridge, scripted model): a Tuya-LAN notice reaches the owner as
 * ONE understandable sentence — no title/text/Beleg triple, no raw JSON, no
 * mid-word „…“. A pure-info repeat is summarized, not re-sent.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => {
    await h?.close(); h = undefined
})
const T = 90_000

const TUYA_SATZ = 'Unbekanntes Gerät im Netz (Tuya) war im letzten Suchlauf nicht sichtbar – nur keine Anmeldung, für dich ändert sich nichts.'

async function deliverThroughRealTelegram(sent: string[], steps: number = 1): Promise<void> {
    const adapter = h!.state.channels.telegram
    adapter.sendApprovalCard = async (_chatId: string, text: string) => { sent.push(String(text)); return 1 }
    const thoughts = await h!.module('planner/thoughts.js')
    const planner = await h!.module('planner/index.js')
    const bridge = await h!.module('core/planner-card-bridge.js')
    const hub = await h!.module('core/thought-hub.js')
    for (let i = 0; i < steps; i++) {
        hub.createSensingThoughtSink().writeThought({
            schema: 'xaventra.sensing.thought/1', id: `st_${i}`, at: new Date().toISOString(), source: 'discovery',
            title: TUYA_SATZ, summary: TUYA_SATZ,
            evidence: { geraet: 'Unbekanntes Gerät im Netz (Tuya)', erreichbar: false },
            importance: 'hoch', level: 'selbst', status: 'neu',
            delivery: { notify: true, urgent: false, reason: 'ok' },
            origin: { nodeId: 'local', role: 'main' }, dedupeKey: 'hardware:dev-e2etuya:false',
        })
    }
    await thoughts.deliverPendingThoughts(
        planner.getThoughtStore(),
        bridge.createPlannerTelegramPort(adapter),
        { briefingEnabled: false },
    )
}

describe('2.89.4 proaktive Meldung (realer Telegram-Weg)', () => {
    it('Tuya-LAN: one plain sentence, no triple, no JSON, no mid-word cut', async () => {
        h = await createE2EHarness()
        // A normal owner turn first, so the entry and channels are live like on the Main.
        const turn = await h.telegram('Hallo', [{ text: 'Alles klar.' }])
        expect(turn.error).toBeUndefined()
        const sent: string[] = []
        await deliverThroughRealTelegram(sent, 1)
        expect(sent.length).toBeGreaterThan(0)
        const message = sent.join('\n')
        expect(message).toContain('Unbekanntes Gerät im Netz (Tuya)')
        expect(message).toContain('für dich ändert sich nichts')
        expect(message).not.toMatch(/\{.*\}/)
        expect(message).not.toContain('geraet:')
        expect(message).not.toContain('…')
        const titleCount = message.split('Unbekanntes Gerät im Netz (Tuya) war im letzten').length - 1
        expect(titleCount).toBe(1)
    }, T)

    it('the same pure info again is summarized, not sent a second time', async () => {
        h = await createE2EHarness()
        await h.telegram('Hallo', [{ text: 'Alles klar.' }])
        const sent: string[] = []
        await deliverThroughRealTelegram(sent, 1)
        const first = sent.length
        expect(first).toBeGreaterThan(0)
        // Same signature again (within the dedupe window) → no second push.
        await deliverThroughRealTelegram(sent, 1)
        expect(sent.length).toBe(first)
    }, T)
})
