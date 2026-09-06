import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pipelineSource = readFileSync(
    fileURLToPath(new URL('./message-pipeline.ts', import.meta.url)),
    'utf8',
)

describe('message pipeline authorization boundary', () => {
    it('does not convert known host inventory into blanket administrative authority', () => {
        expect(pipelineSource).not.toContain('VOLLE Admin-Berechtigung')
        expect(pipelineSource).not.toContain('OHNE zu fragen')
        expect(pipelineSource).toContain('formatKnownHostsContext(loadHosts())')
        const environment = readFileSync(fileURLToPath(new URL('./environment.ts', import.meta.url)), 'utf8')
        expect(environment).not.toContain('[Passwort gespeichert ✅]')
        expect(environment).toContain('formatKnownHostsContext(loadHosts())')
        const corrections = readFileSync(fileURLToPath(new URL('./correction-detector.ts', import.meta.url)), 'utf8')
        expect(corrections).not.toContain('writeFileSync(hostsPath')
        expect(corrections).toContain('saveHosts(db)')
    })
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
