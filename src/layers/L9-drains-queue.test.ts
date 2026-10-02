import { describe, expect, it, vi } from 'vitest'

// 2.82.0 cleanup: L9 is the one idle learner. Topics queued from errors and
// tool runs (proactive-learning addTopicFromError/queueLearningRequest) were
// drained only by the removed L15 learner — L9 now takes one per idle round.
const learnDuringIdle = vi.fn(async () => ({ learned: true, topic: 'example.com outage' }))
vi.mock('../intelligence/proactive-learning.js', () => ({ learnDuringIdle, generateIdleLearningPrompt: () => 'x' }))

describe('L9 arbeitet die Lern-Warteschlange ab', () => {
    it('eine Leerlauf-Runde nimmt genau ein Thema aus der Warteschlange', async () => {
        const { getIdleLearningManager } = await import('./L9-idle-learning.js')
        const manager: any = getIdleLearningManager()
        manager.lastActivity = Date.now() - 60 * 60 * 1000
        manager.getTopicsToLearn = () => []
        await manager.checkAndLearn()
        expect(learnDuringIdle).toHaveBeenCalledTimes(1)
    })

    it('nicht im Leerlauf: nichts', async () => {
        learnDuringIdle.mockClear()
        const { getIdleLearningManager } = await import('./L9-idle-learning.js')
        const manager: any = getIdleLearningManager()
        manager.recordActivity()
        await manager.checkAndLearn()
        expect(learnDuringIdle).not.toHaveBeenCalled()
    })
})
