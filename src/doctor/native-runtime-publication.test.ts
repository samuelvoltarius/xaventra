import { it,expect } from 'vitest'
import { publishNativeRuntimeOnce } from './native-runtime-publication.js'
it.each(['','../escape','a/b','x'.repeat(81)])('rejects unsafe publication identity %j',async id=>{
    await expect(publishNativeRuntimeOnce(id,'/unused',{uid:1,gid:1},{} as any,{} as any,{} as any,Buffer.alloc(0),{archive:'/unused',parent:'/unused'})).rejects.toThrow('identity invalid')
})
it('refuses root runtime before any publication',async()=>{
    await expect(publishNativeRuntimeOnce('valid','/unused',{uid:0,gid:0},{} as any,{} as any,{} as any,Buffer.alloc(0),{archive:'/unused',parent:'/unused'})).rejects.toThrow('Unprivileged')
})
