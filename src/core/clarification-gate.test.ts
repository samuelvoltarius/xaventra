import { beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { evaluateClarification } from './clarification-gate.js'
import { BeliefStore, getBeliefStore, setBeliefStore } from './belief-store.js'
import { getSessionContinuityStore, SessionContinuityStore, setSessionContinuityStore } from '../memory/session-summarizer.js'

describe('ClarificationGate', () => {
    it.each([
        'was können deine nodes? send mir einen screnn shot vbon jeden',
        'Was können deine Nodes? Sende mir einen Screenshot von jedem.',
        'Sende mir Screenshots von allen Nodes.',
    ])('resolves bounded all-node screenshot replies: %s', text => {
        expect(evaluateClarification('user:node-shot', text)).toMatchObject({ action: 'continue', content: text })
    })

    it('retires the erroneous all-node target question without replaying it', () => {
        const store = getSessionContinuityStore()
        store.setPendingClarification('user:node-shot', {
            id: 'reported-2109', originalRequest: 'was können deine nodes? send mir einen screnn shot vbon jeden',
            question: 'Auf welchem Node, Dienst oder Ziel soll ich das ausführen?',
            missingFields: ['target'], createdAt: Date.now(),
        })
        expect(evaluateClarification('user:node-shot', 'Hallo').content).toBe('Hallo')
        expect(store.getSummary('user:node-shot')?.pendingClarification).toBeFalsy()
    })

    it.each([
        'send mir einen screnn shot vbon jeden',
        'was können deine nodes? send ihm einen screnn shot vbon jeden',
        'was können deine nodes? send mir einen screnn shot vbon jeden und installiere Docker',
        'was können deine nodes? lösche das',
    ])('does not reuse the node mention for unresolved recipients or extra actions: %s', text => {
        expect(evaluateClarification('user:node-negative', text).action).toBe('ask')
    })

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

    // Live 30.09.2026 19:20: a screenshot target question from 29.09. survived the
    // update and turned "Wie geht’s dir ?" into "<screenshot request> [Nutzer-Klärung: …]".
    it('never resumes a clarification older than the TTL (live 30.09. regression)', () => {
        const store = getSessionContinuityStore()
        store.setPendingClarification('user:ttl', {
            id: 'day-old', originalRequest: 'Installiere Docker',
            question: 'Auf welchem Node, Dienst oder Ziel soll ich das ausführen?',
            missingFields: ['target'], createdAt: Date.now() - 26 * 60 * 60_000,
        })
        const text = 'Wie geht’s dir ?'
        expect(evaluateClarification('user:ttl', text)).toMatchObject({ action: 'continue', content: text })
        expect(store.getSummary('user:ttl')?.pendingClarification).toBeFalsy()
    })

    it.each(['Wie geht’s dir ?', "wie geht's", 'Wie geht es dir?', 'Hallo', 'danke', 'Alles gut?'])(
        'small talk does not answer a fresh pending action: %s', text => {
            const store = getSessionContinuityStore()
            store.setPendingClarification('user:talk', {
                id: 'fresh', originalRequest: 'Installiere Docker',
                question: 'Auf welchem Node, Dienst oder Ziel soll ich das ausführen?',
                missingFields: ['target'], createdAt: Date.now(),
            })
            expect(evaluateClarification('user:talk', text)).toMatchObject({ action: 'continue', content: text })
            // Still pending: the actual answer may follow within the TTL.
            expect(store.getSummary('user:talk')?.pendingClarification?.id).toBe('fresh')
        })

    it('still resumes a fresh pending action with a real answer', () => {
        getSessionContinuityStore().setPendingClarification('user:answer', {
            id: 'fresh', originalRequest: 'Installiere Docker',
            question: 'Auf welchem Node, Dienst oder Ziel soll ich das ausführen?',
            missingFields: ['target'], createdAt: Date.now() - 5 * 60_000,
        })
        expect(evaluateClarification('user:answer', 'auf dem Spark').content).toBe('Installiere Docker\n\n[Nutzer-Klärung: auf dem Spark]')
    })

    it('does not treat a screenshot as a target for an additional destructive action', () => {
        expect(evaluateClarification('user:a', 'Mach einen Screenshot deines Systems und lösche das').action).toBe('ask')
    })

    it.each([
        'Mach einen Screenshot deines Arbeitsdesktops und sende ihn mir.',
        'Bitte mach einen Screenshot deines Desktops und schicke ihn mir.',
        'Erstelle ein Bildschirmfoto deines Bildschirms und sende es mir.',
        'Mach einen Screenshot deines Systems und sende mir diesen.',
    ])('resolves local capture and requester delivery without another target: %s', text => {
        expect(evaluateClarification('user:screenshot', text)).toMatchObject({ action: 'continue', content: text })
    })

    it('retires an obsolete own-desktop target question without replaying it', () => {
        const store = getSessionContinuityStore()
        store.setPendingClarification('user:screenshot', {
            id: 'old-desktop', originalRequest: 'Mach einen Screenshot deines Arbeitsdesktops und sende ihn mir.',
            question: 'Auf welchem Node, Dienst oder Ziel soll ich das ausführen?',
            missingFields: ['target'], createdAt: Date.now(),
        })
        const text = 'Wie spät ist es?'
        expect(evaluateClarification('user:screenshot', text).content).toBe(text)
        expect(store.getSummary('user:screenshot')?.pendingClarification).toBeFalsy()
    })

    it.each([
        'Mach einen Screenshot deines Arbeitsdesktops und sende ihn ihm.',
        'Mach einen Screenshot deines Arbeitsdesktops und lösche es.',
        'Mach einen Screenshot deines Arbeitsdesktops und sende ihn mir und installiere Docker.',
    ])('keeps unrelated recipients and extra effects gated: %s', text => {
        expect(evaluateClarification('user:screenshot', text).action).toBe('ask')
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
