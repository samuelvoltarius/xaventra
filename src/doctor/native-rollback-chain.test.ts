import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/** Real snapshot adapter + snapshot store + rollback state composition. Only the
 * OS boundaries are simulated: systemd observation (with the same failed/MainPID
 * semantics as NativeSystemdService), the helper copy/hash process, the read-only
 * mount observer and the protected unit file. No real systemd is involved. */
const FRAGMENT = '/etc/systemd/system/fixture.service'
const control = vi.hoisted(() => ({ unit: 'old', service: 'clean' as 'clean' | 'running' | 'failed' | 'failed-pid' | 'unclean',
    hash: 'a'.repeat(64), copies: 0, inspects: [] as any[] }))
vi.mock('./repair-controller-files.js', () => ({ protectControllerDirectory: () => {},
    readProtectedControllerFile: (p: string) => p === '/etc/systemd/system/fixture.service' ? control.unit : readFileSync(p, 'utf8') }))
vi.mock('./native-state-mount.js', () => ({ verifyNativeReadOnlyMount: async () => ({ mountId: 7 }) }))
vi.mock('./native-state-helper.js', () => ({ NativeStateHelper: class {
    async hash() { return control.hash }
    async copy() { control.copies++; return { sourceHash: control.hash, copyHash: control.hash, sourceAfterHash: control.hash } }
} }))
vi.mock('./native-systemd-service.js', () => ({ NativeSystemdService: class {
    constructor(private c: any) {}
    async inspect(options: any = {}) {
        control.inspects.push(options)
        if (createHash('sha256').update(control.unit).digest('hex') !== this.c.fragmentHash) throw Error('Systemd unit content changed')
        const s = control.service
        // Same contract as the real service: failed only with the rollback tolerance and MainPID=0.
        if (s === 'failed-pid' || s === 'failed' && options.candidateFailure !== true) throw Error('Systemd service transition or failed state; reconcile before retry')
        return { running: s === 'running', cleanStopped: s === 'clean', stopped: s === 'clean' || s === 'unclean', failed: s === 'failed', pid: s === 'running' ? 42 : 0 }
    }
} }))
import { NativeSnapshotAdapter } from './native-snapshot-adapter.js'
import { NativeRollbackState } from './native-rollback-state.js'
import { UPDATE_ROLLBACK_GRACE_MS } from '../core/update-activation.js'
afterEach(() => { vi.useRealTimers() })
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
function chain(authority: any = { authorized: vi.fn(async () => true), quiescent: vi.fn(async () => true) }) {
    Object.assign(control, { unit: 'old', service: 'clean', copies: 0, inspects: [] })
    const binding: any = { targetId: 'fixture', proposalId: 'upstream-fixture', probeId: 'probe', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64) }
    const ticket: any = { ...binding, attemptId: 'repair-11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 300_000 }
    const config: any = { unit: 'fixture.service', fragmentPath: FRAGMENT,
        snapshot: { root: mkdtempSync(join(tmpdir(), 'chain-original-')), sourceStateId: 'old', candidateStateId: 'next', sourceMount: { path: '/fixture/source' }, destination: '/fixture/next', binding },
        helper: { source: '/fixture/source', destination: '/fixture/next' },
        baseline: { unitHash: hash('old'), process: {} }, candidate: { unitHash: hash('next'), process: {} } }
    const restore = { root: mkdtempSync(join(tmpdir(), 'chain-restore-')), destination: '/fixture/rollback', stateId: 'rollback' }
    return { ticket, authority, adapter: new NativeSnapshotAdapter(config, authority), rollback: new NativeRollbackState(config, restore, authority) }
}
/** Forward: snapshot of the cleanly stopped baseline, then candidate selected. */
async function forward(f: ReturnType<typeof chain>) { await f.adapter.snapshot(f.ticket); control.unit = 'next' }

it('candidate crashed (unit failed, MainPID 0): rollback baseline check and restoration succeed', async () => {
    const f = chain(); await forward(f); control.service = 'failed'
    expect(await f.adapter.baselineUnchanged(f.ticket)).toBe(true)
    const proof = await f.rollback.restore(f.ticket)
    expect(proof).toMatchObject({ sourceStateId: 'old', candidateStateId: 'rollback', copyHash: control.hash, sourceReadOnly: true })
    control.service = 'unclean' // after reset-failed: no process, non-zero exit status remains
    expect(await f.adapter.baselineUnchanged(f.ticket)).toBe(true)
    expect(control.copies).toBe(2)
    expect(control.inspects.some(o => o.candidateFailure === true)).toBe(true)
    // The forward phase never gains the tolerance: no new snapshot from the candidate unit.
    await expect(f.adapter.snapshot(f.ticket)).rejects.toThrow('fence')
})
it('refuses rollback phases when the failed candidate may still own a process (MainPID != 0)', async () => {
    const f = chain(); await forward(f); control.service = 'failed-pid'
    await expect(f.adapter.baselineUnchanged(f.ticket)).rejects.toThrow()
    await expect(f.rollback.restore(f.ticket)).rejects.toThrow()
    expect(control.copies).toBe(1)
})
it('never tolerates an uncleanly stopped BASELINE unit, also in rollback phases', async () => {
    const f = chain(); await forward(f); control.unit = 'old'; control.service = 'unclean'
    await expect(f.adapter.baselineUnchanged(f.ticket)).rejects.toThrow('fence')
    await expect(f.rollback.restore(f.ticket)).rejects.toThrow()
    expect(control.inspects.filter(o => o.candidateFailure === true)).toHaveLength(0)
})
it('ticket expired within the rollback grace: rollback phases still work under the rollback lease, forward refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // Production-like lease: the forward grant ends with the ticket, a separate rollback grant does not.
    const authority = { authorized: vi.fn(async (t: any) => Date.now() < t.expiresAt), rollbackAuthorized: vi.fn(async () => true), quiescent: vi.fn(async () => true) }
    const f = chain(authority); await forward(f); control.service = 'failed'
    vi.setSystemTime(f.ticket.expiresAt + 1_000)
    expect(await f.adapter.baselineUnchanged(f.ticket)).toBe(true)
    expect((await f.rollback.restore(f.ticket)).candidateStateId).toBe('rollback')
    expect(authority.rollbackAuthorized).toHaveBeenCalled()
    control.unit = 'old'; control.service = 'clean'
    await expect(f.adapter.snapshot(f.ticket)).rejects.toThrow('fence')
    control.unit = 'next'; control.service = 'failed'
    vi.setSystemTime(f.ticket.expiresAt + UPDATE_ROLLBACK_GRACE_MS)
    await expect(f.adapter.baselineUnchanged(f.ticket)).rejects.toThrow('fence')
    await expect(f.rollback.restore(f.ticket)).rejects.toThrow()
})
it('without a rollback lease, an expired ticket keeps failing closed at the forward lease', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const authority = { authorized: vi.fn(async (t: any) => Date.now() < t.expiresAt), quiescent: vi.fn(async () => true) }
    const f = chain(authority); await forward(f); control.service = 'failed'
    vi.setSystemTime(f.ticket.expiresAt + 1_000)
    await expect(f.adapter.baselineUnchanged(f.ticket)).rejects.toThrow('fence')
})
