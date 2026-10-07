import { describe, expect, it } from 'vitest'
import { probeInternetSync } from './environment.js'

// 2.87.1 (live 07.10.2026): ping is blocked under NoNewPrivileges; the prompt then
// claimed "Internet nicht erreichbar" although HTTPS worked.

describe('internet probe does not depend on ping alone', () => {
    it('ping blocked, TCP 443 works → reachable', () => {
        const seen: string[] = []
        expect(probeInternetSync('linux', cmd => { seen.push(cmd); if (cmd.startsWith('ping')) throw new Error('Operation not permitted') })).toBe(true)
        expect(seen).toHaveLength(2)
        expect(seen[1]).toContain('connect(443')
    })
    it('both fail → not reachable (Gegenprobe)', () => {
        expect(probeInternetSync('linux', () => { throw new Error('offline') })).toBe(false)
    })
    it('ping works → no second probe', () => {
        const seen: string[] = []
        expect(probeInternetSync('linux', cmd => { seen.push(cmd) })).toBe(true)
        expect(seen).toHaveLength(1)
    })
})
