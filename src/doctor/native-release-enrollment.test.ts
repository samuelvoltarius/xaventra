import { it,expect,vi } from 'vitest'
import { join,resolve } from 'node:path'
const state=vi.hoisted(()=>({files:{} as Record<string,string>,verify:vi.fn(()=>({installedTreeVerified:true}))}))
vi.mock('./repair-controller-files.js',()=>({readProtectedControllerFile:(p:string)=>state.files[p]}))
vi.mock('./native-program-verifier.js',()=>({verifyNativeInstalledRelease:state.verify}))
import { NativeReleaseEnrollment } from './native-release-enrollment.js'
function fixture(){
    state.verify.mockClear()
    const binding:any={targetId:'fixture',baselineHash:'a'.repeat(64),candidateHash:'b'.repeat(64)},ticket:any={...binding,attemptId:'repair-fixture',expiresAt:Date.now()+60000}
    const root=resolve('fixture-program'),c={root,sourceHash:binding.baselineHash,treeHash:'c'.repeat(64),descriptorHash:'d'.repeat(64),manifestPath:'manifest',descriptorRecordPath:'descriptor',publisherKeyPath:'key',publisherKeyId:'publisher'}
    state.files={enrollment:JSON.stringify({schema:1,binding,releases:{old:c,next:{...c,sourceHash:binding.candidateHash}}}),manifest:'{}',descriptor:JSON.stringify({base64:Buffer.from('fixture').toString('base64')}),key:'fixture-public-key'}
    const release:any={id:'old',sourceHash:binding.baselineHash,programHash:c.treeHash,process:{executable:'/node',argv:['/node',join(root,'dist','daemon.js')]}}
    return {ticket,release,registry:new NativeReleaseEnrollment('enrollment')}
}
it('rereads evidence and invokes byte verifier each time instead of caching success',async()=>{
    const f=fixture();expect(await f.registry.verify('old',f.release,f.ticket)).toBe(true);expect(await f.registry.verify('old',f.release,f.ticket)).toBe(true)
    expect(state.verify).toHaveBeenCalledTimes(2)
})
it.each(['ticket','program','script','config','encoding'])('rejects mismatched %s before byte verification',async mode=>{
    const f=fixture()
    if(mode==='ticket')f.ticket.targetId='foreign'
    if(mode==='program')f.release.programHash='e'.repeat(64)
    if(mode==='script')f.release.process.argv[1]='/other.js'
    if(mode==='config')state.files.enrollment+=' '
    if(mode==='encoding')state.files.descriptor='{"base64":"!!!!"}'
    await expect(f.registry.verify('old',f.release,f.ticket)).rejects.toThrow();expect(state.verify).not.toHaveBeenCalled()
})
