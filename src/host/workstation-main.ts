/** Owns a NEW authenticated virtual X11 server, never an existing user display. */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync, readFileSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createCaptureAgent } from './capture-agent.js'
import { executeDesktopInputOnce, runDesktopInput } from './desktop-input.js'

const [runtime,state,tokenFile]=process.argv.slice(2)
if(process.platform!=='linux'||process.getuid?.()===0||process.argv.length!==5
 ||![runtime,state,tokenFile].every(p=>p?.startsWith('/')))throw Error('Explicit unprivileged workstation paths required')
const exec=promisify(execFile),children:ReturnType<typeof spawn>[]=[]
const auth=join(runtime,'Xauthority'),socket=join(runtime,'desktop.sock')
if(existsSync(auth)||existsSync(socket))throw Error('Workstation runtime already occupied')
const number=Array.from({length:100},(_,i)=>i+100).find(n=>!existsSync(`/tmp/.X11-unix/X${n}`)&&!existsSync(`/tmp/.X${n}-lock`))
if(number===undefined)throw Error('No unoccupied virtual display')
const display=`:${number}`
writeFileSync(auth,'',{flag:'wx',mode:0o600})
await exec('/usr/bin/xauth',['-f',auth,'add',display,'MIT-MAGIC-COOKIE-1',randomBytes(16).toString('hex')],{timeout:5000})
const env={PATH:'/usr/bin:/bin',HOME:state,DISPLAY:display,XAUTHORITY:auth,XDG_SESSION_TYPE:'x11',LANG:'C.UTF-8'}
Object.assign(process.env,env)
const start=(file:string,args:string[])=>{const child=spawn(file,args,{env,stdio:'ignore'});children.push(child);return child}
const x=start('/usr/bin/Xvfb',[display,'-screen','0','1440x900x24','-nolisten','tcp','-auth',auth,'-noreset'])
let stopping=false
const live=()=>{if(stopping||x.exitCode!==null||x.signalCode!==null)throw Error('Owned workstation display unavailable')}
const stop=()=>{if(stopping)return;stopping=true;for(const child of children.reverse())child.kill('SIGTERM');setTimeout(()=>process.exit(0),1000)}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,stop)
x.on('error',()=>{console.error('Workstation display startup failed');stop()})
x.on('exit',()=>{if(!stopping){console.error('Owned display exited');stop()}})
let ready=false
for(let n=0;n<50;n++){live();try{await exec('/usr/bin/xdotool',['getdisplaygeometry'],{env,timeout:1000});ready=true;break}catch{}await new Promise(r=>setTimeout(r,100))}
if(!ready){stop();throw Error('Virtual display readiness failed')}
start('/usr/bin/openbox',[])
start('/usr/bin/xterm',['-title','Xaventra Terminal','-geometry','90x25+100+350','-e','/bin/bash','--noprofile','--norc'])
start('/usr/bin/xmessage',['-title','Xaventra Arbeitsdesktop','-geometry','620x180+100+100','-buttons','Bereit:0','Eigener Xaventra-Arbeitsdesktop\nGetrennt von der persoenlichen Sitzung.\nScreenshot und Computer Use arbeiten hier.'])
mkdirSync(join(state,'input-receipts'),{recursive:true,mode:0o700})
const server=createCaptureAgent(readFileSync(tokenFile,'utf8').trim(),async()=>{
 live();const path=join(runtime,`capture-${randomBytes(12).toString('hex')}.png`)
 try{await exec('/usr/bin/scrot',['--overwrite',path],{env,timeout:15000,maxBuffer:4096});live();return readFileSync(path)}finally{if(existsSync(path))unlinkSync(path)}
},async(id,action)=>{live();return executeDesktopInputOnce(join(state,'input-receipts'),id,action,async args=>{live();await runDesktopInput(args);live()})})
server.on('error',()=>{console.error('Workstation adapter failed');stop()})
server.listen(socket,()=>{chmodSync(socket,0o660);writeFileSync(join(runtime,'ready.json'),JSON.stringify({display,pid:x.pid,socket,kind:'owned-virtual-desktop'}),{mode:0o640});console.log('Dedicated workstation ready')})
