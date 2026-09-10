// Actual isolated compiler, image publisher, source CAS, Docker background
// writers and independent HTTP predicate. No production/HA credentials or data.
import assert from 'node:assert/strict'
import { generateKeyPairSync,randomUUID,createHash } from 'node:crypto'
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync,copyFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { RepairPublication,normalizedRepairPatch } from '../dist/doctor/repair-publication.js'
import { createDockerRepairBuilder } from '../dist/doctor/docker-repair-builder.js'
import { createPublishedRepairContainer } from '../dist/doctor/docker-repair-publication.js'
import { localDockerRepairEngine,DockerRepairDriver,dockerRepairConfigHash } from '../dist/doctor/docker-repair-driver.js'
import { createDockerRepairStateCloner } from '../dist/doctor/docker-repair-state.js'
import { RepairWriterBarrier } from '../dist/doctor/repair-writers.js'
import { RepairActivationController,repairHash,signRepairValue,verifyRepairValue } from '../dist/doctor/repair-activation.js'
import { createHttpRepairProbe } from '../dist/doctor/repair-controller-server.js'
import { readPatchSnapshot,patchSnapshotHash,createPatchCandidate } from '../dist/synthesis/patch-sandbox.js'

const project=resolve(import.meta.dirname,'..'),root=mkdtempSync(join(tmpdir(),'xaventra-publication-'))
const output=join(project,'.nova-data','repair-publication-qa',root.split(/[\\/]/).at(-1));mkdirSync(output,{recursive:true})
const report={sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8'}).trim(),sourceDirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:project,encoding:'utf8'}).trim()),
  version:JSON.parse(readFileSync(join(project,'package.json'))).version,platform:process.platform,
  evidenceClass:'actual isolated TypeScript/image/source publication and Docker writer stop; fixture lease/admission and synthetic HTTP fault; not production/LLM/DB fencing',checks:[]}
const image=process.env.XAVENTRA_REPAIR_SANDBOX_IMAGE
assert.match(image||'',/^sha256:[a-f0-9]{64}$/)
const source=join(root,'input');mkdirSync(join(source,'src'),{recursive:true})
const files={
 'package.json':'{"name":"publication-fixture","type":"module"}',
 'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',rootDir:'src',skipLibCheck:true},include:['src']}),
 'vitest.config.ts':"import {defineConfig} from 'vitest/config';export default defineConfig({test:{include:['src/**/*.test.ts']}})",
 'xaventra.config.example.json':'{}','src/value.ts':'export const value = 1;',
 'src/server.ts':"import http from 'node:http';import {value} from './value.js';const server=http.createServer((q,r)=>r.end(q.url==='/ready'?'ready':String(value))).listen(8080,'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));",
 'src/original.test.ts':"import {it,expect} from 'vitest';import {value} from './value.js';it('original HTTP value contract',()=>expect(value).toBe(2));",
 'src/control.test.ts':"import {it,expect} from 'vitest';import {value} from './value.js';it('integer',()=>expect(Number.isInteger(value)).toBe(true));",
}
for(const [file,value]of Object.entries(files))writeFileSync(join(source,file),value)
copyFileSync(join(project,'package-lock.json'),join(source,'package-lock.json'))
execFileSync('git',['init','-q'],{cwd:source});execFileSync('git',['add','.'],{cwd:source})
const keys=()=>{const k=generateKeyPairSync('ed25519');return{private:k.privateKey.export({type:'pkcs8',format:'pem'}).toString(),public:k.publicKey.export({type:'spki',format:'pem'}).toString()}}
const signing=keys(),approval=keys(),receiptKey=keys(),engine=localDockerRepairEngine(),containers=[]
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r))
const patch={file:'src/value.ts',description:'correct original answer',search:'value = 1',replace:'value = 2',reproductionTest:'src/original.test.ts',repairProfileId:'fixture'}
const baseline=readPatchSnapshot(source),binding={proposalId:'fixture',patchHash:repairHash(normalizedRepairPatch(patch)),baselineHash:patchSnapshotHash(baseline),candidateHash:patchSnapshotHash(createPatchCandidate(baseline,patch)),targetId:'fixture',probeId:'answer'}
const template={Image:image,User:'1000:1000',Entrypoint:['/usr/local/bin/node'],Cmd:['/app/dist/server.js'],Env:['PATH=/usr/local/bin:/usr/bin:/bin'],
  ExposedPorts:{'8080/tcp':{}},Healthcheck:{Test:['CMD','/usr/local/bin/node','-e',"fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],Interval:1_000_000_000,Timeout:1_000_000_000,Retries:10},
  HostConfig:{ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Memory:256*1024*1024,NanoCpus:1_000_000_000,PidsLimit:32,NetworkMode:'bridge',RestartPolicy:{Name:'no'},LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}},
    PortBindings:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:String(port)}]},Mounts:[{Type:'volume',Source:'new-only',Target:'/state',VolumeOptions:{NoCopy:true}}]}}
