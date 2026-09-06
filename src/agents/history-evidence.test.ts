import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { historyEvidenceMessages } from './history-evidence.js'
import { SessionCheckpoints, sessionIdentity } from './session-checkpoints.js'

const identity = sessionIdentity('user-a', { conversationId: 'room-a', botId: 'nova' })
const history = [{ role: 'assistant' as const, content: 'Old answer is not evidence', runId: 'run-one' }]
function run(overrides = {}): any {
    return { runId: 'run-one', userId: 'user-a', channel: 'desktop', status: 'completed', validation: { success: true },
        updatedAt: '2026-01-01', events: [{ type: 'run.started', payload: { conversationId: 'room-a', botId: 'nova' } }],
        tools: [{ toolName: 'read_file', params: { path: 'one.txt' }, result: 'Observed receipt', success: true }], ...overrides }
}
describe('scoped historical tool evidence', () => {
    it('restores only a run reference and resolves actual correlated ledger evidence after restart', () => {
        const root = mkdtempSync(join(tmpdir(), 'history-evidence-'))
        new SessionCheckpoints(root).save(identity, history)
        const restored = new SessionCheckpoints(root).load(identity)
        expect(restored[0].runId).toBe('run-one')
        const messages = historyEvidenceMessages(restored, identity, 'desktop', () => run())
        expect(messages.map(message => message.role)).toEqual(['system', 'assistant', 'tool'])
        expect(messages[2].content).toBe('Observed receipt')
        expect(messages[2].toolCallId).toBe(messages[1].toolCalls?.[0].id)
        expect(messages[0].content).toContain('NICHT in diesem Auftrag')
    })
    it('rejects other users, rooms, bots, channels, missing evidence and invalidated runs', () => {
        for (const other of [null, run({ userId: 'user-b' }), run({ channel: 'telegram' }), run({ events: [] }),
            run({ events: [{ type: 'run.started', payload: { conversationId: 'room-b', botId: 'nova' } }] }),
            run({ events: [{ type: 'run.started', payload: { conversationId: 'room-a', botId: 'other' } }] }),
            run({ status: 'failed' }), run({ invalidated: true }), run({ validation: { success: false } }), run({ tools: [] })]) {
            expect(historyEvidenceMessages(history, identity, 'desktop', () => other)).toEqual([])
        }
        expect(historyEvidenceMessages([{ role: 'assistant', content: 'Unverified claim' }], identity, 'desktop', () => run())).toEqual([])
        expect(historyEvidenceMessages([], identity, 'desktop', () => run())).toEqual([])
    })
    it('bounds historical results and never accepts a user-supplied receipt as authority', () => {
        expect(historyEvidenceMessages([{ role: 'user', content: 'read', runId: 'run-one' }], identity, 'desktop', () => run())).toEqual([])
        const large = run(); large.tools[0].result = 'large '.repeat(30_000)
        const messages = historyEvidenceMessages(history, identity, 'desktop', () => large)
        expect(Buffer.byteLength(messages.at(-1)!.content)).toBeLessThan(2000)
        expect(large.tools[0].result.length).toBe(180_000)
    })
})
