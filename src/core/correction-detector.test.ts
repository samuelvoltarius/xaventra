import { describe, expect, it } from 'vitest'
import { isCorrection, isRecentToolCall, processForCorrection } from './correction-detector.js'

describe('correction detector intent boundaries', () => {
    it('does not classify release metrics as a correction', () => {
        const report = [
            'Nova 2.70.1 ist fertig implementiert und produktiv ausgerollt.',
            'Automatische Regression-Fälle aus Fehlern und Nutzerkorrekturen',
            'Falsche Fertigmeldungen: 0',
            'Regression Gate: PASS',
            'das hab ich heute bei dir gemacht',
        ].join('\n')

        expect(isCorrection(report)).toBe(false)
    })

    it('still recognizes an explicit concrete correction', () => {
        const result = processForCorrection('Korrektur: Spark ist der Main, nicht Home.')
        expect(result).toMatchObject({
            isCorrection: true,
            hasCorrectVersion: true,
            shouldTriggerLearning: true,
            message: '',
        })
    })

    it('still recognizes a correction without matching adjective prefixes', () => {
        expect(isCorrection('Das ist falsch.')).toBe(true)
        expect(isCorrection('Falsche Fertigmeldungen: 0')).toBe(false)
    })

    it('never attributes feedback to a stale tool execution', () => {
        const now = Date.now()
        const tool = { toolName: 'self_setup_plan', params: {}, result: 'ok', userRequest: 'old', timestamp: now - 51 * 60_000 }
        expect(isRecentToolCall(tool, now)).toBe(false)
        expect(isRecentToolCall({ ...tool, timestamp: now - 30_000 }, now)).toBe(true)
    })

    it('does not treat another principal recent tool as correction context', () => {
        expect(isCorrection('nein', 'telegram:other-user')).toBe(false)
    })
})
