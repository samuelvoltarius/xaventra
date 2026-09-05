import { describe, expect, it } from 'vitest'
import {
    isModelPerformanceRecordingEnabled,
    withModelPerformanceRecording,
} from './model-perf-db.js'

describe('model performance recording scope', () => {
    it('disables recording only inside the isolated async operation', async () => {
        expect(isModelPerformanceRecordingEnabled()).toBe(true)
        await withModelPerformanceRecording(false, async () => {
            await Promise.resolve()
            expect(isModelPerformanceRecordingEnabled()).toBe(false)
        })
        expect(isModelPerformanceRecordingEnabled()).toBe(true)
    })
})
