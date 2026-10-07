import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, createApprovalCard, registerCardExecutor, unregisterCardExecutor, type CardStoreOptions } from './approval-cards.js'
import { _setDecisionMainCheckForTest, listDecisions, observeOwnerMessage } from './decisions.js'
import { buildBriefing } from '../planner/briefing.js'

// Kausales Gedächtnis: die Verdrahtung in Knopf-Karten und Abendbericht.

const OWNER = '111'
const T0 = Date.parse('2026-10-01T10:00:00Z')
let dir: string
let opts: CardStoreOptions

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'decisions-wiring-'))
    opts = { dataDir: dir, now: () => T0, ledger: null }
    unregisterCardExecutor('test-dauer')
    registerCardExecutor({ isStillOpen: () => true, kind: 'test-dauer', allowAlways: () => true, async execute() { return { ok: true, message: 'ok' } } })
})
afterEach(() => {
    _setDecisionMainCheckForTest(null)
    unregisterCardExecutor('test-dauer')
    rmSync(dir, { recursive: true, force: true })
})

function card() {
    const result = createApprovalCard({ art: 'test-dauer', titel: 'Bericht täglich ablegen', beleg: 'Alfred liest ihn morgens', vorschlag: 'ablegen', aktion: { kind: 'test-dauer', ref: 'r1' } }, opts)
    if (!result.ok) throw new Error(result.reason)
    return result.card
}
const press = (data: string, userId = OWNER) => answerApprovalCard(data, { userId, ownerIds: [OWNER] }, opts)

describe('Knopf-Antworten werden Entscheidungen', () => {
    it('„Immer erlauben“ vom Owner → bindender Eintrag mit dem Beleg als Grund', async () => {
        _setDecisionMainCheckForTest(() => true)
        const c = card()
        const result = await press(`ac:${c.buttons.find(b => b.answer === 'immer')!.token}`)
        expect(result.ok).toBe(true)
        const [decision] = listDecisions({ dataDir: dir, now: () => T0 })
        expect(decision).toMatchObject({ bindend: true, quelle: { art: 'knopf', ref: c.id, von: `telegram:${OWNER}` } })
        expect(decision.warum).toContain('Alfred liest ihn morgens')
    })

    it('Gegenprobe: ein Fremder drückt → kein Eintrag; „Ja“ (einmalig) → kein Eintrag', async () => {
        _setDecisionMainCheckForTest(() => true)
        const c = card()
        expect((await press(`ac:${c.buttons.find(b => b.answer === 'immer')!.token}`, '999')).code).toBe('kein-owner')
        await press(`ac:${c.buttons.find(b => b.answer === 'ja')!.token}`)
        expect(listDecisions({ dataDir: dir })).toHaveLength(0)
    })

    it('Gegenprobe: auf einem Worker wird nichts gemerkt', async () => {
        _setDecisionMainCheckForTest(() => false)
        const c = card()
        await press(`ac:${c.buttons.find(b => b.answer === 'immer')!.token}`)
        expect(listDecisions({ dataDir: dir })).toHaveLength(0)
    })
})

describe('Abendbericht', () => {
    it('nennt selbst gemerkte Entscheidungen', () => {
        const decisionOpts = { dataDir: dir, now: () => T0, isMain: () => true }
        observeOwnerMessage({ text: 'Ab jetzt Telegram nur am Main, weil es nur einen Konsumenten gibt.', permission: 'owner', principalId: 'alfred' }, decisionOpts)
        const thoughts = { list: () => [], markNotice: () => undefined } as any
        const briefing = buildBriefing('abend', { dataDir: dir, thoughts, runsFile: join(dir, 'runs.jsonl'), timeZone: 'Europe/Vienna' }, T0 - 3_600_000, T0 + 3_600_000)
        expect(briefing.text).toContain('Neu gemerkt (Entscheidungen)')
        expect(briefing.text).toContain('Telegram nur am Main')
        expect(briefing.counts.gemerkt).toBe(1)
    })
})
