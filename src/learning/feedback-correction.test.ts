import { describe, expect, it } from 'vitest'
import { LearningEngine } from './engine.js'
import { FeedbackCollector } from './feedback.js'

const ctx = { channel: 'telegram', userId: 'owner' }

describe('R2 L5: corrections are not echoed back', () => {
    it('does not answer a correction message with its own text', () => {
        const engine = new LearningEngine({ persistInterval: 0 })
        engine.processUserMessage('Wann ist das Meeting morgen?', ctx)
        engine.recordBotResponse('Um 9 Uhr.', ctx)

        const learned = engine.processUserMessage('Eigentlich sollte das Meeting um 10 sein, trag das ein', ctx)

        expect(learned).toBeNull()
    })

    it('learns the correction for the question it corrects', () => {
        const engine = new LearningEngine({ persistInterval: 0 })
        engine.processUserMessage('Wann ist das Meeting morgen?', ctx)
        engine.recordBotResponse('Um 9 Uhr.', ctx)
        engine.processUserMessage('Eigentlich ist es um 10 Uhr', ctx)

        const learned = engine.processUserMessage('Wann ist das Meeting morgen?', ctx)
        expect(learned?.source).toBe('correction')
        expect(learned?.response).toContain('10 Uhr')
    })

    it('never matches short or empty follow-up messages', () => {
        const engine = new LearningEngine({ persistInterval: 0 })
        engine.processUserMessage('Wann ist das Meeting morgen?', ctx)
        engine.recordBotResponse('Um 9 Uhr.', ctx)
        engine.processUserMessage('Eigentlich ist es um 10 Uhr', ctx)

        for (const msg of ['ja', '10', 'morgen', '📷', '']) {
            expect(engine.processUserMessage(msg, ctx)).toBeNull()
        }
    })

    it('ignores stored corrections with too-short patterns', () => {
        const collector = new FeedbackCollector()
        collector.collectFeedback({ type: 'correction', userMessage: '', botResponse: '', correction: 'alt', userId: 'owner' })

        expect(collector.getLearnedResponse('', 'owner')).toBeUndefined()
        expect(collector.getLearnedResponse('Bild ohne Text 👍', 'owner')).toBeUndefined()
    })
})