const register=async(artifact,config)=>{const r=await createPublishedRepairContainer(engine,artifact,config);containers.push(r.containerId);return r}
const check=(name,fn)=>{fn();report.checks.push({name,passed:true})}
let currentTicket,barrier,candidate,state
try{
 const initial={version:1,binding,releaseId:'old',previousReleaseId:'none',imageId:image,baseImageId:image,sourceHash:binding.baselineHash,compiledHash:'a'.repeat(64),createdAt:Date.now()}
 const oldConfig=structuredClone(template);oldConfig.Cmd=['-e',"require('node:fs').writeFileSync('/state/seed','original');const server=require('node:http').createServer((q,r)=>r.end(q.url==='/ready'?'ready':'1')).listen(8080,'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>process.exit(0)))"]
 const old=await register(initial,oldConfig);await engine.call('POST',`/containers/${old.containerId}/start`)
 const peerConfig=structuredClone(template);delete peerConfig.ExposedPorts;delete peerConfig.Healthcheck;peerConfig.HostConfig.PortBindings={};peerConfig.HostConfig.NetworkMode='none';peerConfig.Cmd=['-e',"const timer=setInterval(()=>require('node:fs').appendFileSync('/state/events','tick\\n'),20);process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)})"]
 const peer=await register({...initial,releaseId:'peer'},peerConfig);await engine.call('POST',`/containers/${peer.containerId}/start`)
 const oldInfo=await engine.call('GET',`/containers/${old.containerId}/json`),peerInfo=await engine.call('GET',`/containers/${peer.containerId}/json`)
 const oldSource=oldInfo.Mounts.find(m=>m.RW).Source
 const endpoint=`http://127.0.0.1:${port}/answer`
 for(let n=0;n<100;n++){try{if(await(await fetch(endpoint)).text()==='1')break}catch{}await new Promise(r=>setTimeout(r,100))}
 assert.equal(await(await fetch(endpoint)).text(),'1')
 const publisher=new RepairPublication({root:join(root,'store'),signingPrivateKey:signing.private,signingPublicKey:signing.public,receiptPublicKey:receiptKey.public,
  profiles:[{id:'fixture',file:patch.file,reproductionTest:patch.reproductionTest,targetId:'fixture',probeId:'answer'}],builder:createDockerRepairBuilder({imageId:image,stagingRoot:join(root,'builds')})})
 publisher.enroll(source,'old')
 const hosts=()=>[{id:'fixture-host',engine,members:[old,peer].map(r=>({containerId:r.containerId,configHash:r.configHash})),staged:candidate?[{containerId:candidate.containerId,configHash:candidate.configHash}]:[],
  protectedSources:[oldSource,peerInfo.Mounts.find(m=>m.RW).Source,...(candidate?[candidate.source]:[])],preserveSources:[oldSource]}]
 const rogueConfig=structuredClone(peerConfig);rogueConfig.HostConfig.Mounts[0].Source=oldInfo.Mounts.find(m=>m.RW).Name
 const rogue=await engine.call('POST',`/containers/create?name=xaventra-publication-negative-${randomUUID()}`,rogueConfig);containers.push(rogue.Id)
 const negative=new RepairWriterBarrier({root:join(root,'negative'),hosts:hosts(),requiredHosts:['fixture-host'],externalSinks:[],hasAuthority:async()=>true,toolDrain:async()=>true})
 const t={...binding,attemptId:`repair-${randomUUID()}`,expiresAt:Date.now()+600_000}
 await assert.rejects(()=>negative.halt(t),/Unenrolled/)
 const afterDenial=await engine.call('GET',`/containers/${old.containerId}/json`)
 check('unknown state sharer refused before production-like writers stop',()=>assert.equal(afterDenial.State.Running,true))
 await engine.call('DELETE',`/containers/${rogue.Id}?force=true`);containers.splice(containers.indexOf(rogue.Id),1)
 const stateReady=createDockerRepairStateCloner({engine,helperImageId:image,quiescent:ticket=>barrier.quiescent(ticket)})
 const driver=new DockerRepairDriver({targetId:'fixture',initialReleaseId:'old',releases:{old},catalog:{},hasAuthority:async()=>true,loadState:()=>state,saveState:s=>{state=s},stateReady,
  prepareRelease:async ticket=>{
   const signed=await publisher.publish(binding,patch),artifact=verifyRepairValue(signed,signing.public)
   check('signed automatic isolated build leaves baseline source active',()=>{assert.equal(artifact.sourceHash,binding.candidateHash);assert.equal(JSON.parse(readFileSync(join(root,'store/current.json'))).sourceHash,binding.baselineHash)})
   candidate=await register(artifact,template);candidate.source=(await engine.call('GET',`/containers/${candidate.containerId}/json`)).Mounts.find(m=>m.RW).Source
   return candidate
  }},engine)
 driver.beginMaintenance=async ticket=>{currentTicket=ticket;barrier=new RepairWriterBarrier({root:join(root,'writers'),hosts:hosts(),requiredHosts:['fixture-host'],externalSinks:[],hasAuthority:async()=>true,toolDrain:async()=>true});await barrier.halt(ticket)
  const quiet=await barrier.quiescent(ticket),oldStopped=await engine.call('GET',`/containers/${old.containerId}/json`),peerStopped=await engine.call('GET',`/containers/${peer.containerId}/json`)
  check('actual main and background peer exit before state copy',()=>{assert.equal(quiet,true);assert.equal(oldStopped.State.Running,false);assert.equal(peerStopped.State.Running,false)})}
 const probe=createHttpRepairProbe([{id:'answer',targetId:'fixture',url:endpoint,expectedStatus:200,expectedBodySha256:createHash('sha256').update('2').digest('hex')}],driver)
 const controller=new RepairActivationController(join(root,'controller'),approval.public,driver,probe)
 const result=await controller.activate(signRepairValue(t,approval.private))
 assert.equal(result.status,'resolved',JSON.stringify(result))
 check('prepared image activated only after background drain and actual state clone',()=>{assert.equal(result.before.state,'fault');assert.equal(result.after.state,'healthy')})
 publisher.commitSource(signRepairValue(result,receiptKey.private))
 check('independent recovery receipt advances exact source mirror',()=>assert.equal(JSON.parse(readFileSync(join(root,'store/current.json'))).sourceHash,binding.candidateHash))
 await barrier.resumePeers(currentTicket,[old.containerId,candidate.containerId])
 const oldFinal=await engine.call('GET',`/containers/${old.containerId}/json`),peerFinal=await engine.call('GET',`/containers/${peer.containerId}/json`)
 check('unshared peer resumes while old main remains stopped',()=>{assert.equal(peerFinal.State.Running,true);assert.equal(oldFinal.State.Running,false)})
 report.passed=true
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1}
finally{
 for(const id of containers.reverse())try{await engine.call('DELETE',`/containers/${id}?force=true`)}catch{}
 report.completedAt=new Date().toISOString();writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))
}
