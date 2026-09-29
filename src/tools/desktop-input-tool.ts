import { getExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { createHash } from 'node:crypto'
import { desktopInputArgs } from '../host/desktop-input.js'
import { requestSessionInput } from '../host/capture-agent.js'
export const desktopInputTool={
 name:'desktop_input',category:'system' as const,
 description:'Bediene den freigegebenen X11-Desktop: move, click, type, key oder scroll. Erst desktop_screenshot zur Orientierung nutzen. Gesperrte Sitzungen werden nicht entsperrt. Erfolg belegt die Eingabe, nicht den gewünschten Bildschirminhalt; danach Screenshot prüfen. Bei unklarem Ergebnis nicht blind wiederholen.',
 parameters:[{name:'action',type:'string' as const,required:true,description:'JSON object: {action:"click",x:100,y:100,button:"left"}, {action:"move",x:100,y:100}, {action:"type",text:"Hallo"}, {action:"key",key:"ctrl+a"}, {action:"scroll",direction:"down",amount:3}'},{name:'step',type:'string' as const,required:true,description:'Eindeutige Schrittkennung innerhalb dieses Auftrags; bei Wiederholung desselben Schritts unverändert lassen.'}],
 handler:async(params:Record<string,any>)=>{try{
   const c=getExecutionPolicyContext(),owner=process.env.NOVA_DESKTOP_TELEGRAM_OWNER_ID
   if(process.env.NOVA_DESKTOP_INPUT_ENABLED!=='1'||!owner||c.authUserId!==owner||c.channel?.toLowerCase()!=='telegram'||!c.runId)throw Error('Desktop input requires enrolled authenticated Telegram owner and run')
   if(typeof params.step!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(params.step))throw Error('Invalid step')
   const action=JSON.parse(params.action);desktopInputArgs(action)
   const h=createHash('sha256').update(JSON.stringify([c.runId,c.authUserId,params.step])).digest('hex')
   const id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`
   return {success:true,receipt:await requestSessionInput(process.env.NOVA_CAPTURE_SOCKET||'',process.env.NOVA_CAPTURE_TOKEN_FILE||'',id,action)}
 }catch(e){return {success:false,error:String(e)}}}
}
