import { describe, expect, it } from 'vitest'
import { addToHistory, getSession, replaceLastAssistantInHistory } from './nova-runner.js'

// Live 08.10.2026: after the deterministic screenshot receipt, "Was ist mit dem lab?" was answered
// without reference to it, because the agent history still held the model's own (replaced) text.
describe('agent history holds the answer the user actually received', () => {
    it('replaces the last assistant turn so a short follow-up sees the receipt', () => {
        const user = 'user-history-sync'
        addToHistory(user, 'benchmark', { role: 'user', content: 'Screenshot von allen Nodes', timestamp: 1 })
        addToHistory(user, 'benchmark', { role: 'assistant', content: 'Alle Bilder gesendet.', timestamp: 2 })
        expect(replaceLastAssistantInHistory(user, 'benchmark', 'lab: kein Bild aufgenommen — Aufnahme noch nicht freigeschaltet')).toBe(true)
        const history = getSession(user, 'benchmark').history
        expect(history.at(-1)?.content).toContain('lab: kein Bild aufgenommen')
        expect(history.at(-2)?.content).toBe('Screenshot von allen Nodes')
    })
})
