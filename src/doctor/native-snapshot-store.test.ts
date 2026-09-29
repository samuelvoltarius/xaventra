import { it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('./repair-controller-files.js', () => ({ protectControllerDirectory: () => {}, readProtectedControllerFile: (p: string) => readFileSync(p, 'utf8') }))
vi.mock('./native-state-mount.js', () => ({ verifyNativeReadOnlyMount: vi.fn(async () => ({ mountId:'7' })) }))
import { verifyNativeReadOnlyMount } from './native-state-mount.js'
import { NativeSnapshotStore } from './native-snapshot-store.js'
function fixture() {
    vi.mocked(verifyNativeReadOnlyMount).mockReset().mockResolvedValue({ mountId:'7' } as any)
    const root = mkdtempSync(join(tmpdir(),'native-snapshot-')), hash = 'a'.repeat(64)
    const binding: any = {targetId:'fixture', candidateHash:'b'.repeat(64)}
    const config: any = { root, sourceStateId:'old', candidateStateId:'next', sourceMount:{path:'/fixture/source'}, destination:'/fixture/next', binding }
    const ticket: any = {...binding,attemptId:'repair-11111111-1111-4111-8111-111111111111',expiresAt:Date.now()+60000}
    const ops = { fenced:vi.fn(async()=>true), hash:vi.fn(async(_p:string)=>hash),
        copy:vi.fn(async()=>({sourceHash:hash,copyHash:hash,sourceAfterHash:hash})) }
    return {root, hash, config,ticket,ops,store:new NativeSnapshotStore(config,ops)}
}
it('persists a bound proof, rehydrates without another copy and checks rollback baseline independently', async()=>{
    const f=fixture(), proof=await f.store.snapshot(f.ticket)
    expect(await new NativeSnapshotStore(f.config,f.ops).snapshot(f.ticket)).toEqual(proof)
    expect(f.ops.copy).toHaveBeenCalledTimes(1)
    f.ops.hash.mockImplementation(async p=>p===f.config.destination?'b'.repeat(64):f.hash)
    expect(await f.store.baselineUnchanged(f.ticket)).toBe(true)
    await expect(f.store.snapshot(f.ticket)).rejects.toThrow('state changed')
    f.ops.hash.mockResolvedValue('c'.repeat(64))
    expect(await f.store.baselineUnchanged(f.ticket)).toBe(false)
})
it.each(['copy','hash','authority','mount'])('retains %s failure intent without recopy',async mode=>{
    const f=fixture()
    f.ops.copy.mockImplementation(async()=>{
        if(mode==='copy')throw Error('interrupted')
        if(mode==='hash')f.ops.hash.mockResolvedValue('b'.repeat(64))
        if(mode==='authority')f.ops.fenced.mockResolvedValue(false)
        if(mode==='mount')vi.mocked(verifyNativeReadOnlyMount).mockResolvedValue({mountId:'8'} as any)
        return {sourceHash:f.hash,copyHash:f.hash,sourceAfterHash:f.hash}
    })
    await expect(f.store.snapshot(f.ticket)).rejects.toThrow()
    expect(existsSync(join(f.root,'snapshot.lock'))).toBe(true)
    f.ops.fenced.mockResolvedValue(true)
    await expect(new NativeSnapshotStore(f.config,f.ops).snapshot(f.ticket)).rejects.toThrow('reconciliation')
    expect(f.ops.copy).toHaveBeenCalledTimes(1)
})
it('rejects foreign approval and missing authority before copy',async()=>{
    const f=fixture()
    await expect(f.store.snapshot({...f.ticket,targetId:'other'})).rejects.toThrow('binding')
    f.ops.fenced.mockResolvedValue(false)
    await expect(f.store.snapshot(f.ticket)).rejects.toThrow('fence')
    expect(f.ops.copy).not.toHaveBeenCalled()
})
it('rejects a different original hash on completed receipt replay without recopy',async()=>{
    const f=fixture();const proof=await f.store.snapshot(f.ticket,f.hash)
    expect(await f.store.verifiedBaseline(f.ticket)).toEqual(proof)
    await expect(f.store.snapshot(f.ticket,'b'.repeat(64))).rejects.toThrow('original hash')
    expect(f.ops.copy).toHaveBeenCalledTimes(1)
})
