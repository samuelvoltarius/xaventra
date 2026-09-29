import { beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { evaluateClarification } from './clarification-gate.js'
import { BeliefStore, getBeliefStore, setBeliefStore } from './belief-store.js'
import { getSessionContinuityStore, SessionContinuityStore, setSessionContinuityStore } from '../memory/session-summarizer.js'

describe('ClarificationGate', () => {
    beforeEach(() => {
        const root = mkdtempSync(join(tmpdir(), 'nova-clarify-'))
        setSessionContinuityStore(new SessionContinuityStore(join(root, 'continuity.json')))
        setBeliefStore(new BeliefStore(join(root, 'beliefs.json')))
    })

    it('does not ask the user to settle derived workflow reliability before a fresh observation', () => {
        getBeliefStore().observe({ userId: 'user:a', subject: 'workflow:system-state', predicate: 'route-success', value: 'failed', source: 'outcome:failed', summary: 'failed observation', confidence: 1, supports: false })
        expect(evaluateClarification('user:a', 'Prüfe den Systemstatus auf dem Main').action).toBe('continue')
        expect(evaluateClarification('user:a', 'Und mach mal eine Screenshot deines Systems und send mir diesen').action).toBe('continue')
        expect(getBeliefStore().unresolved('user:a')).toHaveLength(1)
        expect(evaluateClarification('user:a', 'Lösche das').action).toBe('ask')
    })

    it('keeps actual factual conflicts and other users isolated', () => {
        getBeliefStore().observe({ userId: 'user:a', subject: 'Archivserver', predicate: 'destination', value: 'unknown', source: 'user', summary: 'uncertain destination', confidence: 1, supports: false })
        expect(evaluateClarification('user:b', 'Installiere Docker auf dem Archivserver').action).toBe('continue')
        expect(evaluateClarification('user:a', 'Installiere Docker auf dem Archivserver').missingFields).toEqual(['belief'])
    })

    it('retires only the obsolete workflow question rather than replaying its old action', () => {
        getSessionContinuityStore().setPendingClarification('user:a', {
            id: 'old-workflow', originalRequest: 'Prüfe den Systemstatus auf dem Main',
            question: 'Ich habe dazu widersprüchliche oder unsichere Evidence (workflow:system-state). Welche Angabe soll ich als gültig behandeln?',
            missingFields: ['belief'], createdAt: Date.now(),
        })
        const current = 'Wie spät ist es?'
        expect(evaluateClarification('user:a', current).content).toBe(current)
    })

    it('does not treat a screenshot as a target for an additional destructive action', () => {
        expect(evaluateClarification('user:a', 'Mach einen Screenshot deines Systems und lösche das').action).toBe('ask')
    })

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

    it('resolves an explicit URL retry from one quoted GET example without prior session context', () => {
        const text = "test es noch mal [24.09.2026 15:56] User: Backend: searxng\nURL: http://example.test:8088\n[24.09.2026 18:27] User: check mal url\n-sS --get 'http://example.test:8088/search' --data-urlencode 'q=Agent' --data-urlencode 'format=json'";
        expect(evaluateClarification('user:retry', text).action).toBe('continue')
    })

    it('recognizes a single URL in a direct read-only check but not as a destructive target', () => {
        expect(evaluateClarification('user:url', 'prüfe das https://example.test/search').action).toBe('continue')
        expect(evaluateClarification('user:risk', 'prüfe https://example.test und lösche es').action).toBe('ask')
        expect(evaluateClarification('user:missing', 'prüfe das als URL').action).toBe('ask')
        expect(evaluateClarification('user:two', 'prüfe das https://one.test https://two.test').action).toBe('ask')
    })

    it('does not prepend a stale URL-reference question to the next current request', () => {
        getSessionContinuityStore().setPendingClarification('user:stale-url', {
            id: 'old-url-question', originalRequest: 'prüfe das https://example.test/search',
            question: 'Worauf genau bezieht sich das?', missingFields: ['reference'], createdAt: Date.now(),
        })
        const current = 'prüfe das https://example.test/other'
        expect(evaluateClarification('user:stale-url', current).content).toBe(current)
        expect(getSessionContinuityStore().getSummary('user:stale-url')?.pendingClarification).toBeFalsy()
    })

    it.each([
        'Du wirst nun ent docker und native installiert dann hast du die Full power',
        'Ich installiere dich morgen nativ.',
        'Wie installiere ich Docker?',
        'Was bedeutet „Installiere Docker“?',
    ])('lets the model respond conversationally without an execution target: %s', text => {
        const result = evaluateClarification('user:a', text)
        expect(result.action).toBe('continue')
        expect(result.content).toBe(text)
    })

    it('retains the target gate for a real request following an announcement', () => {
        expect(evaluateClarification('user:a', 'Ich installiere dich später; installiere jetzt Docker').missingFields).toEqual(['target'])
    })

    it('does not take a new announcement as consent to a pending installation', () => {
        evaluateClarification('user:a', 'Installiere Codex')
        const statement = 'Ich installiere dich morgen nativ.'
        expect(evaluateClarification('user:a', statement).content).toBe(statement)
        expect(evaluateClarification('user:a', 'auf dem Spark').content).toContain('Installiere Codex')
    })

    it('discards only a legacy clarification created from a non-action announcement', () => {
        const store = getSessionContinuityStore()
        store.setPendingClarification('user:a', {
            id: 'legacy', originalRequest: 'Du wirst nun ent docker und native installiert dann hast du die Full power',
            question: 'Auf welchem Node?', missingFields: ['target'], createdAt: Date.now(),
        })
        expect(evaluateClarification('user:a', 'Wie geht es dir?').content).toBe('Wie geht es dir?')
        expect(store.getSummary('user:a')?.pendingClarification).toBeFalsy()
    })

    it('does not borrow an unrelated announcement target for a new destructive request', () => {
        const result = evaluateClarification('user:a', 'Ich installiere Docker auf Spark; lösche das jetzt')
        // The destructive clause must itself require evidence and clarification.
        expect(result.action).toBe('ask')
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
