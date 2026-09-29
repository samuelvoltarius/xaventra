import { beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const state = vi.hoisted(() => ({ unit:'old',running:false,starts:0,stops:0,copies:0,selections:0 }))
vi.mock('./repair-controller-files.js',()=>({protectControllerDirectory:()=>{},readProtectedControllerFile:(path:string)=>path.endsWith('.service')?state.unit:readFileSync(path,'utf8')}))
vi.mock('./native-systemd-service.js',()=>({NativeSystemdService:class {
    async inspect(){return {running:state.running,cleanStopped:!state.running,pid:state.running?42:0}}
    async stop(check:any){if(!await check())throw Error('fenced');state.stops++;state.running=false}
    async start(check:any){if(!await check())throw Error('fenced');state.starts++;state.running=true}
}}))
vi.mock('./native-release-selection.js',()=>({NativeReleaseSelection:class {async select(next:string){state.selections++;state.unit=next}}}))
vi.mock('./native-snapshot-adapter.js',()=>({NativeSnapshotAdapter:class {async snapshot(){state.copies++;return {}} async baselineUnchanged(){return true}}}))
vi.mock('./native-rollback-state.js',()=>({NativeRollbackState:class {async restore(){return {candidateStateId:'rollback-state'}}}}))
import { EnrolledNativeUpdateOperations } from './native-update-operations.js'
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
beforeEach(()=>Object.assign(state,{unit:'old',running:false,starts:0,stops:0,copies:0,selections:0}))
function fixture(){
    const binding={targetId:'fixture',proposalId:'upstream-fixture',probeId:'probe',patchHash:'a'.repeat(64),baselineHash:'b'.repeat(64),candidateHash:'c'.repeat(64)}
    const ticket={...binding,attemptId:'repair-11111111-1111-4111-8111-111111111111',expiresAt:Date.now()+60000}
    const process={executable:'/bin/example',argv:[],cwd:'/',cgroup:'fixture',executableHash:'d'.repeat(64)}
    const releases={old:{id:'old',sourceHash:binding.baselineHash,programHash:'1'.repeat(64),stateId:'old-state',unitHash:hash('old'),unitFile:'/old',process},
        next:{id:'next',sourceHash:binding.candidateHash,programHash:'2'.repeat(64),stateId:'next-state',previousReleaseId:'old',packageHash:binding.patchHash,binding,unitHash:hash('next'),unitFile:'/next',process}}
    const config:any={root:mkdtempSync(join(tmpdir(),'native-ops-')),targetId:'fixture',baseline:'old',candidate:'next',releases,
        snapshot:{unit:'fixture.service',fragmentPath:'/etc/systemd/system/fixture.service',baseline:{unitHash:hash('old'),process},candidate:{unitHash:hash('next'),process},snapshot:{sourceStateId:'old-state',candidateStateId:'next-state',binding}}}
    const authority={authorized:vi.fn(async()=>true),quiescent:vi.fn(async()=>true),beginMaintenance:vi.fn(async()=>{}),verifyRelease:vi.fn(async()=>true),runtimeReady:vi.fn(async()=>true)}
    return {config,authority,ticket,ops:new EnrolledNativeUpdateOperations(config,authority)}
}
it('resolves enrolled unit identity and composes snapshot, selection, start and stop',async()=>{
    const f=fixture();expect((await f.ops.inspect()).releaseId).toBe('old')
    await f.ops.beginMaintenance(f.ticket);await f.ops.snapshot('old','next',f.ticket)
    await f.ops.select('next','old',f.ticket);await f.ops.start('next',f.ticket)
    expect((await f.ops.inspect()).releaseId).toBe('next');await f.ops.stop('next',f.ticket)
    expect([state.copies,state.selections,state.starts,state.stops]).toEqual([1,1,1,1])
})
it.each(['authority','quiescence','publisher','runtime'])('refuses start without %s proof',async gate=>{
    const f=fixture()
    if(gate==='authority')f.authority.authorized.mockResolvedValue(false)
    if(gate==='quiescence')f.authority.quiescent.mockResolvedValue(false)
    if(gate==='publisher')f.authority.verifyRelease.mockResolvedValue(false)
    if(gate==='runtime')f.authority.runtimeReady.mockResolvedValue(false)
    await expect(f.ops.start('old',f.ticket)).rejects.toThrow();expect(state.starts).toBe(0)
})
it('rechecks authority after slow writable-state verification',async()=>{
    const f=fixture();f.authority.runtimeReady.mockImplementation(async()=>{f.authority.authorized.mockResolvedValue(false);return true})
    await expect(f.ops.start('old',f.ticket)).rejects.toThrow();expect(state.starts).toBe(0)
})
it('rejects foreign tickets, snapshot directions, units and inconsistent enrollment',async()=>{
    const f=fixture();expect(await f.ops.hasAuthority({...f.ticket,probeId:'foreign'})).toBe(false)
    await expect(f.ops.snapshot('next','old',f.ticket)).rejects.toThrow('direction')
    state.unit='foreign';await expect(f.ops.inspect()).rejects.toThrow('Unenrolled')
    f.config.releases.old.stateId='foreign';expect(()=>new EnrolledNativeUpdateOperations(f.config,f.authority)).toThrow('enrollment')
})
it('clones enrollment and preserves real durable intent across reconstruction without conflicting overwrite',()=>{
    const f=fixture(), intent={attemptId:f.ticket.attemptId,ticketHash:hash('ticket'),from:'old',to:'next',rollback:false}
    f.ops.saveIntent(intent)
    const path=join(f.config.root,`${f.ticket.attemptId}.activate.intent.json`),original=readFileSync(path,'utf8')
    const restored=new EnrolledNativeUpdateOperations(f.config,f.authority);restored.saveIntent(intent)
    expect(()=>restored.saveIntent({...intent,ticketHash:hash('different')})).toThrow('conflict')
    expect(readFileSync(path,'utf8')).toBe(original)
    f.config.candidate='foreign';f.ops.saveIntent(intent)
    expect(()=>f.ops.saveIntent({...intent,attemptId:'../../outside'})).toThrow('Invalid')
})
it('maps a protected rollback unit to original release plus third state, passing exact state to readiness',async()=>{
    const f=fixture();f.config.releases.old.rollbackStateId='rollback-state'
    f.config.rollback={root:'/rollback-journal',destination:'/rollback',stateId:'rollback-state',unitFile:'/rollback-unit',unitHash:hash('__rollback'),process:f.config.releases.old.process}
    const ops=new EnrolledNativeUpdateOperations(f.config,f.authority)
    state.unit='next';await ops.select('old','next',f.ticket);await ops.start('old',f.ticket)
    expect(await ops.inspect()).toMatchObject({releaseId:'old',stateId:'rollback-state',running:true})
    expect(f.authority.runtimeReady).toHaveBeenCalledWith('old',f.ticket,'rollback-state')
    f.config.rollback.process={...f.config.rollback.process,executable:'/other'}
    expect(()=>new EnrolledNativeUpdateOperations(f.config,f.authority)).toThrow('program enrollment')
})
