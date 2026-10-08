import { describe, expect, it } from 'vitest'
import { followUpHint, isLikelyFollowUp } from './follow-up-hint.js'

describe('short follow-up hint', () => {
    const history = [
        { role: 'user', content: 'Screenshot von allen Nodes', timestamp: 1000 },
        { role: 'assistant', content: 'xaventra-spark: Bild gesendet. lab: kein Bild aufgenommen.', timestamp: 1001 },
    ]
    it('recognises short follow-ups and ignores new topics', () => {
        for (const text of ['Was ist mit dem lab?', 'und X?', 'Von welchem Knoten kam das Bild und was war darauf?', 'Warum nicht?'])
            expect(isLikelyFollowUp(text), text).toBe(true)
        for (const text of ['Schreibe mir ein Gedicht über den Herbst im Salzkammergut bitte', '/status', ''])
            expect(isLikelyFollowUp(text), text).toBe(false)
    })
    it('names the previous answer, and only while it is recent', () => {
        const hint = followUpHint('Was ist mit dem lab?', history, 2000)
        expect(hint).toContain('lab: kein Bild aufgenommen')
        expect(hint).toContain('Screenshot von allen Nodes')
        expect(followUpHint('Was ist mit dem lab?', history, 1001 + 46 * 60_000)).toBe('')
        expect(followUpHint('Was ist mit dem lab?', [], 2000)).toBe('')
    })
})
