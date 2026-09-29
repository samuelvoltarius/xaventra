import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FeedbackCollector } from './feedback.js'
import { loadPatterns, recordFeedback } from '../training/feedback-learner.js'

describe('R2 L13: feedback stores are bounded', () => {
    it('FeedbackCollector keeps at most 500 entries (also after import)', () => {
        const collector = new FeedbackCollector()
        for (let i = 0; i < 520; i++) {
            collector.collectFeedback({ type: 'positive', userMessage: `danke ${i}`, botResponse: 'x', userId: 'u' })
        }
        expect(collector.getAllFeedback()).toHaveLength(500)
        expect(collector.getAllFeedback()[0].userMessage).toBe('danke 20')

        const big = JSON.stringify({ feedback: Array.from({ length: 800 }, (_, i) => [`id${i}`, { id: `id${i}` }]) })
        const imported = new FeedbackCollector()
        imported.importFromJSON(big)
        expect(imported.getAllFeedback()).toHaveLength(500)
    })

    it('feedback-learner caps entries and badResponses per pattern', () => {
        // Runs inside the vitest runtime root (test/vitest.setup.ts chdir).
        for (let i = 0; i < 30; i++) recordFeedback('user_message', `schlechte Antwort ${i}`, 'negative')

        const pattern = loadPatterns().get('user_message')
        expect(pattern?.badResponses.length).toBeLessThanOrEqual(10)
        expect(pattern?.badResponses.at(-1)).toBe('schlechte Antwort 29')

        const file = join(process.cwd(), '.nova-feedback', 'feedback.json')
        expect(existsSync(file)).toBe(true)
        expect(JSON.parse(readFileSync(file, 'utf-8')).length).toBeLessThanOrEqual(500)
    })
})
