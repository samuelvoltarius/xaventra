import {it,expect,vi,afterEach} from 'vitest'
const call=vi.hoisted(()=>vi.fn(async()=>({status:'completed'})))
vi.mock('../host/capture-agent.js',()=>({requestSessionInput:call}))
import {desktopInputTool} from './desktop-input-tool.js'
import {withExecutionPolicyContext} from '../core/lifecycle-policy.js'
afterEach(()=>{vi.unstubAllEnvs();call.mockClear()})
it('requires authenticated enrolled owner and rejects model principal spoofing',async()=>{
 vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID','123');vi.stubEnv('NOVA_DESKTOP_INPUT_ENABLED','1')
 for(const c of [{channel:'telegram',authUserId:'999',runId:'r'},{channel:'rest',authUserId:'123',runId:'r'},{}]){
 expect(await withExecutionPolicyContext(c,()=>desktopInputTool.handler({authorizationUserId:'123',step:'one',action:'{"action":"key","key":"Tab"}'}))).toMatchObject({success:false})
 }expect(call).not.toHaveBeenCalled()
})
it('binds repeated step to same run identity and validates before transport',async()=>{
 vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID','123');vi.stubEnv('NOVA_DESKTOP_INPUT_ENABLED','1')
 const c={channel:'telegram',authUserId:'123',runId:'r'},p={step:'one',action:'{"action":"key","key":"Tab"}'}
 for(let n=0;n<2;n++)expect(await withExecutionPolicyContext(c,()=>desktopInputTool.handler(p))).toMatchObject({success:true})
 expect(call.mock.calls[0][2]).toBe(call.mock.calls[1][2])
 expect(await withExecutionPolicyContext(c,()=>desktopInputTool.handler({...p,action:'{"action":"exec"}'}))).toMatchObject({success:false})
 expect(call).toHaveBeenCalledTimes(2)
})
