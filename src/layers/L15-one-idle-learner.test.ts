/**
 * 2.82.0 Aufräumen Punkt 5: ein Lerner im Leerlauf. L9 ist der Idle-Lerner;
 * L15 startete beim ersten Owner-Satz einen zweiten (eigener 60-s-Timer,
 * eigenes Leerlauf-Maß, eigener Learning-Hub-Start). Das entfällt — L15 meldet
 * nur noch den Zustand von L9.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSelfCheckManager, userMessageReceived } from './L15-self-check.js'
import { getIdleLearningManager } from './L9-idle-learning.js'

afterEach(() => { vi.useRealTimers() })

describe('ein Idle-Lerner (L9)', () => {
    it('der erste Owner-Satz startet in L15 keinen eigenen Lern-Timer', () => {
        vi.useFakeTimers()
        const before = vi.getTimerCount()
        userMessageReceived()
        userMessageReceived()
        expect(vi.getTimerCount()).toBe(before)
    })

    it('L15 meldet den Lernzustand von L9', () => {
        expect(getSelfCheckManager().getStatus().isLearning).toBe(getIdleLearningManager().getStats().isLearning)
    })

    it('L15 enthält kein eigenes Leerlauf-Lernen mehr', () => {
        const source = readFileSync(fileURLToPath(new URL('./L15-self-check.ts', import.meta.url)), 'utf8')
        expect(source).not.toMatch(/startIdleLearning|learnDuringIdle|startLearningSync|idleLearningInterval/)
    })
})
