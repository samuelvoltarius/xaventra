// Disposable end-to-end acceptance. No live configuration, channel, lease or
// production container is touched. Model mode is explicit in every report.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { generateKeyPairSync, createHash, randomUUID, randomInt } from 'node:crypto'

const source=resolve(import.meta.dirname,'..'), load=file=>import(pathToFileURL(join(source,'dist',file)).href)
const root=mkdtempSync(join(tmpdir(),'xaventra-docker-repair-')), project=join(root,'source')
const reportDir=resolve(process.env.XAVENTRA_DOCKER_REPAIR_QA_DIR||join(source,'.nova-data/docker-repair-qa',root.split(/[\\/]/).at(-1)))
mkdirSync(reportDir,{recursive:true});mkdirSync(join(project,'src'),{recursive:true});mkdirSync(join(root,'.nova-data/self-doctor'),{recursive:true})
const report={sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),
  sourceDirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:source,encoding:'utf8'}).trim()),
  version:JSON.parse(readFileSync(join(source,'package.json'))).version,platform:process.platform,
  modelMode:process.env.XAVENTRA_RESEARCH_QA_URL?'live-local-model':'scripted-model',
  coordinationMode:'real-signed-HTTP-authority-with-fixture-lease-and-operator-grants',
  evidenceClass:'native-Doctor-Kernel-to-real-sandbox-to-signed-Docker-activation-independent-HTTP-recovery-disposable-fixture',cases:[]}
const image=process.env.XAVENTRA_REPAIR_SANDBOX_IMAGE
if(!/^sha256:[a-f0-9]{64}$/.test(image||''))throw Error('Prepare and explicitly select trusted sandbox image first')
// This parent is the trusted fixture controller. Never inherit operator secrets
// into the native diagnostic runtime or the candidate/helper containers.
for(const key of Object.keys(process.env))if(/TOKEN|SECRET|API_KEY|PRIVATE_KEY|PASSWORD/.test(key))delete process.env[key]
Object.assign(process.env,{NOVA_TEST_MODE:'1',NOVA_NO_SIDE_EFFECTS:'1',NOVA_SKIP_MODEL_RESOLVER_INIT:'1',NOVA_NO_TELEGRAM:'true',
  NOVA_OTEL_ENABLED:'false',OTEL_SDK_DISABLED:'true',NODE_ENV:'test',NOVA_RUNTIME_ROOT:root,XAVENTRA_REPAIR_SOURCE_ROOT:project,HOME:root,USERPROFILE:root})
