import { expect, it, vi } from 'vitest'
import { NativeUpdateDriver } from './native-update-driver.js'
import { repairHash, signRepairValue } from './repair-activation.js'
import { UpdateActivationController } from '../core/update-activation.js'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture(rollbackState = false) {
    const ticket = { targetId: 'native-fixture', proposalId: 'upstream-fixture', probeId: 'independent',
        patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64),
        attemptId: 'repair-11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 60_000 }
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
