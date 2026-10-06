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
        // R2 A9: the inventory (names, IPs, logins) reaches only the owner's
        // prompt, never the role-agnostic environment block of every prompt.
        expect(pipelineSource).toMatch(/if \(contextPolicy\.mesh && principalContext\.permission === 'owner'\) try \{\s*const \{ loadHosts, formatKnownHostsContext \}/)
        const environment = readFileSync(fileURLToPath(new URL('./environment.ts', import.meta.url)), 'utf8')
        expect(environment).not.toContain('[Passwort gespeichert ✅]')
        expect(environment).not.toContain('loadHosts(')
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
        // 2.88: the only owner grant a message can lead to is a verified one-time link code,
        // re-checked against the owner-account registry (same proof as Telegram pairing).
        const ownerAccounts = readFileSync(fileURLToPath(new URL('../users/owner-accounts.ts', import.meta.url)), 'utf8')
        expect(ownerAccounts.match(/setUserPermission\(/g)).toHaveLength(1)
        expect(ownerAccounts).toMatch(/if \(getOwnerAccountRegistry\(\)\.lookup\(channel, rawUserId\) !== turn\.linkedPrincipal\) return false\s*const \{ setUserPermission \}/)
    })

    it('keeps authorization at the multi-user middleware boundary', () => {
        expect(pipelineSource).toContain('mu.checkAuth(')
        expect(pipelineSource).toContain('if (!authResult.allowed)')
    })
})
