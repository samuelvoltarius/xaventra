import { it,expect } from 'vitest'
import { verifyNativeRuntimeAccess } from './native-runtime-access.js'
it.each([undefined,{uid:0,gid:1},{uid:1,gid:0},{uid:-1,gid:1},{uid:1.5,gid:1},{uid:1,gid:NaN}])('rejects invalid or privileged account before execution: %j',account=>{
    expect(()=>verifyNativeRuntimeAccess('/unused',account)).toThrow('Unprivileged native runtime account required')
})