process.chdir(root)
const desired=randomInt(20,900), original='export const value = 1;'
writeFileSync(join(project,'src/value.ts'),original)
writeFileSync(join(project,'package.json'),'{"type":"module"}')
copyFileSync(join(source,'package-lock.json'),join(project,'package-lock.json'))
writeFileSync(join(project,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',skipLibCheck:true,noEmit:true},include:['src']}))
writeFileSync(join(project,'vitest.config.ts'),"import {defineConfig} from 'vitest/config'; export default defineConfig({test:{include:['src/**/*.test.ts']}})")
writeFileSync(join(project,'xaventra.config.example.json'),'{}')
writeFileSync(join(project,'src/original.test.ts'),`import {it,expect} from 'vitest'; import {value} from './value.js'; it('original public answer',()=>expect(value).toBe(${desired}));`)
writeFileSync(join(project,'src/control.test.ts'),"import {it,expect} from 'vitest'; import {value} from './value.js'; it('finite result',()=>expect(Number.isInteger(value)).toBe(true));")
const git=args=>execFileSync('git',args,{cwd:project,encoding:'utf8'})
git(['init','-q']);git(['add','.']);git(['-c','user.name=Repair QA','-c','user.email=qa@example.invalid','commit','-qm','Disposable baseline'])
const {localDockerRepairEngine,DockerRepairDriver,dockerRepairConfigHash}=await load('doctor/docker-repair-driver.js')
const {repairHash,signRepairValue,verifyRepairValue}=await load('doctor/repair-activation.js')
const {createRepairControllerServer,createHttpRepairProbe}=await load('doctor/repair-controller-server.js')
const engine=localDockerRepairEngine(), created=[], images=[]
const keys=()=>{const pair=generateKeyPairSync('ed25519');return {private:pair.privateKey.export({format:'pem',type:'pkcs8'}),public:pair.publicKey.export({format:'pem',type:'spki'})}}
const approval=keys(),receipt=keys(),publisher=keys(),authorityKey=keys()
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r))
let controller,authorityServer
const build=content=>{
  // Dockerfile FROM cannot use a local image-config digest directly. A unique
  // temporary local alias is checked before/after; layer ancestry is checked too.
  const alias=`xaventra-qa-base:${randomUUID()}`
  const info=id=>JSON.parse(execFileSync('docker',['image','inspect',id],{encoding:'utf8'}))[0]
  const base=info(image);assert.equal(base.Id,image)
  execFileSync('docker',['tag',image,alias]);assert.equal(info(alias).Id,image)
  const context=mkdtempSync(join(root,'image-'));writeFileSync(join(context,'value.mjs'),content)
  writeFileSync(join(context,'server.mjs'),"import http from 'node:http';import {value} from './value.mjs';const server=http.createServer((req,res)=>res.end(req.url==='/ready'?'ready':String(value))).listen(8080,'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>process.exit(0)))")
  writeFileSync(join(context,'Dockerfile'),`FROM ${alias}\nWORKDIR /app\nCOPY value.mjs server.mjs ./\nUSER 1000:1000\nENTRYPOINT ["/usr/local/bin/node","/app/server.mjs"]\n`)
  {
    const idfile=join(context,'iid');execFileSync('docker',['build','--pull=false','--network=none','--iidfile',idfile,context],{timeout:120_000,stdio:'pipe'})
    const id=readFileSync(idfile,'utf8').trim();assert.equal(info(alias).Id,image)
    assert.deepEqual(info(id).RootFS.Layers.slice(0,base.RootFS.Layers.length),base.RootFS.Layers)
    images.push(id);return id
  } // Retain the alias with evidence: removing its last tag can delete the
    // dependency image still needed by the subsequent sandbox phases.
}
const create=async(imageId)=>{
  const result=await engine.call('POST',`/containers/create?name=xaventra-repair-qa-${randomUUID()}`,{
    Image:imageId,User:'1000:1000',Entrypoint:['/usr/local/bin/node'],Cmd:['/app/server.mjs'],Env:['PATH=/usr/local/bin:/usr/bin:/bin'],
    ExposedPorts:{'8080/tcp':{}},Labels:{'xaventra.repair-qa':root},
    Healthcheck:{Test:['CMD','/usr/local/bin/node','-e',"fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],Interval:1_000_000_000,Timeout:1_000_000_000,Retries:10},
    HostConfig:{ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Memory:256*1024*1024,NanoCpus:1_000_000_000,PidsLimit:32,
      NetworkMode:'bridge',RestartPolicy:{Name:'no'},LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}},
      PortBindings:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:String(port)}]}}})
  created.push(result.Id)
  const inspected=await engine.call('GET',`/containers/${result.Id}/json`)
  writeFileSync(join(root,`${result.Id}-created.json`),JSON.stringify(inspected,null,2))
  return inspected
}
try{
  const old=await create(build(original));await engine.call('POST',`/containers/${old.Id}/start`)
  const endpoint=`http://127.0.0.1:${port}/answer`
  for(let i=0;i<100;i++){try{if(await(await fetch(endpoint)).text()==='1')break}catch{}await new Promise(r=>setTimeout(r,100))}
  assert.equal(await(await fetch(endpoint)).text(),'1')
  const {getToolRegistry}=await load('tools/complete-registry.js'),registry=getToolRegistry(),health=registry.get('health_status')
  registry.register({...health,description:'Read-only diagnostic of the isolated HTTP answer service: fetches its actual response and reports the required value from its immutable acceptance contract. Does not return RAM/disk metrics or mutate anything.',
    handler:async()=>({success:true,output:JSON.stringify({observed:Number(await(await fetch(endpoint)).text()),expected:desired,operation:'GET /answer',contractSource:'immutable acceptance test',scope:'disposable acceptance fixture'})})})
  const {getLifecyclePolicy}=await load('core/lifecycle-policy.js')
  getLifecyclePolicy().register({id:'repair-qa-diagnostics-only',event:'tool.before',priority:-2000,handler:p=>['health_status','read_file'].includes(p.toolName)?undefined:{decision:'deny',reason:'Fixture allows only observed HTTP and profile-bound source diagnostics'}})
  let turns=0
  const scripted={modelId:'scripted-fixture',complete:async()=>++turns%2?{content:'',toolCalls:[{name:'health_status',arguments:{}},...(turns===3?[{name:'read_file',arguments:{path:join(project,'src/value.ts')}},{name:'read_file',arguments:{path:join(project,'src/original.test.ts')}}]:[])]}:
    {content:turns===2?`GET /answer returns 1 but independently required value is ${desired}. Repair the source constant, then repeat the same request.`:
      JSON.stringify({description:'Correct the observed answer',search:original,replace:`export const value = ${desired};`,reason:'Match observed operation contract'})}}
  const llm=process.env.XAVENTRA_RESEARCH_QA_URL?await(await load('llm/nova-llm-sdk.js')).createNovaLLMClient({provider:'local',model:process.env.XAVENTRA_RESEARCH_QA_MODEL||'qwen',baseUrl:process.env.XAVENTRA_RESEARCH_QA_URL,isolated:true}):scripted
  const {FailureResearchCoordinator}=await load('doctor/failure-research-coordinator.js'),{createResearchWorker}=await load('doctor/research-worker.js')
  const coordinator=new FailureResearchCoordinator(join(root,'.nova-data/research.json'))
  coordinator.ingest({id:'answer-fault',title:'HTTP answer violates required value',detail:'Inspect health_status: actual HTTP result differs from expected operation contract. Find and test a source correction.',category:'health',severity:'critical',source:'disposable-fixture',recommendation:'Use current HTTP evidence',evidence:{},status:'open',createdAt:'',updatedAt:''})
  const worker=createResearchWorker(()=>true,llm,['health_status','read_file'])
  const finding=await coordinator.investigateNext(worker);assert.equal(finding?.investigation?.status,'verified')
  report.cases.push({id:'native-investigation-real-http',passed:true,runId:finding.investigation.runId})
  writeFileSync(join(root,'.nova-data/self-doctor/repair-profiles.json'),JSON.stringify([{id:'answer-source',findingId:'answer-fault',file:'src/value.ts',reproductionTest:'src/original.test.ts',probeId:'answer',targetId:'fixture'}]))
  const {proposeDoctorRepair,reconcileDoctorRepairs}=await load('doctor/repair-candidate.js')
  const {getPatchProposals,approveEvolutionProposal}=await load('synthesis/self-evolution.js')
  await proposeDoctorRepair(coordinator,worker)
  const item=coordinator.list()[0];assert.equal(item.repair?.status,'queued',JSON.stringify(item.repair))
  const proposal=getPatchProposals().find(p=>p.id===item.repair.proposalId)
  assert.equal(proposal.sandbox.verified,true);assert.equal(proposal.sandbox.reproductionPassed,true)
  assert.equal(proposal.sandbox.symptomVerified,false);assert.equal(readFileSync(join(project,'src/value.ts'),'utf8'),original)
  report.cases.push({id:'native-candidate-real-sandbox-immutable-oracle',passed:true,runId:item.repair.runId,proposalId:proposal.id,
    baselineHash:proposal.sandbox.baselineHash,candidateHash:proposal.sandbox.candidateHash})
  const denied=await approveEvolutionProposal(proposal.id,'not-the-approval');assert.equal(denied.success,false)
  assert.equal(await(await fetch(endpoint)).text(),'1');assert.equal(coordinator.list()[0].stage,'awaiting-patch-gate')
  report.cases.push({id:'no-activation-without-owner-gate',passed:true})
  const candidateContent=original.replace(proposal.search,proposal.replace),next=await create(build(candidateContent))
  const binding={proposalId:proposal.id,patchHash:proposal.patchHash,baselineHash:proposal.sandbox.baselineHash,candidateHash:proposal.sandbox.candidateHash,probeId:'answer',targetId:'fixture'}
  const entry=(id,info,sourceHash)=>({containerId:info.Id,configHash:dockerRepairConfigHash(info),release:{id,previousReleaseId:'old',sourceHash,imageId:info.Image,binding}})
  // Signing is performed by the trusted test publisher, never by the model.
  const deployment=verifyRepairValue(signRepairValue({targetId:'fixture',initialReleaseId:'old',releases:{old:entry('old',old,binding.baselineHash),next:entry('next',next,binding.candidateHash)},catalog:{[binding.candidateHash]:'next'}},publisher.private),publisher.public)
  const {createRepairAuthorityServer}=await load('doctor/repair-authority-server.js')
  const {repairRpc}=await load('doctor/repair-activation.js'),grants=new Map()
  authorityServer=createRepairAuthorityServer({privateKey:authorityKey.private,readGrant:hash=>grants.get(hash),
    readLease:async()=>({holderNodeId:'fixture-main',epoch:1,expiresAt:Date.now()+60_000})})
  await new Promise(r=>authorityServer.listen(0,'127.0.0.1',r))
  const hasAuthority=async ticket=>{
    const challenge=randomUUID(),decision=await repairRpc(`http://127.0.0.1:${authorityServer.address().port}/authority`,{challenge,ticket},authorityKey.public)
    return decision.allowed===true&&decision.challenge===challenge&&decision.bindingHash===repairHash(ticket)&&decision.expiresAt>Date.now()
  }
  const trialTicket={...binding,attemptId:`repair-${randomUUID()}`,expiresAt:Date.now()+60_000}
  assert.equal(await hasAuthority(trialTicket),false)
  grants.set(binding.patchHash,{binding,expiresAt:Date.now()+5*60_000,holderNodeId:'fixture-main',leaseEpoch:1})
  assert.equal(await hasAuthority(trialTicket),true)
  report.cases.push({id:'separate-signed-authority-requires-exact-operator-grant',passed:true})
  let state
  const driver=new DockerRepairDriver({...deployment,hasAuthority,loadState:()=>state,saveState:value=>{state=value;writeFileSync(join(root,'controller-state.json'),JSON.stringify(value))}},engine)
  const probe=createHttpRepairProbe([{id:'answer',targetId:'fixture',url:endpoint,expectedStatus:200,expectedBodySha256:createHash('sha256').update(String(desired)).digest('hex')}],driver)
  controller=createRepairControllerServer({stateRoot:join(root,'controller'),approvalPublicKey:approval.public,receiptPrivateKey:receipt.private,driver,probe})
  await new Promise(r=>controller.listen(0,'127.0.0.1',r))
  Object.assign(process.env,{NOVA_PATCH_GATE_TOKEN:randomUUID(),XAVENTRA_REPAIR_APPROVAL_PRIVATE_KEY:approval.private,XAVENTRA_REPAIR_CONTROLLER_PUBLIC_KEY:receipt.public,XAVENTRA_REPAIR_CONTROLLER_URL:`http://127.0.0.1:${controller.address().port}/repair`})
  const applied=await approveEvolutionProposal(proposal.id,process.env.NOVA_PATCH_GATE_TOKEN)
  assert.equal(applied.success,true,JSON.stringify(applied));reconcileDoctorRepairs(coordinator)
  const activated=getPatchProposals().find(p=>p.id===proposal.id)
  assert.equal(activated.activation.before.state,'fault');assert.equal(activated.activation.after.state,'healthy')
  assert.equal(coordinator.list()[0].stage,'resolved');assert.equal(await(await fetch(endpoint)).text(),String(desired))
  assert.equal((await engine.call('GET',`/containers/${old.Id}/json`)).State.Running,false)
  report.cases.push({id:'signed-docker-activation-original-http-recovery-case-resolution',passed:true,attemptId:applied.attemptId})
  // A second approval cannot silently execute the same patch again.
  assert.equal((await approveEvolutionProposal(proposal.id,process.env.NOVA_PATCH_GATE_TOKEN)).success,false)
  assert.equal(readFileSync(join(project,'src/value.ts'),'utf8'),original)
  report.cases.push({id:'no-double-activation-source-unchanged',passed:true})
  await new Promise(r=>controller.close(r));controller=undefined
  const bad=await create(build('export const value = 0;'))
  const badBinding={...binding,proposalId:'negative-control',patchHash:repairHash('negative-control'),baselineHash:binding.candidateHash,candidateHash:repairHash('intentionally-bad-candidate')}
  grants.set(badBinding.patchHash,{binding:badBinding,expiresAt:Date.now()+5*60_000,holderNodeId:'fixture-main',leaseEpoch:1})
  const badRelease=entry('bad',bad,badBinding.candidateHash);badRelease.release.previousReleaseId='next';badRelease.release.binding=badBinding
  const rollbackDriver=new DockerRepairDriver({targetId:'fixture',initialReleaseId:'next',releases:{next:deployment.releases.next,bad:badRelease},catalog:{[badBinding.candidateHash]:'bad'},
    hasAuthority,loadState:()=>undefined,saveState:value=>writeFileSync(join(root,'negative-controller-state.json'),JSON.stringify(value))},engine)
  const {RepairActivationController}=await load('doctor/repair-activation.js')
  const negativeProbe=createHttpRepairProbe([{id:'answer',targetId:'fixture',url:endpoint,expectedStatus:200,expectedBodySha256:createHash('sha256').update(String(desired+1)).digest('hex')}],rollbackDriver)
  const negative=new RepairActivationController(join(root,'negative-controller'),approval.public,rollbackDriver,negativeProbe)
  const rolledBack=await negative.activate(signRepairValue({...badBinding,attemptId:`repair-${randomUUID()}`,expiresAt:Date.now()+60_000},approval.private))
  assert.equal(rolledBack.status,'rolled-back',JSON.stringify(rolledBack))
  assert.equal(rolledBack.before.fingerprint,rolledBack.restoration.fingerprint)
  assert.equal(await(await fetch(endpoint)).text(),String(desired))
  assert.equal((await engine.call('GET',`/containers/${bad.Id}/json`)).State.Running,false)
  report.cases.push({id:'bad-candidate-actual-docker-rollback-original-operation-restored',passed:true})
}catch(error){report.cases.push({id:'end-to-end-failure',passed:false,error:String(error)});process.exitCode=1}
finally{
  if(controller)await new Promise(r=>controller.close(r))
  if(authorityServer)await new Promise(r=>authorityServer.close(r))
  // Only IDs returned by this fixture are eligible for removal, never labels or
  // name patterns that could select an unrelated runtime. No volume removal.
  for(const id of created)try{writeFileSync(join(root,`${id}-final.json`),JSON.stringify(await engine.call('GET',`/containers/${id}/json`),null,2));await engine.call('DELETE',`/containers/${id}?force=true`)}catch(error){report.cases.push({id:'fixture-cleanup',passed:false,error:String(error)});process.exitCode=1}
  report.completedAt=new Date().toISOString();report.fixtureRoot=root
  writeFileSync(join(reportDir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}
