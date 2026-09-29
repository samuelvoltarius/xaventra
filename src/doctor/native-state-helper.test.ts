import { it, expect } from 'vitest'
import { NativeStateHelper } from './native-state-helper.js'
const profile={node:'/opt/helper/node',nodeHash:'a'.repeat(64),setprivHash:'b'.repeat(64),uid:1000,gid:1000,source:'/state/source',destination:'/state/next'}
it.each([{uid:0},{gid:0},{uid:-1},{gid:1.5},{nodeHash:'bad'},{setprivHash:''},{node:'relative'},{destination:'/state/source/next'},{limits:{timeoutMs:999999}}])('rejects unsafe enrollment %j', change=>{
    expect(()=>new NativeStateHelper({...profile,...change})).toThrow()
})
it('rejects arbitrary hash paths before creating a process',async()=>{
    await expect(new NativeStateHelper(profile).hash('/etc/shadow')).rejects.toThrow('Unenrolled')
})
it('retains a private enrollment copy instead of caller-mutable authority',async()=>{
    const mutable={...profile}, helper=new NativeStateHelper(mutable)
    mutable.source='/etc/shadow'
    await expect(helper.hash('/etc/shadow')).rejects.toThrow('Unenrolled')
})
