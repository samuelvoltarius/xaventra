import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { repairHash, repairRpc, signRepairValue } from '../dist/doctor/repair-activation.js'
import { createHttpRepairProbe, createRepairControllerServer } from '../dist/doctor/repair-controller-server.js'

const source=resolve(import.meta.dirname,'..'), root=mkdtempSync(join(tmpdir(),'xaventra-activation-'))
const report={version:JSON.parse(readFileSync(join(source,'package.json'))).version,sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),
  sourceDirty:!!execFileSync('git',['status','--porcelain'],{cwd:source,encoding:'utf8'}).trim(),platform:process.platform,
  evidenceClass:'real-http-signed-controller-independent-parent-oracle-real-disposable-child; fixture-deployment-adapter; no-production-or-model',cases:[]}
const key=()=>{const k=generateKeyPairSync('ed25519');return {privateKey:k.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKey:k.publicKey.export({type:'spki',format:'pem'}).toString()}}
const approval=key(),receipt=key()
const fixture=join(root,'runtime.cjs')
writeFileSync(fixture,`const http=require('node:http'); const server=http.createServer((q,s)=>s.end(process.argv[2]));server.listen(Number(process.argv[3]),'127.0.0.1',()=>process.send({port:server.address().port}));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`)
let child,port=0,current='old',candidateAnswer='42',activations=0
async function stop(){ if(!child)return;const c=child;child=undefined;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned child did not exit')),5000);c.once('exit',()=>{clearTimeout(timer);resolve()});c.kill('SIGTERM')}) }
async function start(answer){ child=fork(fixture,[answer,String(port)],{env:{},execArgv:[],stdio:['ignore','ignore','ignore','ipc']});port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('message',m=>resolve(m.port))}) }
const binding={proposalId:'fixture-patch',patchHash:repairHash('patch'),baselineHash:repairHash('old'),candidateHash:repairHash('new'),probeId:'exact-answer',targetId:'disposable-runtime'}
const driver={hasAuthority:async()=>true,prepare:async()=>({binding,releaseId:'new',previousReleaseId:'old'}),
  activate:async()=>{activations++;await stop();await start(candidateAnswer);current='new'},rollback:async()=>{await stop();await start('41');current='old'},currentRelease:async()=>current}
let controller
try {
  await start('41')
  const probe=createHttpRepairProbe([{id:binding.probeId,targetId:binding.targetId,url:`http://127.0.0.1:${port}`,expectedStatus:200,expectedBodySha256:createHash('sha256').update('42').digest('hex')}],driver)
  controller=createRepairControllerServer({stateRoot:join(root,'controller'),approvalPublicKey:approval.publicKey,receiptPrivateKey:receipt.privateKey,driver,probe})
  await new Promise(resolve=>controller.listen(0,'127.0.0.1',resolve))
  const url=`http://127.0.0.1:${controller.address().port}/repair`
  const ticket=()=>({...binding,attemptId:`repair-${randomUUID()}`,expiresAt:Date.now()+60_000})
  const first=ticket(),signed=signRepairValue(first,approval.privateKey)
  const result=await repairRpc(url,{operation:'activate',ticket:signed},receipt.publicKey)
  assert.equal(result.status,'resolved');assert.equal(result.before.state,'fault');assert.equal(result.after.state,'healthy')
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'42')
  report.cases.push({id:'actual-child-upgrade-original-http-predicate',passed:true})
  const replay=await repairRpc(url,{operation:'activate',ticket:signed},receipt.publicKey);assert.equal(replay.status,'resolved');assert.equal(activations,1)
  report.cases.push({id:'signed-idempotent-replay',passed:true})
  signed.payload.patchHash=repairHash('tampered')
  await assert.rejects(()=>repairRpc(url,{operation:'activate',ticket:signed},receipt.publicKey));assert.equal(activations,1)
  report.cases.push({id:'tampered-approval-no-action',passed:true})
  await stop();await start('41');current='old';candidateAnswer='41'
  const failed=await repairRpc(url,{operation:'activate',ticket:signRepairValue(ticket(),approval.privateKey)},receipt.publicKey)
  assert.equal(failed.status,'rolled-back');assert.equal(failed.after.state,'fault');assert.equal(failed.restoration.fingerprint,failed.before.fingerprint)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'41')
  report.cases.push({id:'bad-candidate-real-rollback-and-restoration',passed:true})
}catch(error){report.cases.push({id:'activation-acceptance',passed:false,error:String(error)});process.exitCode=1}
finally{await stop();if(controller)await new Promise(resolve=>controller.close(resolve));const output=resolve(process.env.XAVENTRA_REPAIR_QA_DIR||join(source,'.nova-data','repair-qa'));mkdirSync(output,{recursive:true});writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))}
