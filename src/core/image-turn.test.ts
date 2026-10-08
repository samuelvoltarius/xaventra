import { describe, expect, it } from 'vitest'
import { activeModelSeesImages } from './image-turn.js'

describe('active model sees pictures (2.89.3)', () => {
    it('probe result wins over the name', () => {
        const probes = [{ model: 'qwen', supportsVision: true }, { model: 'gpt-5-mini', supportsVision: false }] as any
        expect(activeModelSeesImages('qwen', probes)).toBe(true)
        expect(activeModelSeesImages('gpt-5-mini', probes)).toBe(false)
    })
    it('without probe: recognisable vision names only', () => {
        expect(activeModelSeesImages('qwen2.5-vl-72b', [])).toBe(true)
        expect(activeModelSeesImages('claude-sonnet-4', [])).toBe(true)
        expect(activeModelSeesImages('gemma3:27b', [])).toBe(true)
        expect(activeModelSeesImages('llama3.2:latest', [])).toBe(false)
        expect(activeModelSeesImages('qwen', [])).toBe(false)
        expect(activeModelSeesImages('', [])).toBe(false)
    })
})
