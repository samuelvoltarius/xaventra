// Actual Docker rollback/state proof, with a fixture quiescence authority.
// This is NOT proof that production Mesh writers are fenced.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { localDockerRepairEngine } from '../dist/doctor/docker-repair-driver.js'
import { createDockerRepairStateCloner } from '../dist/doctor/docker-repair-state.js'

const image=process.env.XAVENTRA_REPAIR_SANDBOX_IMAGE
if(!/^sha256:[a-f0-9]{64}$/.test(image||''))throw Error('Explicit trusted helper image required')
const engine=localDockerRepairEngine(), tag=`qa-${randomUUID()}`,ids=[],volumes=[]
const output=resolve('.nova-data/docker-repair-state-qa',tag);mkdirSync(output,{recursive:true})
const report={sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
 evidenceClass:'actual-Docker-isolated-state-copy-negative-controls-not-Mesh-quiescence',checks:[]}
const volume=async suffix=>{const name=`xaventra-state-${tag}-${suffix}`;await engine.call('POST','/volumes/create',{Name:name,Labels:{'xaventra.repair-qa':tag}});volumes.push(name);return name}
const container=async(mounts,code,user='1000:1000',capAdd=[])=>{
 const value=await engine.call('POST',`/containers/create?name=xaventra-state-qa-${randomUUID()}`,{Image:image,User:user,Entrypoint:['/usr/local/bin/node'],Cmd:['-e',code],Env:['PATH=/usr/local/bin:/usr/bin:/bin'],
 Labels:{'xaventra.repair-qa':tag},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:capAdd,SecurityOpt:['no-new-privileges'],Memory:256*1024*1024,NanoCpus:1_000_000_000,PidsLimit:32,RestartPolicy:{Name:'no'},Mounts:mounts,LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}}}})
 ids.push(value.Id);return value.Id
}
const run=async id=>{await engine.call('POST',`/containers/${id}/start`);for(let i=0;i<150;i++){const info=await engine.call('GET',`/containers/${id}/json`);if(!info.State.Running){assert.equal(info.State.ExitCode,0);return}await new Promise(r=>setTimeout(r,100))}throw Error('Fixture helper timeout')}
try{
 const a=await volume('original'),b=await volume('candidate')
 await run(await container([{Type:'volume',Source:a,Target:'/a'},{Type:'volume',Source:b,Target:'/b'}],
  "const f=require('fs');f.writeFileSync('/a/memory.json',JSON.stringify({user:'fixture',corrected:true}));f.chmodSync('/a/memory.json',384);for(const p of ['/a','/b','/a/memory.json'])f.chownSync(p,1000,1000)",'0:0',['CHOWN']))
 const old=await container([{Type:'volume',Source:a,Target:'/data'}],''),next=await container([{Type:'volume',Source:b,Target:'/data'}],'')
 const ticket={attemptId:`repair-${randomUUID()}`}
 const clone=createDockerRepairStateCloner({engine,helperImageId:image,quiescent:async()=>true})
 assert.equal(await clone(old,next,ticket),true)
 await run(await container([{Type:'volume',Source:a,Target:'/a',ReadOnly:true},{Type:'volume',Source:b,Target:'/b'}],
  "const f=require('fs'),a=require('assert/strict');a.equal(f.readFileSync('/a/memory.json','utf8'),f.readFileSync('/b/memory.json','utf8'));a.equal(f.statSync('/b/memory.json').mode&511,384);f.writeFileSync('/b/memory.json','candidate wrote bad state');a.equal(JSON.parse(f.readFileSync('/a/memory.json')).corrected,true)"))
 report.checks.push({id:'actual-copy-content-modes-and-original-survives-candidate-writes',passed:true})
 assert.equal(await clone(old,next,ticket),false) // Never overwrite partially used candidate state.
 report.checks.push({id:'nonempty-destination-refused',passed:true})
 const c=await volume('symlink-destination')
 await run(await container([{Type:'volume',Source:a,Target:'/a'}],"require('fs').symlinkSync('/etc/passwd','/a/escape')"))
 await run(await container([{Type:'volume',Source:c,Target:'/c'}],"require('fs').chownSync('/c',1000,1000)",'0:0',['CHOWN']))
 const linked=await container([{Type:'volume',Source:c,Target:'/data'}],'')
 assert.equal(await clone(old,linked,ticket),false)
 report.checks.push({id:'linked-state-refused-not-followed',passed:true})
 const closed=createDockerRepairStateCloner({engine,helperImageId:image,quiescent:async()=>false})
 assert.equal(await closed(old,linked,ticket),false)
 report.checks.push({id:'unproven-external-writer-quiescence-refused',passed:true})
}catch(error){report.checks.push({id:'failed',passed:false,error:String(error)});process.exitCode=1}
finally{
 for(const id of ids)try{await engine.call('DELETE',`/containers/${id}?force=true`)}catch(error){report.checks.push({id:'cleanup',passed:false,error:String(error)});process.exitCode=1}
 // Volume names were generated and created by this fixture; no production volume selection.
 for(const name of volumes)try{await engine.call('DELETE',`/volumes/${name}`)}catch(error){report.checks.push({id:'volume-cleanup',passed:false,error:String(error)});process.exitCode=1}
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}
