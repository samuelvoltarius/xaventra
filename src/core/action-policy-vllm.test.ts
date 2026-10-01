import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateAction, isNieAktionsart, isNurEinzelnesJa, nieEffekt, recordActionOutcome, TRUST_MIN_SUCCESSES, trustEvidence, trustUpgradeProposal } from './action-policy.js'
import { createApprovalCard, registerCardExecutor, unregisterCardExecutor } from './approval-cards.js'

// Alfred 01.10.2026: „Ein vLLM-Modellwechsel am Spark darf laufen — als Knopf-
// Karte mit automatischem Rückweg. ‚vLLM stoppen ohne Rückweg‘ bleibt auf der
// Nie-Liste.“ Der Wechsel ist L2 mit einzelnem Ja: nie „immer“, nie L1.
describe('Aktions-Policy: vLLM-Wechsel', () => {
    afterEach(() => unregisterCardExecutor('vllm-wechsel'))

    it('vllm-wechsel ist eine bekannte L2-Art mit Karte und wird von keinem Nie-Muster getroffen', () => {
        expect(isNieAktionsart('vllm-wechsel')).toBe(false)
        expect(isNieAktionsart('modell-wechsel vllm-wechsel')).toBe(false)
        expect(nieEffekt('host-agent:vllm-modell-wechseln')).toBeNull()
        expect(evaluateAction({ kind: 'vllm-wechsel', effects: ['host-agent:vllm-modell-wechseln'], origin: 'owner' })).toMatchObject({ level: 'L2', decision: 'ask', known: true })
    })

    it('wird nie automatisch — egal was Aufrufer oder Modell behaupten', () => {
        for (const origin of ['mission', 'verantwortung', 'model', 'selbstheilung', 'denken', 'owner'])
            expect(evaluateAction({ kind: 'vllm-wechsel', origin, level: 'L0', decision: 'auto' }).decision).toBe('ask')
    })

    it.each(['vllm-stoppen', 'vllm-stop', 'vllm-wechsel-stoppen', 'vllm-container-stop', 'vllm-beenden', 'vllm-kill', 'vllm-abschalten', 'vllm-shutdown', 'vllm:aus', 'vllm-ausschalten', 'vllm-deaktivieren', 'modell-wechsel vllm-stoppen'])(
        '„%s“ bleibt Nie-Liste (L3, keine Karte)', kind => {
            expect(isNieAktionsart(kind)).toBe(true)
            expect(evaluateAction({ kind: kind.split(' ').pop()!, origin: 'owner' })).toMatchObject({ level: 'L3', decision: 'handoff' })
            expect(evaluateAction({ kind: kind.split(' ').pop()!, origin: 'model' }).decision).toBe('never')
        })

    it.each(['vllm:stoppen', 'vllm:stop', 'host-agent:vllm-stoppen', 'vllm:kill', 'docker:vllm-container-stop'])('Effekt „%s“ ist Nie-Liste — auch unter der Art vllm-wechsel', effect => {
        expect(nieEffekt(effect)).toBe('vLLM stoppen')
        expect(evaluateAction({ kind: 'vllm-wechsel', effects: [effect], origin: 'owner' }).level).toBe('L3')
    })

    it('eine Karte für vLLM-Stoppen entsteht nie, auch nicht hinter der Art vllm-wechsel', () => {
        const opts = { dataDir: mkdtempSync(join(tmpdir(), 'policy-vllm-')), ledger: null }
        expect(createApprovalCard({ art: 'vllm-stoppen', titel: 'x', beleg: 'x', vorschlag: 'x', aktion: { kind: 'vllm-stoppen', ref: 'r1' } }, opts).ok).toBe(false)
        expect(createApprovalCard({ art: 'modell-wechsel', titel: 'x', beleg: 'x', vorschlag: 'x', aktion: { kind: 'vllm-wechsel', ref: 'r2' }, effects: ['vllm:stoppen'] }, opts).ok).toBe(false)
        expect(() => registerCardExecutor({ kind: 'vllm-stoppen', execute: async () => ({ ok: true, message: '' }) })).toThrow(/Nie-Liste/)
    })

    it('nie „Immer erlauben“ — auch wenn ein Ausführer es anbieten wollte', () => {
        const opts = { dataDir: mkdtempSync(join(tmpdir(), 'policy-vllm-')), ledger: null }
        expect(isNurEinzelnesJa('vllm-wechsel')).toBe(true)
        registerCardExecutor({ kind: 'vllm-wechsel', allowAlways: () => true, execute: async () => ({ ok: true, message: '' }) })
        const card = createApprovalCard({ art: 'modell-wechsel', titel: 'x', beleg: 'x', vorschlag: 'x', aktion: { kind: 'vllm-wechsel', ref: 'v0123456789ab' } }, opts)
        if (!card.ok) throw new Error(card.reason)
        expect(card.card.buttons.map(button => button.answer)).toEqual(['ja', 'nein', 'spaeter'])
    })

    it('nie L1 über die Vertrauensleiter, auch nach vielen Erfolgen', () => {
        const opts = { dataDir: mkdtempSync(join(tmpdir(), 'policy-vllm-trust-')) }
        for (let i = 0; i < TRUST_MIN_SUCCESSES * 3; i++) recordActionOutcome('vllm-wechsel', { ok: true }, opts)
        expect(trustEvidence('vllm-wechsel', opts).successes).toBe(TRUST_MIN_SUCCESSES * 3)
        expect(trustUpgradeProposal('vllm-wechsel', opts)).toBeNull()
        expect(evaluateAction({ kind: 'vllm-wechsel', origin: 'mission' }).level).toBe('L2')
    })
})
