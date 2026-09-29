import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// nova-boot.ts boots the daemon on import; its wiring is pinned at source
// level, the logic is tested in core/system-security-checks.test.ts.
const source = readFileSync(fileURLToPath(new URL('./nova-boot.ts', import.meta.url)), 'utf8')

describe('nova-boot security baseline wiring (R2 NZ-25, NZ-26)', () => {
    it('only changes the firewall after an explicit operator opt-in', () => {
        const gate = source.indexOf('if (!firewallChangeApproved())')
        const enable = source.indexOf('ufw --force enable')
        expect(gate).toBeGreaterThan(-1)
        expect(enable).toBeGreaterThan(gate)
    })

    it('uses the effective sshd settings and the real UFW status', () => {
        expect(source).toMatch(/effectiveSshdAuth\(texts\)/)
        expect(source).not.toMatch(/config\.includes\('PasswordAuthentication yes'\)/)
        expect(source).toMatch(/ufwOutputIsActive\(/)
    })
})
