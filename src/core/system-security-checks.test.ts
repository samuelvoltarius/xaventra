import { describe, expect, it } from 'vitest'
import { effectiveSshdAuth, firewallChangeApproved, ufwOutputIsActive } from './system-security-checks.js'

// R2 core-n-z #25/#26: the boot security check must not report "key-only"
// for a default sshd, must not treat an inactive UFW as a firewall, and must
// not change the firewall without an explicit operator opt-in.

describe('boot security baseline (R2 NZ-25, NZ-26)', () => {
    it('treats a default sshd_config (commented keywords) as password auth enabled', () => {
        const ubuntuDefault = '#PermitRootLogin prohibit-password\n#PasswordAuthentication yes\n'
        expect(effectiveSshdAuth([ubuntuDefault]).passwordAuthentication).toBe(true)
        expect(effectiveSshdAuth(['#PasswordAuthentication no\n']).passwordAuthentication).toBe(true)
    })

    it('honours explicit settings, first value wins, drop-ins first', () => {
        expect(effectiveSshdAuth(['PasswordAuthentication no\n']).passwordAuthentication).toBe(false)
        expect(effectiveSshdAuth(['PasswordAuthentication yes\n', 'PasswordAuthentication no\n']).passwordAuthentication).toBe(true)
        expect(effectiveSshdAuth(['PasswordAuthentication no\nMatch User x\n  PasswordAuthentication yes\n']).passwordAuthentication).toBe(false)
        expect(effectiveSshdAuth(['PermitRootLogin yes\n']).permitRootLogin).toBe('yes')
    })

    it('recognises an inactive UFW', () => {
        expect(ufwOutputIsActive('Status: inactive\n')).toBe(false)
        expect(ufwOutputIsActive('Status: active\n\nTo Action From\n')).toBe(true)
    })

    it('requires an explicit opt-in for firewall changes', () => {
        expect(firewallChangeApproved({})).toBe(false)
        expect(firewallChangeApproved({ NOVA_GENESIS_FIREWALL: '1' })).toBe(false)
        expect(firewallChangeApproved({ NOVA_GENESIS_FIREWALL: 'apply' })).toBe(true)
    })
})
