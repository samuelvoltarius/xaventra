import { describe, expect, it } from 'vitest'
import { AutonomousLearner, recallSolution } from './L17-autonomous-learning.js'
import toolLearning from './L7-tool-learning.js'
const { ToolUsageLearner } = toolLearning

describe('legacy learning task and principal isolation', () => {
    it('binds sequential results to their actual requests, not the first session', () => {
        const learner = new AutonomousLearner()
        for (const [request, marker] of [['Read the amber project report', 'AMBER'], ['Read the cobalt project report', 'COBALT']]) {
            learner.recordVerifiedOutcome({toolName:'read_file', request, result:{success:true, content:marker}, success:true, verified:true, userId:'alice'})
        }
        expect(recallSolution('Read the amber project report', 'alice')?.solution).toContain('AMBER')
        expect(recallSolution('Read the amber project report', 'alice')?.solution).not.toContain('COBALT')
        expect(recallSolution('Read the cobalt project report', 'alice')?.solution).toContain('COBALT')
        expect(recallSolution('Read the amber project report', 'bob')).toBeNull()
        expect(recallSolution('Read the amber project report')).toBeNull()
    })

    it('keeps examples and parameter corrections scoped, including after reload', () => {
        const learner = new ToolUsageLearner()
        learner.recordUsage('read_file', 'Read private project', {path:'ALICE_PRIVATE'}, true, 'alice')
        learner.recordUsage('read_file', 'Read old project', {path:'LEGACY_UNSCOPED'}, true)
        const b = learner.recordUsage('read_file', 'Read private project', {path:'wrong'}, false, 'bob')
        learner.recordCorrection(b.id, {path:'BOB_PRIVATE'}, 'user correction', 'bob')
        const reload = new ToolUsageLearner()
        expect(reload.buildLearningPrompt('read_file', 'alice')).toContain('ALICE_PRIVATE')
        expect(reload.buildLearningPrompt('read_file', 'alice')).not.toMatch(/BOB_PRIVATE|LEGACY_UNSCOPED/)
        expect(reload.buildLearningPrompt('read_file', 'bob')).not.toContain('ALICE_PRIVATE')
        expect(reload.suggestCorrections('read_file', 'Read private project', {}, 'alice')).toBeNull()
        expect(reload.suggestCorrections('read_file', 'Read private project', {}, 'bob')).toEqual({path:'BOB_PRIVATE'})
        reload.recordCorrection(b.id, {path:'WRONG_OWNER'}, 'foreign correction', 'alice')
        expect(reload.buildLearningPrompt('read_file', 'bob')).not.toContain('WRONG_OWNER')
    })
})
