import { describe, expect, it } from 'vitest'
import { boundIncompleteSummary, exhaustionSynthesisPrompt } from './tool-evidence-response.js'

// 2.89.16 (Abnahme 2.89.15, task D, 29.10. 13:30:04): after the run stopped, the last tool-free model call wrote
// 6113 characters ("nicht vollständig ausgewertet" + a node listing) - twelve Telegram pages.
describe('the closing summary of an unfinished run stays short', () => {
    it('cuts a long summary at a sentence boundary', () => {
        const long = Array.from({ length: 80 }, (_, i) => `Knoten ${i} meldet einen Zustand ohne Desktop.`).join(' ')
        const out = boundIncompleteSummary(long)
        expect(out.length).toBeLessThanOrEqual(1200)
        expect(out).toMatch(/[.!?…]$/)
    })
    it('leaves a short summary as it is', () => {
        expect(boundIncompleteSummary('Ich konnte keinen Knoten mit Desktop erreichen.')).toBe('Ich konnte keinen Knoten mit Desktop erreichen.')
    })
    it('the prompt asks for at most five short sentences', () => {
        expect(exhaustionSynthesisPrompt([{ toolName: 'fetch_url', success: true, result: 'Seite' }])).toMatch(/höchstens fünf kurze Sätze/)
    })
})
