// CI only: real privileged controller / non-root disposable runtimes. No service
// manager, deployment configuration, production data or network credentials.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chownSync, chmodSync, copyFileSync, lstatSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { ManagedRepairDriver } from '../dist/doctor/managed-repair-driver.js'
import { RepairActivationController, repairHash, signRepairValue } from '../dist/doctor/repair-activation.js'
import { createHttpRepairProbe } from '../dist/doctor/repair-controller-server.js'
import { stopLocalDaemon } from '../dist/process/daemon-control.js'

if(process.platform!=='linux'||process.getuid()!==0)throw new Error('Run only in disposable Linux CI as root')
process.umask(0o022)
function protectedBase(base){try{let path=base;while(true){const s=lstatSync(path);if(s.uid!==0||(s.mode&0o022)||(s.mode&0o001)!==1)return false;const parent=dirname(path);if(path===parent)return true;path=parent}}catch{return false}}
const base=['/srv','/var/lib','/usr/local/share','/usr/local/lib'].find(protectedBase)
if(!base)throw new Error('Disposable CI host has no protected root-owned fixture base')
const source=resolve(import.meta.dirname,'..'),root=mkdtempSync(join(base,'xaventra-repair-qa-'))
chmodSync(root,0o755) // Public source paths must be traversable by the separate runtime UID.
const nodeExecutable=join(root,'node');copyFileSync(process.execPath,nodeExecutable);chownSync(nodeExecutable,0,0);chmodSync(nodeExecutable,0o755)
assert.equal(lstatSync(nodeExecutable).uid,0,'Fixture Node binary must actually be root-owned after copying')
const stateRoot=join(root,'state'),runtimeRoot=join(root,'runtime'),releasesRoot=join(root,'releases')
for(const path of [stateRoot,runtimeRoot,releasesRoot])mkdirSync(path)
chownSync(runtimeRoot,65534,65534)
const marker=join(stateRoot,'host-canary');writeFileSync(marker,'unchanged')
const report={sourceRevision:execFileSync('git',['-c',`safe.directory=${source}`,'rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),platform:process.platform,
  sourceDirty:!!execFileSync('git',['-c',`safe.directory=${source}`,'status','--porcelain'],{cwd:source,encoding:'utf8'}).trim(),version:JSON.parse(readFileSync(join(source,'package.json'))).version,
  evidenceClass:'actual-Linux-root-controller-nonroot-managed-process-signed-release-independent-http-oracle',cases:[]}
const key=()=>{const k=generateKeyPairSync('ed25519');return {privateKey:k.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKey:k.publicKey.export({type:'spki',format:'pem'}).toString()}}
const releaseKey=key(),approval=key()
const hash=content=>createHash('sha256').update(content).digest('hex')
const binding={proposalId:'fixture-managed',patchHash:repairHash('patch'),baselineHash:repairHash('old'),candidateHash:repairHash('new'),probeId:'answer',targetId:'managed-fixture'}
const code=value=>`const http=require('node:http'),fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const root=fs.realpathSync(process.cwd()),id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
try{fs.writeFileSync(process.env.HOST_CANARY,'damaged')}catch{}
const health=http.createServer((q,s)=>s.end('${value}'));
const control=http.createServer((q,s)=>{if(q.headers.authorization!=='Bearer '+token||q.url!=='/stop/'+id||q.headers['x-xaventra-pid']!==String(process.pid)){s.writeHead(403).end();return}s.setHeader('connection','close');s.end(JSON.stringify({instanceId:id,pid:process.pid,status:'stopping'}));s.once('finish',stop)});
function stop(){health.close(()=>control.close(()=>{try{fs.unlinkSync('.nova-data/daemon-control.json');fs.unlinkSync('.nova.pid')}catch{};process.exit(0)}))}
process.on('SIGTERM',stop);health.listen(Number(process.env.PORT),'127.0.0.1',()=>control.listen(0,'127.0.0.1',()=>{fs.mkdirSync('.nova-data',{recursive:true});fs.writeFileSync('.nova.pid',String(process.pid));fs.writeFileSync('.nova-data/daemon-control.json',JSON.stringify({version:1,root,pid:process.pid,instanceId:id,token,port:control.address().port}));}));`
for(const [id,value] of [['old','41'],['new','42'],['bad','41']]){
  mkdirSync(join(releasesRoot,id,'dist'),{recursive:true});const content=code(value)
  writeFileSync(join(releasesRoot,id,'dist/daemon.js'),content)
  writeFileSync(join(releasesRoot,id,'repair-release.json'),JSON.stringify(signRepairValue({id,binding,sourceHash:id==='old'?binding.baselineHash:binding.candidateHash,previousReleaseId:'old',files:[{path:'dist/daemon.js',sha256:hash(content)}]},releaseKey.privateKey)))
}
writeFileSync(join(releasesRoot,'catalog.json'),JSON.stringify({[binding.candidateHash]:'new'}))
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve))
const env={PORT:String(port),HOST_CANARY:marker,HOME:runtimeRoot}
let initial
async function startOld(){initial=spawn(nodeExecutable,[join(releasesRoot,'old/dist/daemon.js')],{cwd:runtimeRoot,env,uid:65534,gid:65534,stdio:'ignore'});await new Promise((resolve,reject)=>{initial.once('spawn',resolve);initial.once('error',reject)});for(let i=0;i<100;i++){try{if(JSON.parse(readFileSync(join(runtimeRoot,'.nova-data/daemon-control.json'))).pid===initial.pid&&(await fetch(`http://127.0.0.1:${port}`)).ok)return}catch{};await new Promise(r=>setTimeout(r,50))}throw new Error('Fixture did not become healthy')}
const ticket=()=>({...binding,attemptId:`repair-${randomUUID()}`,expiresAt:Date.now()+120_000})
try{
  const driver=new ManagedRepairDriver({targetId:binding.targetId,releasesRoot,runtimeRoot,stateFile:join(stateRoot,'runtime.json'),releasePublicKey:releaseKey.publicKey,initialReleaseId:'old',runtimeUid:65534,runtimeGid:65534,runtimeEnv:env,nodeExecutable,hasAuthority:async()=>true})
  const controller=new RepairActivationController(join(stateRoot,'attempts'),approval.publicKey,driver,createHttpRepairProbe([{id:'answer',targetId:binding.targetId,url:`http://127.0.0.1:${port}`,expectedStatus:200,expectedBodySha256:hash('42')}],driver))
  await startOld()
  const first=await controller.activate(signRepairValue(ticket(),approval.privateKey))
  assert.equal(first.status,'resolved',JSON.stringify(first));assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'42')
  assert.equal(readFileSync(marker,'utf8'),'unchanged')
  report.cases.push({id:'signed-managed-upgrade-separate-uid-host-canary-protected',passed:true})
  // A second candidate built against pre-upgrade source must not discard A.
  const staleBinding={...binding,candidateHash:repairHash('stale-second-candidate')}
  mkdirSync(join(releasesRoot,'stale','dist'),{recursive:true});writeFileSync(join(releasesRoot,'stale/dist/daemon.js'),code('42'))
  writeFileSync(join(releasesRoot,'stale/repair-release.json'),JSON.stringify(signRepairValue({id:'stale',binding:staleBinding,sourceHash:staleBinding.candidateHash,previousReleaseId:'new',files:[{path:'dist/daemon.js',sha256:hash(code('42'))}]},releaseKey.privateKey)))
  writeFileSync(join(releasesRoot,'catalog.json'),JSON.stringify({[staleBinding.candidateHash]:'stale'}))
  const stale=await controller.activate(signRepairValue({...ticket(),...staleBinding},approval.privateKey));assert.equal(stale.status,'blocked');assert.match(stale.reason,/baseline/)
  assert.equal(await driver.currentRelease(binding.targetId),'new')
  report.cases.push({id:'stale-second-patch-cannot-discard-first-repair',passed:true})
  // Return to the original runtime through the same typed driver.
  await driver.rollback({binding,releaseId:'new',previousReleaseId:'old'},ticket())
  writeFileSync(join(releasesRoot,'catalog.json'),JSON.stringify({[binding.candidateHash]:'bad'}))
  const second=await controller.activate(signRepairValue(ticket(),approval.privateKey))
  assert.equal(second.status,'rolled-back',JSON.stringify(second));assert.equal(second.restoration.fingerprint,second.before.fingerprint)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'41')
  report.cases.push({id:'bad-managed-release-rollback-original-predicate-restored',passed:true})
  mkdirSync(join(releasesRoot,'crash','dist'),{recursive:true});const crashCode='throw new Error("fixture startup failure")'
  writeFileSync(join(releasesRoot,'crash/dist/daemon.js'),crashCode)
  writeFileSync(join(releasesRoot,'crash/repair-release.json'),JSON.stringify(signRepairValue({id:'crash',binding,sourceHash:binding.candidateHash,previousReleaseId:'old',files:[{path:'dist/daemon.js',sha256:hash(crashCode)}]},releaseKey.privateKey)))
  writeFileSync(join(releasesRoot,'catalog.json'),JSON.stringify({[binding.candidateHash]:'crash'}))
  const crashed=await controller.activate(signRepairValue(ticket(),approval.privateKey));assert.equal(crashed.status,'rolled-back',JSON.stringify(crashed))
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'41')
  report.cases.push({id:'startup-failure-restores-stopped-original-runtime',passed:true})
  writeFileSync(join(releasesRoot,'catalog.json'),JSON.stringify({[binding.candidateHash]:'bad'}))
  writeFileSync(join(releasesRoot,'bad/dist/daemon.js'),'throw new Error("tampered")')
  const third=await controller.activate(signRepairValue(ticket(),approval.privateKey));assert.equal(third.status,'blocked')
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'41')
  report.cases.push({id:'tampered-signed-release-no-runtime-change',passed:true})
}catch(error){report.cases.push({id:'managed-activation',passed:false,error:String(error)});process.exitCode=1}
finally{
  try{await stopLocalDaemon(runtimeRoot)}catch(error){report.cases.push({id:'owned-runtime-cleanup',passed:false,error:String(error)});process.exitCode=1}
  const output=join(source,'.nova-data','managed-repair-qa');mkdirSync(output,{recursive:true});writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}
