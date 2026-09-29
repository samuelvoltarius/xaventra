import { it,expect } from 'vitest'
import { stageSignedNativePackage } from './native-package-stage.js'

it('rejects unauthenticated input before inspecting or creating staging paths',async()=>{
    await expect(stageSignedNativePackage({} as any,{} as any,{} as any,Buffer.alloc(0),{
        archive:'/nonexistent/archive',parent:'/nonexistent/stage',
    })).rejects.toThrow()
})
