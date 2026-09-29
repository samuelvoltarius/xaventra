import { it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const control = vi.hoisted(()=>({ stopped:true,original:null as any,hash:'a'.repeat(64),copies:0,onCopy:undefined as any }))
vi.mock('./repair-controller-files.js',()=>({protectControllerDirectory:()=>{},readProtectedControllerFile:(p:string)=>readFileSync(p,'utf8')}))
vi.mock('./native-state-mount.js',()=>({verifyNativeReadOnlyMount:async()=>({mountId:7})}))
vi.mock('./native-snapshot-adapter.js',()=>({NativeSnapshotAdapter:class {
    async cleanStopped(){return control.stopped}
    async verifiedBaseline(){return control.original}
}}))
vi.mock('./native-state-helper.js',()=>({NativeStateHelper:class {
    async hash(){return control.hash}
    async copy(){control.copies++;control.onCopy?.();return {sourceHash:control.hash,copyHash:control.hash,sourceAfterHash:control.hash}}
}}))
import { NativeRollbackState } from './native-rollback-state.js'
import { repairHash } from './repair-activation.js'
function fixture(){
    Object.assign(control,{stopped:true,copies:0,hash:'a'.repeat(64),onCopy:undefined})
    const binding:any={targetId:'fixture'},ticket:any={...binding,attemptId:'repair-11111111-1111-4111-8111-111111111111',expiresAt:Date.now()+60000}
    control.original={bindingHash:repairHash(ticket),sourceStateId:'old',candidateStateId:'next',sourceHash:control.hash,copyHash:control.hash,sourceAfterHash:control.hash,sourceReadOnly:true}
    const config:any={snapshot:{root:mkdtempSync(join(tmpdir(),'original-')),sourceStateId:'old',candidateStateId:'next',sourceMount:{path:'/fixture/source'},destination:'/fixture/next',binding},helper:{source:'/fixture/source',destination:'/fixture/next'}}
    const restore={root:mkdtempSync(join(tmpdir(),'restore-')),destination:'/fixture/rollback',stateId:'rollback'},authority={authorized:async()=>true,quiescent:async()=>true}
    return {config,restore,authority,ticket,adapter:new NativeRollbackState(config,restore,authority)}
}
it('restores the original hash to a distinct state and rehydrates without recopy',async()=>{
    const f=fixture(),proof=await f.adapter.restore(f.ticket)
    expect(proof.candidateStateId).toBe('rollback');expect(proof.copyHash).toBe(control.original.sourceHash)
    expect(await new NativeRollbackState(f.config,f.restore,f.authority).restore(f.ticket)).toEqual(proof)
    expect(control.copies).toBe(1)
})
it.each(['running','missing-original','foreign-ticket'])('rejects %s before copying',async mode=>{
    const f=fixture()
    if(mode==='running')control.stopped=false
    if(mode==='missing-original')control.original=null
    if(mode==='foreign-ticket')f.ticket.probeId='foreign'
    await expect(f.adapter.restore(f.ticket)).rejects.toThrow();expect(control.copies).toBe(0)
})
it.each(['hash','fence'])('retains ambiguous %s copy intent and never recopies',async mode=>{
    const f=fixture();control.onCopy=()=>{if(mode==='hash')control.hash='b'.repeat(64);else control.stopped=false}
    await expect(f.adapter.restore(f.ticket)).rejects.toThrow()
    expect(existsSync(join(f.restore.root,'snapshot.lock'))).toBe(true)
    control.stopped=true;control.onCopy=undefined
    await expect(f.adapter.restore(f.ticket)).rejects.toThrow('reconciliation');expect(control.copies).toBe(1)
})
it('rejects changed restored state on replay instead of overwriting it',async()=>{
    const f=fixture();await f.adapter.restore(f.ticket);control.hash='b'.repeat(64)
    await expect(f.adapter.restore(f.ticket)).rejects.toThrow('state changed');expect(control.copies).toBe(1)
})
it.each(['id','path','nested','journal'])('rejects non-independent %s enrollment', mode=>{
    const f=fixture()
    if(mode==='id')f.restore.stateId='next'
    if(mode==='path')f.restore.destination='/fixture/next'
    if(mode==='nested')f.restore.destination='/fixture/next/rollback'
    if(mode==='journal')f.restore.root=f.config.snapshot.root
    expect(()=>new NativeRollbackState(f.config,f.restore,f.authority)).toThrow()
})
