import { describe, expect, it } from 'vitest'
import { IntentDispatcher } from './intent-dispatcher.js'
import { FocusedWorker } from './focused-worker.js'

describe('dispatcher/worker boundary', () => {
    it('creates an immutable focused execution contract', () => {
        const plan = new IntentDispatcher().dispatch('erstelle ein bild von salzburg')
        expect(plan.intent.kind).toBe('image-generation')
        expect(plan.allowedTools).toContain('generate_image')
        expect(plan.allowedTools.length).toBeLessThanOrEqual(24)
        const worker = new FocusedWorker(plan)
        expect(worker.getTools().every(tool => plan.allowedTools.includes(tool.name))).toBe(true)
    })
})
