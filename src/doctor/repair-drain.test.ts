import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { RepairDrain } from './repair-drain.js'
const ticket = () => ({ proposalId: 'p', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64), probeId: 'original', targetId: 'fixture', attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 60_000 })
const root = () => join(process.cwd(), '.nova-data', randomUUID())
describe('Durable repair tool-admission boundary', () => {
    it('closes new admission atomically, waits for real completion and never certifies external writers', () => {
        const drain = new RepairDrain(root(), ['a', 'b']), t = ticket()
        try {
            const a = drain.admit('a', randomUUID(), 'read_file', true)
            drain.begin(t)
            expect(() => drain.admit('b', randomUUID(), 'read_file', true)).toThrow('paused')
            expect(drain.status(t).toolActionsDrained).toBe(false)
            drain.settle('a', a.id, a.token, a.epoch, true)
            expect(drain.status(t)).toMatchObject({ toolActionsDrained: true, externalWritersQuiesced: false })
            drain.release(t)
            expect(() => drain.begin(t)).toThrow('cannot replay')
            expect(() => drain.admit('a', a.id, 'read_file', true)).toThrow('already used')
        } finally { drain.close() }
    })
    it('persists active work and maintenance across clean coordinator restart', () => {
        const p = root(), t = ticket(), first = new RepairDrain(p, ['a'])
        const a = first.admit('a', randomUUID(), 'read_file', true); first.begin(t); first.close()
        const next = new RepairDrain(p, ['a'])
        try {
            expect(next.status(t)).toMatchObject({ pending: 1, toolActionsDrained: false })
            next.settle('a', a.id, a.token, a.epoch, true)
            expect(next.status(t).toolActionsDrained).toBe(true)
        } finally { next.close() }
    })
    it('never mistakes detached or unclassified actions for quiescence, including after restart', () => {
        const p = root(), t = ticket(), first = new RepairDrain(p, ['a'])
        const a = first.admit('a', randomUUID(), 'run_command')
        first.settle('a', a.id, a.token, a.epoch, true); first.begin(t); first.close()
        const next = new RepairDrain(p, ['a'])
        try { expect(next.status(t)).toMatchObject({ pending: 1, uncertain: 1, toolActionsDrained: false }); expect(() => next.release(t)).toThrow() } finally { next.close() }
    })
    it('refuses a second writer, changed members, stale completion and foreign owners', () => {
        const p = root(), drain = new RepairDrain(p, ['a']), t = ticket()
        try {
            expect(() => new RepairDrain(p, ['a'])).toThrow()
            const a = drain.admit('a', randomUUID(), 'read_file', true)
            expect(() => drain.settle('b', a.id, a.token, a.epoch, true)).toThrow('foreign')
            expect(() => drain.settle('a', a.id, a.token, a.epoch + 1, true)).toThrow('foreign')
            drain.begin(t); expect(() => drain.begin(ticket())).toThrow('Another repair')
        } finally { drain.close() }
        expect(() => new RepairDrain(p, ['a', 'b'])).toThrow('changed membership')
    })
    it('does not reopen expired maintenance automatically', () => {
        const drain = new RepairDrain(root(), ['a']), t = ticket()
        try { drain.begin(t); expect(drain.status({ ...t, expiresAt: Date.now() - 1 }).toolActionsDrained).toBe(false); expect(() => drain.admit('a', randomUUID(), 'read_file')).toThrow('paused') } finally { drain.close() }
    })
})
