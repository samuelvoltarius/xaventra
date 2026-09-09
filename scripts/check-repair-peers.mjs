// Real Docker processes/volumes. Synthetic data and fixture authority only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { localDockerRepairEngine, dockerRepairConfigHash } from '../dist/doctor/docker-repair-driver.js'
import { createPublishedRepairContainer } from '../dist/doctor/docker-repair-publication.js'
import { createDockerRepairStateCloner } from '../dist/doctor/docker-repair-state.js'
import { prepareRepairPeerReplacement } from '../dist/doctor/repair-peer-migration.js'
import { RepairWriterBarrier } from '../dist/doctor/repair-writers.js'

const project=resolve(import.meta.dirname,'..'),root=mkdtempSync(join(tmpdir(),'xaventra-peer-qa-'))
const output=join(project,'.nova-data','repair-peer-qa',root.split(/[\\/]/).at(-1));mkdirSync(output,{recursive:true})
const report={sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8'}).trim(),
 sourceDirty:!!execFileSync('git',['status','--porcelain'],{cwd:project,encoding:'utf8'}).trim(),version:JSON.parse(readFileSync(join(project,'package.json'))).version,
 platform:process.platform,evidenceClass:'real isolated Docker processes, same-image peer migration, named-volume clone and file-write observations; fixture authority, not production or remote database fencing',checks:[]}
const image=process.env.XAVENTRA_REPAIR_SANDBOX_IMAGE;assert.match(image||'',/^sha256:[a-f0-9]{64}$/)
const engine=localDockerRepairEngine(),containers=[]
const info=id=>engine.call('GET',`/containers/${id}/json`)
const start=id=>engine.call('POST',`/containers/${id}/start`)
const check=(name,fn)=>{fn();report.checks.push({name,passed:true})}
const readVolume=name=>execFileSync('docker',['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000',
 '--memory','128m','--cpus','1','--pids-limit','16','--mount',`type=volume,source=${name},target=/state,readonly,volume-nocopy`,
 '--entrypoint','/usr/local/bin/node',image,'-e',"const fs=require('node:fs');process.stdout.write(JSON.stringify(Object.fromEntries(fs.readdirSync('/state').sort().map(n=>[n,fs.readFileSync('/state/'+n,'utf8')]))));"],{encoding:'utf8',timeout:30_000}).trim()
