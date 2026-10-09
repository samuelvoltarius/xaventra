/**
 * 2.89.4 Fix 6 over the real Telegram entry: the Claude/Doctor handoff card
 * reaches the owner in everyday German (what is broken + what Ja does); the
 * technical task is only in Details.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => {
    await h?.close(); h = undefined
})
const T = 90_000

describe('2.89.4 Claude-Übergabe-Karte (realer Telegram-Weg)', () => {
    it('the short card is everyday German, not a developer handoff', async () => {
        h = await createE2EHarness()
        await h.telegram('Hallo', [{ text: 'Alles klar.' }])
        const adapter = h!.state.channels.telegram
        adapter.hasCardAuthority = async () => true
        const sent: string[] = []
        adapter.sendApprovalCard = async (_chatId: string, text: string) => { sent.push(String(text)); return 1 }
        const handoff = await h!.module('doctor/claude-handoff.js')
        const cards = await h!.module('core/approval-cards.js')
        const record = {
            id: 'nova-e2e', caseId: 'case-e2e-1', title: 'Drucker-Status wird nicht gemeldet',
            observation: 'Statusabfrage liefert kein Ergebnis.',
            report: 'verifiziert, nur lesend erhoben', evidenceRefs: ['doctor:doctor_e2e'],
            node: 'node-fixture', version: '2.89.4', state: 'queued', createdAt: new Date().toISOString(),
        }
        const request = handoff.handoffDelegationRequest(record)
        const created = cards.createApprovalCard({
            art: 'delegation',
            titel: 'Auftrag an Claude senden?',
            beleg: `Technischer Auftrag an Claude:\n${request.auftrag}`,
            vorschlag: `${request.karte.problem} ${request.karte.ja}`,
            aktion: { kind: 'delegation', ref: 'dlg-e2e00000001' },
            quelle: 'delegation',
        })
        expect(created.ok).toBe(true)
        const card = (created as any).card
        const short = cards.formatCardTextShort(card)
        const details = cards.formatCardText(card)
        // deliver the short card over the real Telegram port
        const bridge = await h!.module('core/planner-card-bridge.js')
        await bridge.createPlannerTelegramPort(adapter).deliver({
            id: 'out-e2e-karte', kind: 'gedanke', title: card.titel, text: short,
            urgency: 'normal', createdAt: new Date().toISOString(),
        })
        const message = sent.join('\n')
        expect(message).toContain('Auftrag an Claude senden?')
        expect(message).toContain('Etwas ist bei mir nicht in Ordnung')
        expect(message).toContain('Mit „Ja“')
        expect(message).not.toContain('Regressionstest')
        expect(message).not.toContain('Release-Gates')
        expect(message).not.toContain('verifizierten Doctor-Fall')
        // technical task stays available in Details
        expect(details).toContain('Regressionstest')
        expect(details).toContain('Release-Gates')
    }, T)
})
