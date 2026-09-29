import {it,expect,vi} from 'vitest'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {desktopInputArgs,executeDesktopInputOnce} from './desktop-input.js'
it('maps bounded typed input to argv without a shell',()=>{
 expect(desktopInputArgs({action:'click',x:3,y:4,button:'left'})).toEqual(['mousemove','--sync','3','4','click','1'])
 expect(desktopInputArgs({action:'type',text:'$(whoami)'})).toEqual(['type','--clearmodifiers','--delay','1','--','$(whoami)'])
 expect(desktopInputArgs({action:'key',key:'ctrl+a'})).toEqual(['key','--clearmodifiers','ctrl+a'])
})
it.each([{action:'exec',command:'id'},{action:'type',text:'hello\n'},{action:'key',key:'a;sh'},{action:'click',x:-1,y:0,button:'left'},{action:'scroll',direction:'down',amount:21},{action:'move',x:1,y:1,display:':1'}])('refuses malformed input %j',a=>expect(()=>desktopInputArgs(a)).toThrow())
it('rehydrates completed receipts without a second effect and refuses conflicting arguments',async()=>{
 const root=mkdtempSync(join(tmpdir(),'desktop-input-')),id=randomUUID(),run=vi.fn(async()=>{}),action={action:'key',key:'Tab'}
 await executeDesktopInputOnce(root,id,action,run)
 expect(await executeDesktopInputOnce(root,id,action,run)).toMatchObject({status:'completed',replayed:true})
 await expect(executeDesktopInputOnce(root,id,{action:'key',key:'Return'},run)).rejects.toThrow('conflict')
 expect(run).toHaveBeenCalledOnce()
})
it('does not repeat an input after uncertain execution',async()=>{
 const root=mkdtempSync(join(tmpdir(),'desktop-input-')),id=randomUUID(),run=vi.fn(async()=>{throw Error('lost')})
 await expect(executeDesktopInputOnce(root,id,{action:'key',key:'Tab'},run)).rejects.toThrow('lost')
 await expect(executeDesktopInputOnce(root,id,{action:'key',key:'Tab'},run)).rejects.toThrow('uncertain')
 expect(run).toHaveBeenCalledOnce()
})
