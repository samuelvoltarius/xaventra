import { expect,it } from 'vitest'
import { stageSignedNativePackageOnce } from './native-stage-journal.js'
it.each(['../escape','','a/b','a'.repeat(81)])('rejects unsafe request identity %s before filesystem writes',async id=>{
    await expect(stageSignedNativePackageOnce(id,'/unused',{} as any,{} as any,{} as any,Buffer.alloc(0),{archive:'/unused',parent:'/unused'})).rejects.toThrow('identity invalid')
})
