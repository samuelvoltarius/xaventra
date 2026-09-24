import { beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { evaluateClarification } from './clarification-gate.js'
import { SessionContinuityStore, setSessionContinuityStore } from '../memory/session-summarizer.js'

describe('ClarificationGate', () => {
    beforeEach(() => setSessionContinuityStore(new SessionContinuityStore(join(mkdtempSync(join(tmpdir(), 'nova-clarify-')), 'continuity.json'))))

    it('asks one targeted question for a high-impact action without a target', () => {
        const result = evaluateClarification('user:a', 'Installiere Codex')
        expect(result.action).toBe('ask')
        expect(result.missingFields).toEqual(['target'])
    })

    it('resumes the original task from the next user answer', () => {
        evaluateClarification('user:a', 'Installiere Codex')
        const result = evaluateClarification('user:a', 'auf dem Spark')
        expect(result.action).toBe('continue')
        expect(result.content).toContain('Installiere Codex')
        expect(result.content).toContain('auf dem Spark')
    })

    it('does not question an explicit target', () => {
        expect(evaluateClarification('user:a', 'Installiere Codex auf dem aktuellen Main').action).toBe('continue')
    })

    it.each([
        'Wie spät ist es?',
        'Wie viel Uhr ist es?',
        'What time is it?',
        'wer bit du wer bin ich und wie spät ist es?',
        'Wer bist du, wer bin ich und wie viel Uhr ist es?',
        'Who are you and what time is it?',
    ])('does not treat an impersonal time question as an ambiguous reference: %s', request => {
        const result = evaluateClarification('user:a', request)
        expect(result.action).toBe('continue')
        expect(result.content).toBe(request)
    })

    it('still asks for a destructive target alongside a time question', () => {
        const result = evaluateClarification('user:a', 'Wie spät ist es und lösche es')
        expect(result.action).toBe('ask')
        expect(result.missingFields).toContain('target')
    })

    it('does not hide another ambiguous reference alongside a time question', () => {
        expect(evaluateClarification('user:a', 'Wie spät ist es und prüfe das').action).toBe('ask')
    })
})
