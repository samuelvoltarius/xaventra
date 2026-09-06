import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pipelineSource = readFileSync(
    fileURLToPath(new URL('./message-pipeline.ts', import.meta.url)),
    'utf8',
)

describe('message pipeline authorization boundary', () => {
    it('never creates a mission from a model-response substring', () => {
        expect(pipelineSource).not.toContain('await startMission(goal, canonicalUser, channel)')
        expect(pipelineSource).not.toContain('Auto-intercepted /mission')
    })
    it('contains no message-triggered owner or admin override', () => {
        expect(pipelineSource).not.toMatch(/master[- ]override/i)
        expect(pipelineSource).not.toMatch(/adminHash/)
        expect(pipelineSource).not.toMatch(/setUserPermission\([^)]*['"]owner['"]\)/)
        expect(pipelineSource).not.toMatch(/__adminSessions/)
    })

    it('keeps authorization at the multi-user middleware boundary', () => {
        expect(pipelineSource).toContain('mu.checkAuth(')
        expect(pipelineSource).toContain('if (!authResult.allowed)')
    })
})
