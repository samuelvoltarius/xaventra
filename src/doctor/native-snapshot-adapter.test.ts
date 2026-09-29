import { it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
const control=vi.hoisted(()=>({unit:'old',running:false,clean:true,fenced:undefined as any,copies:0,onInspect:undefined as any}))
vi.mock('./repair-controller-files.js',()=>({readProtectedControllerFile:()=>control.unit}))
vi.mock('./native-state-helper.js',()=>({NativeStateHelper:class {async copy(){control.copies++;return {}} async hash(){return ''}}}))
vi.mock('./native-systemd-service.js',()=>({NativeSystemdService:class {async inspect(){control.onInspect?.();return {running:control.running,cleanStopped:control.clean,pid:control.running?42:0}}}}))
vi.mock('./native-snapshot-store.js',()=>({NativeSnapshotStore:class {constructor(_c:any,private ops:any){control.fenced=ops.fenced} async snapshot(t:any){if(!await this.ops.fenced(t,'snapshot'))throw Error('fenced');return this.ops.copy()} async baselineUnchanged(t:any){return this.ops.fenced(t,'baseline')}}}))
import { NativeSnapshotAdapter } from './native-snapshot-adapter.js'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
function fixture(){
    Object.assign(control,{unit:'old',running:false,clean:true,copies:0,onInspect:undefined})
    const config:any={snapshot:{sourceMount:{path:'/old'},destination:'/next'},helper:{source:'/old',destination:'/next'},baseline:{unitHash:hash('old')},candidate:{unitHash:hash('next')}}
    const authority={authorized:vi.fn(async()=>true),quiescent:vi.fn(async()=>true)},ticket:any={expiresAt:Date.now()+60000}
    return {config,authority,ticket,adapter:new NativeSnapshotAdapter(config,authority)}
}
it('copies only clean stopped baseline; permits rollback observation with candidate running',async()=>{
    const f=fixture();await f.adapter.snapshot(f.ticket);expect(control.copies).toBe(1)
    control.unit='next';control.running=true;control.clean=false
    expect(await f.adapter.baselineUnchanged(f.ticket)).toBe(true)
    await expect(f.adapter.snapshot(f.ticket)).rejects.toThrow('fenced')
    expect(control.copies).toBe(1)
})
it.each(['running','unclean','foreign','authority','quiescence','expired'])('rejects %s before copy',async mode=>{
    const f=fixture()
    if(mode==='running')control.running=true
    if(mode==='unclean')control.clean=false
    if(mode==='foreign')control.unit='unknown'
    if(mode==='authority')f.authority.authorized.mockResolvedValue(false)
    if(mode==='quiescence')f.authority.quiescent.mockResolvedValue(false)
    if(mode==='expired')f.ticket.expiresAt=0
    await expect(f.adapter.snapshot(f.ticket)).rejects.toThrow('fenced');expect(control.copies).toBe(0)
})
it('rejects a service restart or lost authority during the external fence query',async()=>{
    const f=fixture();f.authority.quiescent.mockImplementation(async()=>{control.running=true;return true})
    await expect(f.adapter.snapshot(f.ticket)).rejects.toThrow('fenced')
    control.running=false;f.authority.quiescent.mockImplementation(async()=>{f.authority.authorized.mockResolvedValue(false);return true})
    await expect(f.adapter.snapshot(f.ticket)).rejects.toThrow('fenced');expect(control.copies).toBe(0)
})
it('rejects different helper state paths at enrollment',()=>{
    const f=fixture();f.config.helper.destination='/other'
    expect(()=>new NativeSnapshotAdapter(f.config,f.authority)).toThrow('mismatch')
})
it('admits restore only when either enrolled service is clean stopped, never a running candidate',async()=>{
    const f=fixture();control.unit='next';control.running=true;control.clean=false
    expect(await f.adapter.cleanStopped(f.ticket)).toBe(false)
    control.running=false;expect(await f.adapter.cleanStopped(f.ticket)).toBe(false)
    control.clean=true;expect(await f.adapter.cleanStopped(f.ticket)).toBe(true)
    control.unit='old';expect(await f.adapter.cleanStopped(f.ticket)).toBe(true)
})
