import {it,expect,vi} from 'vitest'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {desktopInputArgs,desktopActionArgs,assertOpenUrlAllowed,executeDesktopInputOnce,precheckWorkstationAction,DesktopActionRefused} from './desktop-input.js'
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
it.each(['ctrl+alt+Delete','alt+ctrl+Delete','ctrl+alt+BackSpace','ctrl+alt+shift+BackSpace','super+l','super+shift+l',
 ...Array.from({length:12},(_,i)=>`ctrl+alt+F${i+1}`),'alt+ctrl+F1','ctrl+alt+shift+F7'])('refuses session-critical key combo %s',key=>
 expect(()=>desktopInputArgs({action:'key',key})).toThrow())
it.each(['alt+F4','ctrl+a','Delete','BackSpace','ctrl+BackSpace','F5','ctrl+F4','l','shift+Tab'])('keeps ordinary key %s',key=>
 expect(desktopInputArgs({action:'key',key})).toEqual(['key','--clearmodifiers',key]))
it('validates open_url structurally: public http(s) names only, no credentials or IP literals',()=>{
 expect(desktopActionArgs({action:'open_url',url:'https://example.com/a?b=1'})).toEqual(['open_url','https://example.com/a?b=1'])
 expect(desktopActionArgs({action:'key',key:'Tab'})).toEqual(['key','--clearmodifiers','Tab'])
 for(const url of ['file:///etc/passwd','javascript:alert(1)','https://user:pw@example.com/','http://192.168.0.1/','http://[::1]/','http://localhost:3000/',
  'http://nas.local/','http://host.internal/','http://box.ts.net/','https://example.com/'+'a'.repeat(2100),'']) expect(()=>desktopActionArgs({action:'open_url',url})).toThrow()
 expect(()=>desktopActionArgs({action:'open_url',url:'https://example.com',browser:'/bin/sh'})).toThrow()
 // The plain xdotool mapping never accepts a browser launch.
 expect(()=>desktopInputArgs({action:'open_url',url:'https://example.com'})).toThrow()
})
it('allows open_url only for operator-listed hosts (exact or subdomain)',()=>{
 expect(()=>assertOpenUrlAllowed('https://example.org/','example.org')).not.toThrow()
 expect(()=>assertOpenUrlAllowed('https://www.example.org/x','example.com, example.org')).not.toThrow()
 for(const [url,list] of [['https://evilexample.org/','example.org'],['https://example.org.evil.com/','example.org'],['https://example.org/',''],['https://example.org/',undefined]] as const)
  expect(()=>assertOpenUrlAllowed(url,list)).toThrow()
})
it('journals open_url only when the caller passes the workstation plan',async()=>{
 const root=mkdtempSync(join(tmpdir(),'desktop-input-')),run=vi.fn(async()=>{}),action={action:'open_url',url:'https://example.com/'}
 await expect(executeDesktopInputOnce(root,randomUUID(),action,run)).rejects.toThrow()
 const result=await executeDesktopInputOnce(root,randomUUID(),action,run,desktopActionArgs)
 expect(result).toMatchObject({status:'completed',replayed:false})
 expect(run).toHaveBeenCalledWith(['open_url','https://example.com/'])
})

const trusted={isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false,uid:0,mode:0o755}
const env={allowList:'greenchili.at,example.com',browser:'/opt/firefox-workstation/current/firefox/firefox',stat:()=>trusted}
it('pre-check refuses a host outside the allowlist with a clear reason, before anything is journaled',()=>{
 let error:unknown
 try{precheckWorkstationAction({action:'open_url',url:'https://wikipedia.org/'},env)}catch(e){error=e}
 expect(error).toBeInstanceOf(DesktopActionRefused)
 expect(String((error as Error).message)).toContain('nicht auf der Erlaubnisliste: wikipedia.org')
})
it('pre-check passes an allowed page with a trusted browser and plain xdotool actions',()=>{
 expect(precheckWorkstationAction({action:'open_url',url:'https://www.greenchili.at/'},env)).toEqual(['open_url','https://www.greenchili.at/'])
 expect(precheckWorkstationAction({action:'key',key:'Return'},{...env,browser:''})).toEqual(['key','--clearmodifiers','Return'])
})
it.each([
 [{action:'open_url',url:'https://greenchili.at/'},{...env,stat:()=>({...trusted,uid:997})}],
 [{action:'open_url',url:'https://greenchili.at/'},{...env,browser:''}],
 [{action:'exec',command:'id'},env],
 [{action:'open_url',url:'http://192.168.0.1/'},env],
])('pre-check refuses (certain, nothing executed) %j',(action,options)=>
 expect(()=>precheckWorkstationAction(action,options as any)).toThrow(DesktopActionRefused))
