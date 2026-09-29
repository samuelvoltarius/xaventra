import { afterEach, expect, it, vi } from 'vitest'
import { NativeUpdateDriver } from './native-update-driver.js'
import { repairHash, signRepairValue } from './repair-activation.js'
import { UpdateActivationController, UPDATE_ROLLBACK_GRACE_MS } from '../core/update-activation.js'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => { vi.useRealTimers() })
function fixture(rollbackState = false) {
    const ticket = { targetId: 'native-fixture', proposalId: 'upstream-fixture', probeId: 'independent',
        patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64),
        attemptId: 'repair-11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 300_000 }
    const { attemptId, expiresAt, ...binding } = ticket
    let current = 'old', running = true, restored = false
    const phases: string[] = []
    const releases = {
        old: { id: 'old', sourceHash: ticket.baselineHash, programHash: '1'.repeat(64), stateId: 'old-state', rollbackStateId:rollbackState?'rollback-state':undefined },
        next: { id: 'next', sourceHash: ticket.candidateHash, programHash: '2'.repeat(64), stateId: 'new-state',
            previousReleaseId: 'old', packageHash: ticket.patchHash, binding },
    }
    const ops = {
        hasAuthority: vi.fn(async () => true),
        inspect: vi.fn(async () => ({ releaseId: current, programHash: releases[current].programHash, stateId: current==='old'&&restored?'rollback-state':releases[current].stateId, running, cleanStopped: !running })),
        verifyRelease: vi.fn(async () => true),
        beginMaintenance: vi.fn(async () => {}),
        quiescent: vi.fn(async () => true),
        stop: vi.fn(async () => { phases.push('stop'); running = false }),
        snapshot: vi.fn(async () => { phases.push('snapshot'); return { sourceHash: '3'.repeat(64), copyHash: '3'.repeat(64), sourceAfterHash: '3'.repeat(64), sourceReadOnly: true as const, bindingHash: repairHash(ticket), sourceStateId: 'old-state', candidateStateId: 'new-state' } }),
        baselineUnchanged: vi.fn(async () => true),
        restoreRollback:vi.fn(async()=>({sourceHash:'3'.repeat(64),copyHash:'3'.repeat(64),sourceAfterHash:'3'.repeat(64),sourceReadOnly:true as const,bindingHash:repairHash(ticket),sourceStateId:'old-state',candidateStateId:'rollback-state'})),
        select: vi.fn(async (id: string) => { phases.push(`select:${id}`); current = id; if(id==='old'&&rollbackState)restored=true }),
        start: vi.fn(async () => { phases.push('start'); running = true }),
        saveIntent: vi.fn(),
    }
    const driver = new NativeUpdateDriver({ targetId: ticket.targetId, releases, catalog: { [ticket.candidateHash]: 'next' } }, ops)
    return { ticket, binding, releases, ops, driver, phases }
}
it('switches only after clean stop, bound snapshot and quiescence; restores the original state', async () => {
    const f = fixture(), p = await f.driver.prepare(f.ticket)
    await f.driver.beginMaintenance(f.ticket)
    await f.driver.activate(p, f.ticket)
    expect(await f.driver.currentRelease(f.ticket.targetId)).toBe('next')
    await f.driver.rollback(p, f.ticket)
    expect(await f.driver.currentRelease(f.ticket.targetId)).toBe('old')
    expect(f.phases).toEqual(['stop', 'snapshot', 'select:next', 'start', 'stop', 'select:old', 'start'])
})
it('restores into the enrolled third state and refuses treating it as a new baseline',async()=>{
    const f=fixture(true),p=await f.driver.prepare(f.ticket)
    await f.driver.activate(p,f.ticket);await f.driver.rollback(p,f.ticket)
    expect(f.ops.restoreRollback).toHaveBeenCalledTimes(1)
    expect((await f.ops.inspect()).stateId).toBe('rollback-state')
    expect(await f.driver.currentRelease(f.ticket.targetId)).toBe('old')
    await expect(f.driver.prepare(f.ticket)).rejects.toThrow('source state')
})
it('refuses rollback proof naming the candidate state without selecting or restarting',async()=>{
    const f=fixture(true),p=await f.driver.prepare(f.ticket);await f.driver.activate(p,f.ticket)
    const proof=await f.ops.restoreRollback();f.ops.restoreRollback.mockResolvedValue({...proof,candidateStateId:'new-state'})
    await expect(f.driver.rollback(p,f.ticket)).rejects.toThrow('restore proof')
    expect(f.ops.select).toHaveBeenCalledTimes(1);expect(f.ops.start).toHaveBeenCalledTimes(1)
})
it('rechecks baseline integrity after stop before restoring',async()=>{
    const f=fixture(true),p=await f.driver.prepare(f.ticket);await f.driver.activate(p,f.ticket)
    f.ops.baselineUnchanged.mockResolvedValueOnce(true).mockResolvedValue(false)
    await expect(f.driver.rollback(p,f.ticket)).rejects.toThrow('during stop')
    expect(f.ops.restoreRollback).not.toHaveBeenCalled()
})
it('rejects observed original state after an alleged rollback selection',async()=>{
    const f=fixture(true),p=await f.driver.prepare(f.ticket);await f.driver.activate(p,f.ticket)
    f.ops.select.mockImplementation(async()=>{f.ops.inspect.mockResolvedValue({releaseId:'old',programHash:'1'.repeat(64),stateId:'old-state',running:false,cleanStopped:true})})
    await expect(f.driver.rollback(p,f.ticket)).rejects.toThrow('selected runtime state')
    expect(f.ops.start).toHaveBeenCalledTimes(1)
})
it('rejects shared writable state before stopping', async () => {
    const f = fixture(); f.releases.next.stateId = 'old-state'
    await expect(f.driver.prepare(f.ticket)).rejects.toThrow('state')
    expect(f.ops.stop).not.toHaveBeenCalled()
})
it('does not accept caller supplied prepared release identities', async () => {
    const f = fixture(), p = await f.driver.prepare(f.ticket)
    await expect(f.driver.activate({ ...p, previousReleaseId: 'next' }, f.ticket)).rejects.toThrow()
    expect(f.ops.stop).not.toHaveBeenCalled()
})
it('does not start after authority is lost during stop', async () => {
    const f = fixture(), p = await f.driver.prepare(f.ticket)
    f.ops.stop.mockImplementation(async () => { f.ops.hasAuthority.mockResolvedValue(false) })
    await expect(f.driver.activate(p, f.ticket)).rejects.toThrow()
    expect(f.ops.start).not.toHaveBeenCalled()
})
it('rejects a snapshot from another ticket', async () => {
    const f = fixture(), p = await f.driver.prepare(f.ticket)
    const s = await f.ops.snapshot(); f.ops.snapshot.mockResolvedValue({ ...s, bindingHash: '0'.repeat(64) })
    await expect(f.driver.activate(p, f.ticket)).rejects.toThrow('snapshot')
    expect(f.ops.select).not.toHaveBeenCalled()
})
it('refuses rollback when preserved baseline has changed', async () => {
    const f = fixture(), p = await f.driver.prepare(f.ticket); await f.driver.activate(p, f.ticket)
    f.ops.baselineUnchanged.mockResolvedValue(false)
    await expect(f.driver.rollback(p, f.ticket)).rejects.toThrow('baseline')
    expect(f.ops.select).toHaveBeenCalledTimes(1)
})
it('does not repeat a switch on ambiguous stopped state', async () => {
    const f = fixture(), p = await f.driver.prepare(f.ticket)
    f.ops.inspect.mockResolvedValue({ releaseId: 'old', programHash: '1'.repeat(64), stateId: 'old-state', running: false, cleanStopped: true })
    await expect(f.driver.activate(p, f.ticket)).rejects.toThrow()
    expect(f.ops.stop).not.toHaveBeenCalled()
})
it.each([false, true])('integrates with signed shared controller; rollback=%s', async failCandidate => {
    const f = fixture(), keys = generateKeyPairSync('ed25519')
    const root = mkdtempSync(join(tmpdir(), 'native-controller-contract-'))
    const signed = signRepairValue(f.ticket, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    const complete = vi.fn(async () => {})
    const probe = async (id: string) => { if (failCandidate && id === 'next') throw Error('Independent probe failure'); return id }
    const create = () => new UpdateActivationController(root, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), f.driver, probe, complete)
    const receipt = await create().deploy(signed, {})
    expect(receipt.status).toBe(failCandidate ? 'rolled-back' : 'installed')
    const starts = f.ops.start.mock.calls.length
    expect(await create().deploy(signed, {})).toEqual(receipt)
    expect(f.ops.start).toHaveBeenCalledTimes(starts)
    expect(complete).toHaveBeenCalledTimes(1)
})
it.each(['unclean', 'copy-mismatch', 'unfenced'])('rejects %s before selecting candidate', async failure => {
    const f = fixture(), p = await f.driver.prepare(f.ticket)
    if (failure === 'unclean') f.ops.inspect.mockResolvedValue({ releaseId: 'old', programHash: '1'.repeat(64), stateId: 'old-state', running: true, cleanStopped: false })
    if (failure === 'copy-mismatch') { const s = await f.ops.snapshot(); f.ops.snapshot.mockResolvedValue({ ...s, copyHash: '4'.repeat(64) }) }
    if (failure === 'unfenced') f.ops.quiescent.mockResolvedValue(false)
    await expect(f.driver.activate(p, f.ticket)).rejects.toThrow()
    expect(f.ops.select).not.toHaveBeenCalled()
})
/** Simulated enrolled unit: the candidate may crash (exit 1 -> unit failed, MainPID 0)
 * or fail with a process left over. Strict observation throws on 'failed' like systemd. */
