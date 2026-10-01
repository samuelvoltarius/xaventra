import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DecisionLearner, isNeverKind, isPhysicalOrExternalKind } from './decision-learning.js'
import { MemoryThoughtSink, parseThinkingSettings } from './ports.js'

const settings = (patch: Record<string, unknown> = {}) => parseThinkingSettings({ enabled: true, learning: { enabled: true, ...patch } })
const learner = (sink = new MemoryThoughtSink(), patch: Record<string, unknown> = {}, ledger?: { recordApproval: (runId: string, value: Record<string, unknown>) => void }) =>
    new DecisionLearner({ settings: settings(patch), sink, path: join(mkdtempSync(join(process.cwd(), 'decide-')), 'd.json'), ledger: ledger ?? { recordApproval: () => {} } })

describe('Phase 3 Lernen aus Antworten', () => {
    it('after 5x "Ja" for the same kind it asks "Immer erlauben?" exactly once', async () => {
        const sink = new MemoryThoughtSink()
        const l = learner(sink)
        for (let i = 0; i < 4; i++) expect((await l.recordDecision('installieren:ffmpeg', 'ja')).proposed).toBeUndefined()
        const fifth = await l.recordDecision('installieren:ffmpeg', 'ja')
        expect(fifth.proposed).toMatchObject({ source: 'lernen', stufe: 'fragen', proposal: { action: 'immer-erlauben', autoExecute: false } })
        expect(fifth.proposed!.title).toMatch(/Immer erlauben\?/)
        expect(fifth.proposed!.evidence[0]).toMatchObject({ metric: 'ja-in-folge', value: 5 })
        await l.recordDecision('installieren:ffmpeg', 'ja')
        expect(sink.thoughts).toHaveLength(1)
    })

    it('never asks "Immer erlauben?" for printing, sending, switching or buying', async () => {
        const sink = new MemoryThoughtSink()
        const l = learner(sink)
        for (const kind of ['drucken', 'drucker:naechster-auftrag', 'email:senden', 'telegram-nachricht-senden', 'schalten:licht', 'ha:turn_on', 'kaufen', 'bestellung', 'print:job', 'send_message']) {
            expect(isPhysicalOrExternalKind(kind), kind).toBe(true)
            for (let i = 0; i < 8; i++) await l.recordDecision(kind, 'ja')
        }
        expect(sink.thoughts).toHaveLength(0)
    })

    it('never asks for kinds on the never-list', async () => {
        const sink = new MemoryThoughtSink()
        const l = learner(sink)
        for (const kind of ['daten:loeschen', 'secrets:lesen', 'db:migration', 'nas:neustart', 'vllm:stoppen', 'backup-delete']) {
            expect(isNeverKind(kind), kind).toBe(true)
            for (let i = 0; i < 6; i++) await l.recordDecision(kind, 'ja')
        }
        expect(sink.thoughts).toHaveLength(0)
    })

    it('"Nein" resets the streak and lowers the future importance of that kind', async () => {
        const sink = new MemoryThoughtSink()
        const l = learner(sink)
        expect(l.importanceFactor('neustart-vorschlag')).toBe(1)
        for (let i = 0; i < 4; i++) await l.recordDecision('neustart-vorschlag', 'ja')
        await l.recordDecision('neustart-vorschlag', 'nein')
        const once = l.importanceFactor('neustart-vorschlag')
        expect(once).toBeLessThan(1)
        await l.recordDecision('neustart-vorschlag', 'nein')
        expect(l.importanceFactor('neustart-vorschlag')).toBeLessThan(once)
        for (let i = 0; i < 20; i++) await l.recordDecision('neustart-vorschlag', 'nein')
        expect(l.importanceFactor('neustart-vorschlag')).toBeGreaterThanOrEqual(0.2)
        for (let i = 0; i < 4; i++) await l.recordDecision('neustart-vorschlag', 'ja')
        expect(sink.thoughts).toHaveLength(0)
        expect(l.importanceFactor('anderes')).toBe(1)
    })

    it('every answer lands in the outcome ledger (sanitised run id)', async () => {
        const recordApproval = vi.fn()
        const l = learner(new MemoryThoughtSink(), {}, { recordApproval })
        await l.recordDecision('Installieren: ffmpeg/../x', 'spaeter')
        expect(recordApproval).toHaveBeenCalledTimes(1)
        const [runId, payload] = recordApproval.mock.calls[0]
        expect(runId).toMatch(/^decision-[A-Za-z0-9_.@-]+$/)
        expect(runId).not.toContain('..')
        expect(payload).toMatchObject({ answer: 'spaeter' })
    })

    it('does nothing while learning is off, and never lowers the 5-answer threshold', async () => {
        const sink = new MemoryThoughtSink()
        const off = new DecisionLearner({ settings: parseThinkingSettings({ enabled: true, learning: { enabled: false } }), sink, path: join(mkdtempSync(join(process.cwd(), 'decide-')), 'd.json'), ledger: { recordApproval: () => {} } })
        expect((await off.recordDecision('installieren:x', 'ja')).recorded).toBe(false)
        expect(settings({ alwaysAllowAfter: 2 }).learning.alwaysAllowAfter).toBe(5)
    })
})
