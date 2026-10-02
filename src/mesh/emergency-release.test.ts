import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EmergencyReleaseGate, issueEmergencyCode } from './emergency-release.js'

describe('owner emergency release code', () => {
    it('is single use, bound to one node and a short time window, stored only as a hash', () => {
        const dir = mkdtempSync(join(tmpdir(), 'xaventra-emergency-'))
        const file = join(dir, 'gate.json')
        let now = 1_000_000
        const gate = new EmergencyReleaseGate({ file, now: () => now })
        const issued = issueEmergencyCode({ nodeId: 'ns2', now: now, ttlMs: 10 * 60_000 })
        gate.register(issued.record)
        expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
        const disk = readFileSync(file, 'utf8')
        expect(disk).not.toContain(issued.code)
        expect(disk).not.toContain(issued.code.replace(/-/g, ''))
        expect(JSON.stringify(issued.record)).not.toContain(issued.code)

        expect(gate.verify({ code: issued.code, nodeId: 'lab' }).ok).toBe(false)
        expect(gate.verify({ code: 'AAAA-BBBB-CCCC', nodeId: 'ns2' }).ok).toBe(false)
        const ok = gate.verify({ code: issued.code.toLowerCase(), nodeId: 'ns2' })
        expect(ok.ok).toBe(true)
        expect(ok.grant?.nodeId).toBe('ns2')
        expect(gate.verify({ code: issued.code, nodeId: 'ns2' }).reason).toMatch(/used/)

        const late = issueEmergencyCode({ nodeId: 'ns2', now, ttlMs: 60_000 })
        gate.register(late.record)
        now += 61_000
        expect(gate.verify({ code: late.code, nodeId: 'ns2' }).reason).toMatch(/expired/)
    })

    it('locks a code after repeated wrong attempts', () => {
        const now = 5_000
        const gate = new EmergencyReleaseGate({ now: () => now })
        const issued = issueEmergencyCode({ nodeId: 'ns2', now, ttlMs: 60_000 })
        gate.register(issued.record)
        for (let i = 0; i < 5; i++) expect(gate.verify({ code: 'ZZZZ-ZZZZ-ZZZZ', nodeId: 'ns2' }).ok).toBe(false)
        expect(gate.verify({ code: issued.code, nodeId: 'ns2' }).reason).toMatch(/locked/)
    })

    it('caps the validity window at 30 minutes', () => {
        expect(() => issueEmergencyCode({ nodeId: 'ns2', now: 0, ttlMs: 2 * 60 * 60_000 })).toThrow(/30/)
    })
})