function crashFixture() {
    const f = fixture(), unit = { current: 'old', state: 'running' as 'running' | 'clean' | 'failed' | 'failed-with-pid' | 'unclean' }
    const observe = (options?: any) => {
        if (unit.state === 'failed-with-pid' || unit.state === 'failed' && !(options?.rollback && unit.current === 'next')) throw Error('Systemd service transition or failed state')
        return { releaseId: unit.current, programHash: f.releases[unit.current].programHash, stateId: f.releases[unit.current].stateId,
            running: unit.state === 'running', cleanStopped: unit.state === 'clean', stopped: ['clean', 'unclean'].includes(unit.state), failed: unit.state === 'failed' }
    }
    const stoppedFor = (options?: any) => unit.state === 'clean' || options?.candidateFailure && unit.state === 'unclean'
    f.ops.inspect.mockImplementation(async (options?: any) => observe(options))
    f.ops.stop.mockImplementation(async () => { f.phases.push('stop'); unit.state = 'clean' })
    f.ops.select.mockImplementation(async (id: string, _from: string, _t: any, options?: any) => {
        if (!stoppedFor(options)) throw Error('Native selection requires clean stopped service'); f.phases.push(`select:${id}`); unit.current = id })
    f.ops.start.mockImplementation(async (_id: string, _t: any, options?: any) => {
        if (!stoppedFor(options)) throw Error('Systemd start requires clean stopped state'); f.phases.push('start'); unit.state = 'running' })
    const resetFailed = vi.fn(async (id: string, _t: any, options?: any) => {
        if (!options?.rollback || id !== 'next' || unit.state !== 'failed') throw Error('reset refused'); f.phases.push('reset-failed'); unit.state = 'unclean' })
    Object.assign(f.ops, { resetFailed })
    f.ops.saveIntent.mockImplementation((v: any) => { f.phases.push(`intent:${v.from}->${v.to}`) })
    return { ...f, unit, resetFailed, crash: (state: 'failed' | 'failed-with-pid' = 'failed') => { unit.state = state } }
}
it('rolls back after the candidate exits with code 1: resets the failed unit, selects and starts the baseline', async () => {
    const f = crashFixture(), p = await f.driver.prepare(f.ticket)
    await f.driver.activate(p, f.ticket); f.crash()
    await expect(f.driver.currentRelease(f.ticket.targetId)).rejects.toThrow('failed state')
    await f.driver.rollback(p, f.ticket)
    expect(await f.driver.currentRelease(f.ticket.targetId)).toBe('old')
    expect(f.phases).toEqual(['intent:old->next', 'stop', 'snapshot', 'select:next', 'start',
        'intent:next->old', 'reset-failed', 'select:old', 'start'])
    expect(f.ops.baselineUnchanged).toHaveBeenCalledTimes(2)
    // The forward path never carried a rollback tolerance.
    expect(f.ops.select.mock.calls[0][3]).toBeUndefined(); expect(f.ops.start.mock.calls[0][2]).toBeUndefined()
    expect(f.ops.select.mock.calls[1][3]).toEqual({ rollback: true, candidateFailure: true })
})
it('rolls back through the signed shared controller when the candidate crashes before acceptance', async () => {
    const f = crashFixture(), keys = generateKeyPairSync('ed25519')
    const root = mkdtempSync(join(tmpdir(), 'native-controller-crash-'))
    const signed = signRepairValue(f.ticket, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    const probe = async (id: string) => { if (id === 'next') { f.crash(); throw Error('candidate exited with code 1') } return id }
    const receipt = await new UpdateActivationController(root, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), f.driver, probe, vi.fn(async () => {})).deploy(signed, {})
    expect(receipt.status).toBe('rolled-back')
    expect(f.unit).toEqual({ current: 'old', state: 'running' })
    expect(f.resetFailed).toHaveBeenCalledTimes(1)
})
it('refuses rollback when the failed candidate may still own a process (MainPID != 0)', async () => {
    const f = crashFixture(), p = await f.driver.prepare(f.ticket)
    await f.driver.activate(p, f.ticket); f.crash('failed-with-pid')
    await expect(f.driver.rollback(p, f.ticket)).rejects.toThrow('failed state')
    expect(f.resetFailed).not.toHaveBeenCalled()
    expect(f.ops.select).toHaveBeenCalledTimes(1); expect(f.ops.start).toHaveBeenCalledTimes(1)
})
it('never tolerates an unclean baseline stop in the forward path', async () => {
    const f = crashFixture(), p = await f.driver.prepare(f.ticket)
    f.ops.stop.mockImplementation(async () => { f.phases.push('stop'); f.unit.state = 'unclean' })
    await expect(f.driver.activate(p, f.ticket)).rejects.toThrow('clean stop')
    expect(f.resetFailed).not.toHaveBeenCalled(); expect(f.ops.snapshot).not.toHaveBeenCalled(); expect(f.ops.select).not.toHaveBeenCalled()
})
it('refuses rollback if the failed state is not cleared by the reset', async () => {
    const f = crashFixture(), p = await f.driver.prepare(f.ticket)
    await f.driver.activate(p, f.ticket); f.crash()
    f.resetFailed.mockImplementation(async () => { f.phases.push('reset-failed') })
    await expect(f.driver.rollback(p, f.ticket)).rejects.toThrow('not reconciled')
    expect(f.ops.select).toHaveBeenCalledTimes(1)
})
it('ticket expiry between stop and start does not prevent the rollback', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = fixture(), p = await f.driver.prepare(f.ticket); await f.driver.activate(p, f.ticket)
    const stop = f.ops.stop.getMockImplementation()!
    f.ops.stop.mockImplementation(async (...args: any[]) => { await (stop as any)(...args); vi.setSystemTime(f.ticket.expiresAt + 1_000) })
    expect(await f.driver.hasAuthority(f.ticket)).toBe(true)
    await f.driver.rollback(p, f.ticket)
    expect(f.phases.slice(-3)).toEqual(['stop', 'select:old', 'start'])
    expect(await f.driver.hasAuthority(f.ticket)).toBe(false)
    expect(await f.driver.hasRollbackAuthority(f.ticket)).toBe(true)
    expect(f.ops.hasAuthority).toHaveBeenCalledWith(f.ticket, { rollback: true })
    expect(f.ops.select.mock.calls.at(-1)?.[3]).toEqual({ rollback: true })
})
it('refuses every forward step once the ticket expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = fixture(), p = await f.driver.prepare(f.ticket)
    f.ops.stop.mockImplementation(async () => { f.phases.push('stop'); vi.setSystemTime(f.ticket.expiresAt + 1_000) })
    await expect(f.driver.activate(p, f.ticket)).rejects.toThrow('authority')
    expect(f.ops.snapshot).not.toHaveBeenCalled(); expect(f.ops.select).not.toHaveBeenCalled(); expect(f.ops.start).not.toHaveBeenCalled()
    await expect(f.driver.prepare(f.ticket)).rejects.toThrow('authority')
})
it('refuses the rollback after the bounded grace window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = fixture(), p = await f.driver.prepare(f.ticket); await f.driver.activate(p, f.ticket)
    vi.setSystemTime(f.ticket.expiresAt + UPDATE_ROLLBACK_GRACE_MS)
    await expect(f.driver.rollback(p, f.ticket)).rejects.toThrow('authority')
    expect(f.ops.stop).toHaveBeenCalledTimes(1); expect(f.ops.select).toHaveBeenCalledTimes(1)
})
it('expired ticket during candidate verification: shared controller still rolls back the native driver', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = crashFixture(), keys = generateKeyPairSync('ed25519')
    const root = mkdtempSync(join(tmpdir(), 'native-controller-expiry-'))
    const signed = signRepairValue(f.ticket, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    const probe = async (id: string) => { if (id === 'next') { vi.setSystemTime(f.ticket.expiresAt + 5_000); f.crash(); throw Error('candidate crashed late') } return id }
    const receipt = await new UpdateActivationController(root, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), f.driver, probe, vi.fn(async () => {})).deploy(signed, {})
    expect(receipt.status).toBe('rolled-back')
    expect(f.unit).toEqual({ current: 'old', state: 'running' })
})
