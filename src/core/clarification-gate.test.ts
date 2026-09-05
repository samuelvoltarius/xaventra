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
})
