/** Owns a NEW authenticated virtual X11 server, never an existing user display. */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync, readFileSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { createCaptureAgent } from './capture-agent.js'
import { executeDesktopInputOnce, runDesktopInput } from './desktop-input.js'
import { planWorkstationPaths, workstationChildEnv, checkOwnedPrivatePath, assertOutsideShellHome,
 RUNTIME_FORBIDDEN_BITS, PRIVATE_FORBIDDEN_BITS, assertDedicatedWorkstationAccount, readLogindSessions } from './workstation-security.js'

const [runtime,state,tokenFile]=process.argv.slice(2)
if(process.platform!=='linux'||process.getuid?.()===0||process.argv.length!==5
 ||![runtime,state,tokenFile].every(p=>p?.startsWith('/')))throw Error('Explicit unprivileged workstation paths required')
const exec=promisify(execFile),children:ReturnType<typeof spawn>[]=[],uid=process.getuid!()
// Never run as the personal desktop user: explicit dedicated account name,
// no graphical logind session for this UID, no inherited display.
assertDedicatedWorkstationAccount({uid,username:userInfo().username,expectedAccount:process.env.NOVA_WORKSTATION_ACCOUNT,
 env:process.env,sessions:readLogindSessions()})
// Journal, token and X credentials live outside the HOME of the agent-controlled
// shell; every private path is verified owner-only before anything starts.
const paths=planWorkstationPaths(runtime,state),{auth,socket}=paths
checkOwnedPrivatePath('Runtime directory',runtime,'dir',uid,RUNTIME_FORBIDDEN_BITS)
checkOwnedPrivatePath('State directory',state,'dir',uid,PRIVATE_FORBIDDEN_BITS)
checkOwnedPrivatePath('Workstation token',tokenFile,'file',uid,PRIVATE_FORBIDDEN_BITS)
if(existsSync(paths.privateDir)||existsSync(socket))throw Error('Workstation runtime already occupied')
mkdirSync(paths.privateDir,{mode:0o700});chmodSync(paths.privateDir,0o700)
for(const dir of [paths.shellHome,paths.journal]){mkdirSync(dir,{recursive:true,mode:0o700});checkOwnedPrivatePath(dir,dir,'dir',uid,PRIVATE_FORBIDDEN_BITS)}
checkOwnedPrivatePath('Private runtime directory',paths.privateDir,'dir',uid,PRIVATE_FORBIDDEN_BITS)
assertOutsideShellHome('Workstation token',tokenFile,paths.shellHome)
assertOutsideShellHome('Input journal',paths.journal,paths.shellHome)
const number=Array.from({length:100},(_,i)=>i+100).find(n=>!existsSync(`/tmp/.X11-unix/X${n}`)&&!existsSync(`/tmp/.X${n}-lock`))
if(number===undefined)throw Error('No unoccupied virtual display')
const display=`:${number}`
writeFileSync(auth,'',{flag:'wx',mode:0o600})
await exec('/usr/bin/xauth',['-f',auth,'add',display,'MIT-MAGIC-COOKIE-1',randomBytes(16).toString('hex')],{timeout:5000})
const env=workstationChildEnv(paths,display)
Object.assign(process.env,env)
const start=(file:string,args:string[])=>{const child=spawn(file,args,{env,cwd:paths.shellHome,stdio:'ignore'});children.push(child);return child}
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
const server=createCaptureAgent(readFileSync(tokenFile,'utf8').trim(),async()=>{
 live();const path=join(paths.captureDir,`capture-${randomBytes(12).toString('hex')}.png`)
 try{await exec('/usr/bin/scrot',['--overwrite',path],{env,timeout:15000,maxBuffer:4096});live();return readFileSync(path)}finally{if(existsSync(path))unlinkSync(path)}
},async(id,action)=>{live();return executeDesktopInputOnce(paths.journal,id,action,async args=>{live();await runDesktopInput(args);live()})})
server.on('error',()=>{console.error('Workstation adapter failed');stop()})
server.listen(socket,()=>{chmodSync(socket,0o660);writeFileSync(paths.ready,JSON.stringify({display,pid:x.pid,socket,kind:'owned-virtual-desktop'}),{mode:0o640});console.log('Dedicated workstation ready')})
