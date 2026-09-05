import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FeedbackCollector } from '../learning/feedback.js'
import { LearningCoordinator } from '../learning/learning-coordinator.js'
import { CorrectionLearner } from '../layers/L7-learning.js'
import { selectContextPolicy } from '../core/context-policy.js'
import { MemoryGovernanceCoordinator } from './memory-governance.js'
import { classifyMemoryQuery, decideMemoryTurn, memoryKindBonus, memoryRelevance, parseNaturalMemoryForget } from './memory-quality.js'
import { parseCorrectionMemory } from './correction-memory.js'
import { SessionContinuityStore } from './session-summarizer.js'

const roots: string[] = []

function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'nova-memory-intelligence-'))
    roots.push(root)
    return root
}

afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('memory intelligence', () => {
    it('recognizes overview and continuity questions instead of treating them as unrelated lean chat', () => {
        expect(classifyMemoryQuery('Was weißt du noch über mich?')).toBe('overview')
        expect(classifyMemoryQuery('Mach weiter, wo waren wir?')).toBe('continuity')
        expect(memoryKindBonus('Was weißt du über mich?', 'project')).toBeGreaterThan(2)
        expect(selectContextPolicy('mach weiter').longTermMemory).toBe(true)
        expect(selectContextPolicy('merke dir: Spark ist unser Main').longTermMemory).toBe(true)
    })

    it('normalizes common German and English memory vocabulary', () => {
        expect(memoryRelevance('Welche Modelle laufen?', 'Das lokale Modell läuft auf Spark')).toBeGreaterThan(0)
        expect(memoryRelevance('Mein Projekt', 'Project: Nova Core')).toBeGreaterThan(0)
    })

    it('automatically observes durable natural statements without requiring a slash command', () => {
        expect(decideMemoryTurn('Mein Hund heißt Bello.')).toMatchObject({
            observe: true,
            reason: 'personal-fact',
        })
        expect(decideMemoryTurn('Ziel ist, Nova ohne Slash-Befehle weiterzuführen.')).toMatchObject({
            observe: true,
            recall: true,
            reason: 'goal-or-rule',
        })
        expect(decideMemoryTurn('Wie heißt mein Hund?')).toMatchObject({
            observe: false,
            recall: true,
        })
        expect(decideMemoryTurn('Guten Abend')).toMatchObject({
            observe: false,
        })
        expect(parseNaturalMemoryForget('Vergiss bitte meinen alten Server.')).toBe('meinen alten Server')
        expect(parseNaturalMemoryForget('Vergiss nicht den Server zu prüfen.')).toBeNull()
    })

    it('recalls the user overview without injecting unrelated global operations', () => {
        const governance = new MemoryGovernanceCoordinator(join(tempRoot(), 'governance'))
        governance.propose({
            content: 'Sample bevorzugt lokale Modelle für alltägliche Aufgaben.',
            kind: 'preference',
            scope: 'user:sample',
            source: 'operator',
            evidence: 'explicit_user_instruction',
            confidence: 1,
        })
        governance.propose({
            content: 'Der OTel Collector auf ns2 ist momentan online.',
            kind: 'operational',
            scope: 'global',
            source: 'tool:health_status',
            evidence: 'verified_tool_result',
            confidence: 1,
            verified: true,
        })

        const memories = governance.recall(
            ['user:sample', 'global'],
            'Was weißt du noch über mich?',
            8,
        )
        expect(memories.map(item => item.kind)).toContain('preference')
        expect(memories.map(item => item.kind)).not.toContain('operational')
    })

    it('persists goals and verified outcomes across process-like reloads without crossing users', () => {
        const path = join(tempRoot(), 'session-continuity.json')
        const first = new SessionContinuityStore(path)
        first.addTurn('sample', 'user', 'Ziel ist, Nova schneller und schlauer zu machen.', { channel: 'telegram' })
        first.addTurn('sample', 'user', 'Wichtig: Ändere niemals production.env.', { channel: 'telegram' })

        const reloaded = new SessionContinuityStore(path)
        expect(reloaded.getSessionPrompt('sample', 'Wo waren wir?')).toContain('Nova schneller und schlauer')
        expect(reloaded.getSessionPrompt('sample', 'Wo waren wir?')).toContain('production.env')
        expect(reloaded.getSessionPrompt('other-user', 'Wo waren wir?')).toBe('')

        reloaded.recordVerifiedOutcome(
            'sample',
            'Nova schneller und schlauer machen',
            [
                { toolName: 'write_file', result: { path: 'sandbox/result.txt' } },
                { toolName: 'run_tests', result: '2 tests passed' },
            ],
        )
        const afterOutcome = new SessionContinuityStore(path)
        expect(afterOutcome.getSessionPrompt('sample', 'Was war zuletzt?')).toContain('verifiziert mit write_file, run_tests')
        expect(afterOutcome.getSessionPrompt('sample', 'Was war zuletzt?')).toContain('2 tests passed')
        expect(afterOutcome.getSummary('sample')?.openGoals).toHaveLength(0)
    })

    it('forgets matching continuity data using natural user-owned topics', () => {
        const path = join(tempRoot(), 'session-continuity.json')
        const store = new SessionContinuityStore(path)
        store.addTurn('sample', 'user', 'Ziel ist, den alten Server Atlas zu ersetzen.', { channel: 'telegram' })
        store.addTurn('sample', 'user', 'Wichtig: Spark niemals automatisch löschen.', { channel: 'telegram' })

        expect(store.forget('sample', 'Server Atlas')).toBeGreaterThan(0)
        expect(store.getSessionPrompt('sample', 'Wo waren wir?')).not.toContain('Atlas')
        expect(store.getSessionPrompt('sample', 'Was ist wichtig?')).toContain('automatisch löschen')
    })

    it('keeps learned correction responses and correction rules principal-scoped', () => {
        const feedback = new FeedbackCollector()
        feedback.collectFeedback({
            type: 'correction',
            userMessage: 'Korrektur: Spark ist Main',
            botResponse: 'Pi ist Main',
            correction: 'Spark ist Main',
            userId: 'sample',
        })
        expect(feedback.getLearnedResponse('Korrektur: Spark ist Main', 'sample')).toBe('Spark ist Main')
        expect(feedback.getLearnedResponse('Korrektur: Spark ist Main', 'sample-two')).toBeUndefined()

        const learner = new CorrectionLearner(tempRoot())
        learner.recordCorrection({
            userId: 'sample',
            originalResponse: 'Pi ist Main',
            correctedResponse: 'Spark ist Main',
            context: 'Welcher Node ist Main',
        })
        expect(learner.findSimilarCorrections('Welcher Node ist Main', 3, 'sample')).toHaveLength(1)
        expect(learner.findSimilarCorrections('Welcher Node ist Main', 3, 'sample-two')).toHaveLength(0)
    })

    it('parses concrete corrections but rejects content-free disagreement', () => {
        expect(parseCorrectionMemory('Nicht Pi, sondern Spark ist Main.')).toEqual({
            content: 'Korrektur des Benutzers: Spark ist Main.',
            replacesContent: 'Pi',
        })
        expect(parseCorrectionMemory('Das ist falsch.')).toBeNull()
    })

    it('keeps verified procedure confidence across coordinator restarts', async () => {
        const dataDir = tempRoot()
        const fakeEngine = {
            start: async () => undefined,
            stop: async () => undefined,
            processUserMessage: () => null,
            recordBotResponse: () => undefined,
            getStats: () => ({ feedback: { total: 0 }, patterns: { total: 0 }, skills: { total: 0 } }),
        } as any
        const first = new LearningCoordinator(fakeEngine, dataDir)
        await first.recordVerifiedToolOutcome({
            toolName: 'memory_test_probe',
            request: 'verify memory procedure',
            params: { target: 'fixture' },
            result: { ok: true },
            success: true,
            verified: true,
        })
        expect(first.getStats().verifiedProcedures).toBe(1)
        expect(first.getStats().reusableProcedures).toBe(0)

        const reloaded = new LearningCoordinator(fakeEngine, dataDir)
        expect(reloaded.getStats().verifiedProcedures).toBe(1)
        await reloaded.recordVerifiedToolOutcome({
            toolName: 'memory_test_probe',
            request: 'verify memory procedure again',
            params: { target: 'fixture' },
            result: { ok: true },
            success: true,
            verified: true,
        })
        expect(reloaded.getStats().reusableProcedures).toBe(1)
    })

    it('supersedes a replaced governed fact using explicit correction evidence', () => {
        const governance = new MemoryGovernanceCoordinator(join(tempRoot(), 'governance'))
        const old = governance.propose({
            content: 'Pi ist der aktuelle Main Node im Nova Mesh.',
            kind: 'context',
            scope: 'user:sample',
            source: 'user',
            evidence: 'user_statement',
            confidence: 0.9,
        })!
        const corrected = governance.propose({
            content: 'Korrektur des Benutzers: Spark ist der aktuelle Main Node.',
            kind: 'context',
            scope: 'user:sample',
            source: 'user-correction',
            evidence: 'correction',
            confidence: 1,
            replacesContent: 'Pi ist der aktuelle Main Node',
        })!
        expect(governance.get(old.id)?.status).toBe('superseded')
        expect(corrected.status).toBe('canonical')
    })
})