const waitFor=async fn=>{for(let i=0;i<60;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100))}throw Error('Expected real peer write not observed')}
async function fixture(label){
 const base={Image:image,User:'1000:1000',Entrypoint:['/usr/local/bin/node'],Cmd:['-e','setInterval(()=>{},1000)'],
  HostConfig:{ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Memory:128*1024*1024,NanoCpus:1_000_000_000,PidsLimit:32,NetworkMode:'none',RestartPolicy:{Name:'no'},
    LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}},Mounts:[{Type:'volume',Source:'fresh',Target:'/state',VolumeOptions:{NoCopy:true}}]}}
 const binding={proposalId:label,patchHash:'a'.repeat(64),baselineHash:'b'.repeat(64),candidateHash:'c'.repeat(64),targetId:label,probeId:'state'}
 const artifact={version:1,binding,releaseId:label,previousReleaseId:'baseline',imageId:image,baseImageId:image,sourceHash:binding.baselineHash,compiledHash:'d'.repeat(64),createdAt:Date.now()}
 const old=await createPublishedRepairContainer(engine,artifact,base);containers.push(old.containerId)
 const next=await createPublishedRepairContainer(engine,{...artifact,releaseId:label+'-new'},base);containers.push(next.containerId)
 const oldInfo=await info(old.containerId),newInfo=await info(next.containerId),from=oldInfo.Mounts[0],to=newInfo.Mounts[0]
 const peerBody=structuredClone(base);peerBody.HostConfig.Mounts[0].Source=from.Name
 peerBody.Cmd=['-e',"const fs=require('node:fs'),os=require('node:os');fs.appendFileSync('/state/starts',os.hostname()+'\\n');setInterval(()=>fs.appendFileSync('/state/events',os.hostname()+'\\n'),100)"]
 const created=await engine.call('POST',`/containers/create?name=xaventra-peer-qa-${randomUUID()}`,peerBody);containers.push(created.Id)
 const peer={containerId:created.Id,configHash:dockerRepairConfigHash(await info(created.Id))}
 await start(old.containerId);await start(peer.containerId)
 await waitFor(async()=>JSON.parse(readVolume(from.Name)).starts?.includes(peer.containerId.slice(0,12)))
 const mappings=[{fromSource:from.Source,fromName:from.Name,toSource:to.Source,toName:to.Name}]
 const preparation={root:join(root,label,'prepare'),engine,member:peer,mappings}
 const replacement=await prepareRepairPeerReplacement(preparation);containers.push(replacement.containerId)
 assert.deepEqual(await prepareRepairPeerReplacement(preparation),replacement)
 const hosts=[{id:'fixture',engine,members:[old,peer].map(r=>({containerId:r.containerId,configHash:r.configHash})),
  staged:[{containerId:next.containerId,configHash:next.configHash},{containerId:replacement.containerId,configHash:replacement.configHash}],
  protectedSources:[from.Source,to.Source],preserveSources:[from.Source],volumeMappings:mappings,replacements:[replacement]}]
 const options={root:join(root,label,'barrier'),hosts,requiredHosts:['fixture'],externalSinks:[],hasAuthority:async()=>true,toolDrain:async()=>true}
 const barrier=new RepairWriterBarrier(options),ticket={...binding,attemptId:`repair-${randomUUID()}`,expiresAt:Date.now()+300_000}
 return {old,next,peer,replacement,from,to,barrier,options,ticket,peerBody}
}
try{
 const f=await fixture('success')
 const prepared=await info(f.replacement.containerId)
 const originalRunning=(await info(f.peer.containerId)).State.Running
 check('prepared same-image replacement remains stopped and original worker stays running',()=>{assert.equal(prepared.State.Running,false);assert.equal(originalRunning,true)})
 await f.barrier.halt(f.ticket);assert.equal(await f.barrier.quiescent(f.ticket),true)
 const frozen=readVolume(f.from.Name)
 const clone=createDockerRepairStateCloner({engine,helperImageId:image,quiescent:t=>f.barrier.quiescent(t)})
 assert.equal(await clone(f.old.containerId,f.next.containerId,f.ticket),true)
 check('quiescent main and peer state copied exactly to a distinct volume',()=>assert.equal(readVolume(f.to.Name),frozen))
 const rogue=await engine.call('POST',`/containers/create?name=xaventra-peer-rogue-${randomUUID()}`,f.peerBody);containers.push(rogue.Id)
 await assert.rejects(()=>f.barrier.resumePeers(f.ticket,[f.old.containerId,f.next.containerId]),/Unenrolled/)
 const afterDenial=await info(f.replacement.containerId)
 check('new unknown writer blocks every replacement start',()=>assert.equal(afterDenial.State.Running,false))
 await engine.call('DELETE',`/containers/${rogue.Id}?force=true`);containers.splice(containers.indexOf(rogue.Id),1)
 await start(f.next.containerId)
 await f.barrier.resumePeers(f.ticket,[f.old.containerId,f.next.containerId])
 await waitFor(async()=>JSON.parse(readVolume(f.to.Name)).events?.includes(f.replacement.containerId.slice(0,12)))
 check('replacement writes only cloned state; frozen original bytes unchanged',()=>assert.equal(readVolume(f.from.Name),frozen))
 assert.equal((await info(f.peer.containerId)).State.Running,false)
 await new RepairWriterBarrier({...f.options,hasAuthority:async()=>false,toolDrain:async()=>false}).resumePeers(f.ticket,[f.old.containerId,f.next.containerId])
 check('controller restart reconciles without another worker start',()=>assert.equal(JSON.parse(readVolume(f.to.Name)).starts.split(f.replacement.containerId.slice(0,12)).length-1,1))
 const r=await fixture('rollback');await r.barrier.halt(r.ticket)
 const rollbackClone=createDockerRepairStateCloner({engine,helperImageId:image,quiescent:t=>r.barrier.quiescent(t)})
 assert.equal(await rollbackClone(r.old.containerId,r.next.containerId,r.ticket),true)
 const untouched=readVolume(r.to.Name)
 await start(r.old.containerId);await r.barrier.resumePeers(r.ticket,[r.old.containerId,r.next.containerId],true)
 await waitFor(async()=>JSON.parse(readVolume(r.from.Name)).starts.split(r.peer.containerId.slice(0,12)).length-1===2)
 check('rollback resumes original generation without writing candidate state',()=>assert.equal(readVolume(r.to.Name),untouched))
 assert.equal((await info(r.replacement.containerId)).State.Running,false)
 report.passed=true
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1}
finally{for(const id of containers.reverse())try{await engine.call('DELETE',`/containers/${id}?force=true`)}catch{}
 report.completedAt=new Date().toISOString();writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))}
