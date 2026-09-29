import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createQuorumWitnessServer, QuorumWitnessStore } from './quorum-witness.js'

const acquire = (store: QuorumWitnessStore, nodeId: string, now: number) =>
    store.acquire({ service: 'nova-main', nodeId, holderHostname: nodeId, ttlMs: 1000, requestId: `r-${nodeId}-${now}` }, now)

describe('quorum witness state file', () => {
    it('refuses to start on a corrupt state file instead of resetting epochs', () => {
        const file = join(mkdtempSync(join(tmpdir(), 'nova-witness-state-')), 'w1.json')
        writeFileSync(file, '{"leases":{"nova-main":{"epoch":41,')
        expect(() => new QuorumWitnessStore('w1', file)).toThrow(/corrupt|unreadable/i)
        expect(() => createQuorumWitnessServer({ witnessId: 'w1', secret: 'witness-secret-at-least-16', stateFile: file })).toThrow()
        // The corrupt file is left untouched for the operator.
        expect(readFileSync(file, 'utf8')).toBe('{"leases":{"nova-main":{"epoch":41,')
    })

    it('refuses structurally invalid state (e.g. missing or non-integer epoch)', () => {
        const file = join(mkdtempSync(join(tmpdir(), 'nova-witness-state-')), 'w1.json')
        writeFileSync(file, JSON.stringify({ leases: { 'nova-main': { holderNodeId: 'a', expiresAt: new Date().toISOString() } } }))
        expect(() => new QuorumWitnessStore('w1', file)).toThrow()
        writeFileSync(file, JSON.stringify([]))
        expect(() => new QuorumWitnessStore('w1', file)).toThrow()
    })

    it('starts empty only when no state file exists and keeps epochs monotonic across restarts', () => {
        const file = join(mkdtempSync(join(tmpdir(), 'nova-witness-state-')), 'w1.json')
        const first = new QuorumWitnessStore('w1', file)
        expect(acquire(first, 'a', 1_000).epoch).toBe(1)
        const restarted = new QuorumWitnessStore('w1', file)
        expect(acquire(restarted, 'b', 10_000).epoch).toBe(2)
    })
})
