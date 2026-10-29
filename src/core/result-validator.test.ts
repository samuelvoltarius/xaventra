import { describe, expect, it } from 'vitest'
import { validateToolOutcome } from './result-validator.js'

describe('result validator', () => {
    it('rejects image announcements without an artifact', () => {
        expect(validateToolOutcome('generate_image', { success: true, message: 'started' }).success).toBe(false)
    })

    it('accepts a generated image path', () => {
        expect(validateToolOutcome('generate_image', { success: true, path: 'C:\\tmp\\salzburg.png' }).success).toBe(true)
    })

    it('rejects screenshot success without a file', () => {
        expect(validateToolOutcome('desktop_screenshot', true, { requiresTool: true, kind: 'screenshot' }).success).toBe(false)
    })
})

describe('node captures (2.90.3)', () => {
    const shot = { kind: 'screenshot', requiresTool: true } as any
    it('accepts a verified node capture with a private path as evidence', () => {
        expect(validateToolOutcome('mesh_screenshot', { success: true, captured: true, delivered: false,
            captures: [{ nodeId: 'xaventra-lab', captured: true, sha256: 'a'.repeat(64), path: '/x/node.png' }] }, shot).success).toBe(true)
        expect(validateToolOutcome('mesh_desktop_input', { success: true, status: 'executed', capture: { path: '/x/node.png', sha256: 'b'.repeat(64) } }, shot).success).toBe(true)
    })
    it('a node capture without image or a refused input is no evidence', () => {
        expect(validateToolOutcome('mesh_screenshot', { success: true, captured: false, captures: [{ nodeId: 'xaventra-lab', captured: false }] }, shot).success).toBe(false)
        expect(validateToolOutcome('mesh_desktop_input', { success: true, status: 'executed' }, shot).success).toBe(false)
        expect(validateToolOutcome('mesh_desktop_input', { success: false, refused: true }, shot).success).toBe(false)
    })
})
