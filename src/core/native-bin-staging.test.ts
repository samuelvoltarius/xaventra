import { it,expect,vi,afterEach } from 'vitest'
import { materializeNativeBin } from './native-bin-staging.js'
afterEach(()=>vi.unstubAllGlobals())
it('refuses non-Linux staging',()=>{vi.stubGlobal('process',{...process,platform:'win32'});expect(()=>materializeNativeBin('.','node_modules/.bin/tool')).toThrow('requires Linux')})
