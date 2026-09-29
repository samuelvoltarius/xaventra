import {requestSessionCapture,requestSessionInput} from '../src/host/capture-agent.ts'
import {writeFileSync,mkdtempSync} from 'node:fs'
import {randomUUID,createHash} from 'node:crypto'
const [socket,token]=process.argv.slice(2)
const root=mkdtempSync('/var/tmp/xaventra-workstation-qa-')
const before=await requestSessionCapture(socket,token);writeFileSync(root+'/before.png',before)
await requestSessionInput(socket,token,randomUUID(),{action:'click',x:300,y:110,button:'left'})
const id=randomUUID(),action={action:'key',key:'alt+F4'}
const input=await requestSessionInput(socket,token,id,action)
const replay=await requestSessionInput(socket,token,id,action)
await new Promise(r=>setTimeout(r,500))
const after=await requestSessionCapture(socket,token);writeFileSync(root+'/after.png',after)
const hash=b=>createHash('sha256').update(b).digest('hex')
const report={root,capture:true,input:input.status==='completed',duplicateSuppressed:replay.replayed===true,beforeHash:hash(before),afterHash:hash(after),visualChanged:hash(before)!==hash(after),telegramDelivery:false}
writeFileSync(root+'/evidence.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))
if(!report.input||!report.duplicateSuppressed||!report.visualChanged)process.exitCode=1
