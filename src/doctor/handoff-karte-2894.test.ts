/**
 * 2.89.4 Fix 6 — the Claude/Doctor handoff card is everyday German: what is
 * broken (one sentence) and what Ja does; technical details only behind
 * „Details“.
 */
import { describe, expect, it } from 'vitest'
import { handoffDelegationRequest, type HandoffRecord } from './claude-handoff.js'
import { formatCardText, formatCardTextShort } from '../core/approval-cards.js'

const record: HandoffRecord = {
    id: 'nova-abc', caseId: 'case-1', title: 'Trace success rate is below target',
    observation: 'Success rate is 7.0% across 748 traces.',
    report: 'health_status: 40 Tool-Fehler', evidenceRefs: ['doctor:doctor_x'],
    node: 'node-fixture', version: '2.79.3', state: 'queued', createdAt: '2026-09-30T21:30:00Z',
}

describe('2.89.4 handoff card: plain German for the owner', () => {
    const request = handoffDelegationRequest(record)

    it('names what is broken and what Ja does — no developer wording', () => {
        expect(request.karte).toBeTruthy()
        expect(request.karte!.problem).toContain('Trace success rate is below target')
        expect(request.karte!.problem).toMatch(/Etwas ist bei mir nicht in Ordnung/)
        expect(request.karte!.ja).toContain('Claude')
        expect(request.karte!.ja).toMatch(/Mit „Ja“/)
        const short = `${request.karte!.problem} ${request.karte!.ja}`
        expect(short).not.toMatch(/verifizierten Doctor-Fall|Regressionstest|Release-Gates|CI und/)
        expect(short).not.toMatch(/case-1/)
    })

    it('keeps the technical task for Claude, out of the short card', () => {
        expect(request.auftrag).toContain('Regressionstest')
        expect(request.auftrag).toContain('Release-Gates')
    })

    it('the short Telegram card is the plain text; Details hold the technical task', () => {
        const card = {
            id: 'k0000000000000001', art: 'delegation', titel: 'Auftrag an Claude senden?',
            beleg: `Technischer Auftrag an Claude:\n${request.auftrag}\nErfolgskriterium: Doctor-Fall case-1 nach Rollout gemessen geschlossen.`,
            vorschlag: `${request.karte!.problem} ${request.karte!.ja}`,
            aktion: { kind: 'delegation', ref: 'dlg-000000000001' }, wirkung: 'intern' as const, stufe: 'fragen' as const,
            node: 'local', quelle: 'delegation', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
            status: 'offen' as const, buttons: [], usedTokens: [], messages: [],
        }
        const short = formatCardTextShort(card as any)
        expect(short.startsWith('🔘 Auftrag an Claude senden?')).toBe(true)
        expect(short).toContain('Etwas ist bei mir nicht in Ordnung')
        expect(short).toContain('Mit „Ja“')
        expect(short).not.toContain('Regressionstest')
        expect(short).not.toContain('Release-Gates')
        expect(short).not.toContain('case-1')
        const details = formatCardText(card as any)
        expect(details).toContain('Regressionstest')
        expect(details).toContain('Release-Gates')
        expect(details).toContain('Technischer Auftrag')
    })
})
