import {it,expect,vi,afterEach} from 'vitest'
import {checkTool,evaluatePolicy,loadPolicy} from './tool-policy.js'
afterEach(()=>{vi.unstubAllEnvs();loadPolicy({toolPolicy:{rules:[]}})})
it('scopes opt-in to exact owner, channel and two tools',()=>{
 vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID','123');vi.stubEnv('NOVA_CAPTURE_SOCKET','/local');vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE','/token');vi.stubEnv('NOVA_DESKTOP_INPUT_ENABLED','1')
 for(const name of ['desktop_screenshot','desktop_input']){
 expect(checkTool(name,{channel:'telegram',userId:'internal-principal',authUserId:'123'}).allowed).toBe(true)
 expect(checkTool(name,{channel:'telegram',userId:'999'}).allowed).toBe(false)
 expect(checkTool(name,{channel:'discord',userId:'123'}).allowed).toBe(false)
 }
 expect(checkTool('desktop_other',{channel:'telegram',userId:'123'}).allowed).toBe(false)
 loadPolicy({toolPolicy:{rules:[{tool:'desktop_*',action:'deny'}]}})
 expect(checkTool('desktop_screenshot',{channel:'telegram',userId:'123'}).allowed).toBe(false)
})
it('does not match a scoped grant when identity is absent',()=>{
 expect(evaluatePolicy('desktop_screenshot',{}, {defaultAction:'deny',rules:[{tool:'desktop_screenshot',action:'allow',users:['123'],channels:['telegram']}]}).action).toBe('deny')
})
