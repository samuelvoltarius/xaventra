// Explicit operator entrypoint. Install this supervisor outside all candidate
// release trees. The optional separate publisher builds/signs releases. Neither
// component auto-adopts a service manager or infers a complete writer inventory.
import { randomUUID } from 'node:crypto'
import { ManagedRepairDriver } from '../dist/doctor/managed-repair-driver.js'
import { DockerRepairDriver, localDockerRepairEngine } from '../dist/doctor/docker-repair-driver.js'
import { createDockerRepairStateCloner } from '../dist/doctor/docker-repair-state.js'
import { verifyRepairValue, repairHash } from '../dist/doctor/repair-activation.js'
import { atomicWriteJsonSync } from '../dist/core/atomic-storage.js'
import { existsSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRepairControllerServer, createHttpRepairProbe } from '../dist/doctor/repair-controller-server.js'
import { repairRpc } from '../dist/doctor/repair-activation.js'
import { RepairDrainClient } from '../dist/doctor/repair-drain-client.js'
import { setTimeout as delay } from 'node:timers/promises'
import { RepairWriterBarrier } from '../dist/doctor/repair-writers.js'
import { readProtectedControllerFile as readProtected, protectControllerDirectory } from '../dist/doctor/repair-controller-files.js'

const config=JSON.parse(readProtected(process.argv[2]||'',true))
if(config.writerHosts&&!config.drainUrl)throw Error('Writer barrier requires independent tool drain')
if(config.publisherConfigFile&&(config.driver!=='docker'||!config.writerHosts||!config.drainUrl||!config.stateHelperImageId))
  throw Error('Automatic publication requires Docker, complete writer barrier, drain and state cloner')
protectControllerDirectory(config.stateRoot)
if(!Number.isInteger(config.port)||config.port<1024||config.port>65535) throw new Error('Explicit controller port required')
const approvalPublicKey=readProtected(config.approvalPublicKeyFile)
const receiptPrivateKey=readProtected(config.receiptPrivateKeyFile,true)
const releasePublicKey=readProtected(config.releasePublicKeyFile)
const authorityPublicKey=readProtected(config.authorityPublicKeyFile)
const publisher=async(operation,body)=>{
  readProtected(config.publisherConfigFile,true)
  const entry=join(import.meta.dirname,'repair-publisher.mjs');readProtected(entry)
  const requestFile=join(config.stateRoot,`publisher-request-${randomUUID()}.json`)
  atomicWriteJsonSync(requestFile,body);chmodSync(requestFile,0o600)
  const {stdout}=await promisify(execFile)(process.execPath,[entry,config.publisherConfigFile,operation,requestFile],{
    windowsHide:true,timeout:600_000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,HOME:process.env.HOME}})
  return JSON.parse(stdout)
}
const hasAuthority=async ticket=>{
  const challenge=randomUUID()
  const decision=await repairRpc(config.authorityUrl,{challenge,ticket},authorityPublicKey)
  return decision.allowed===true&&decision.challenge===challenge&&decision.targetId===ticket.targetId&&decision.patchHash===ticket.patchHash
    &&decision.bindingHash===repairHash(ticket)&&decision.expiresAt>Date.now()&&decision.expiresAt<Date.now()+60_000
}
let driver
let writerBarrier
let targetContainerIds=[]
let writerQuiescence
let publicationDeployment
const loadWriterBarrier=(ticket,hosts)=>new RepairWriterBarrier({root:join(config.stateRoot,ticket.attemptId+'-writers'),requiredHosts:config.requiredWriterHosts,
  hosts:hosts.map(h=>({...h,engine:localDockerRepairEngine(h.socketPath)})),externalSinks:config.externalWriterSinks,
  hasAuthority,toolDrain:async t=>{const s=await drain.request('status',t);return s.bindingHash===repairHash(t)&&s.toolActionsDrained===true},
  sinkFenced:async(sink,t)=>{
    const profile=config.sinkFenceProfiles?.[sink];if(!profile)return false
    const challenge=randomUUID(),proof=await repairRpc(profile.url,{challenge,ticket:t},readProtected(profile.publicKeyFile))
    return proof.challenge===challenge&&proof.bindingHash===repairHash(t)&&proof.sink===sink&&proof.writesFenced===true
      &&Number.isFinite(proof.expiresAt)&&proof.expiresAt>Date.now()&&proof.expiresAt<Date.now()+10_000
  }})
if(config.driver==='docker'){
  const engine=localDockerRepairEngine(config.dockerSocket)
  protectControllerDirectory(dirname(config.stateFile))
  const deployment=verifyRepairValue(JSON.parse(readProtected(config.dockerDeploymentFile)),releasePublicKey)
  if(deployment.targetId!==config.targetId) throw new Error('Signed Docker deployment target mismatch')
  publicationDeployment=deployment
  const registrationsFile=join(config.stateRoot,'published-registrations.json')
  const registrations=existsSync(registrationsFile)?JSON.parse(readProtected(registrationsFile)):{}
  for(const envelope of Object.values(registrations)){
    const r=verifyRepairValue(envelope,releasePublicKey)
    if(r.release.binding.targetId!==config.targetId)throw Error('Published target mismatch')
    deployment.releases[r.release.id]=r;deployment.catalog[r.release.sourceHash]=r.release.id
  }
  targetContainerIds=Object.values(deployment.releases).map(r=>r.containerId)
  const prepareRelease=config.publisherConfigFile?async(ticket,preparation)=>{
    if(!preparation?.authorization||repairHash(verifyRepairValue(preparation.authorization,approvalPublicKey))!==repairHash(ticket))throw Error('Publication ticket differs from activation')
    const signed=await publisher('publish',preparation),r=verifyRepairValue(signed,releasePublicKey)
    registrations[ticket.candidateHash]=signed;atomicWriteJsonSync(registrationsFile,registrations)
    deployment.releases[r.release.id]=r;deployment.catalog[r.release.sourceHash]=r.release.id
    targetContainerIds.push(r.containerId);return r
  }:undefined
  const stateReady=(config.stateAuthorityUrl||config.writerHosts)&&config.stateHelperImageId?createDockerRepairStateCloner({engine,helperImageId:config.stateHelperImageId,quiescent:async ticket=>{
    const challenge=randomUUID()
    if(writerQuiescence)return writerQuiescence(ticket)
    const decision=await repairRpc(config.stateAuthorityUrl,{challenge,ticket},authorityPublicKey)
    return decision.allowed===true&&decision.challenge===challenge&&decision.bindingHash===repairHash(ticket)
      &&decision.externalWritersQuiesced===true&&decision.expiresAt>Date.now()&&decision.expiresAt<Date.now()+60_000
  }}):undefined
  driver=new DockerRepairDriver({...deployment,hasAuthority,stateReady,prepareRelease,
    loadState:()=>existsSync(config.stateFile)?JSON.parse(readProtected(config.stateFile)):undefined,
    saveState:state=>atomicWriteJsonSync(config.stateFile,state)},engine)
}else if(!config.driver||config.driver==='managed')driver=new ManagedRepairDriver({...config,releasePublicKey,hasAuthority})
else throw new Error('Unknown repair deployment adapter')
const drain=config.drainUrl?new RepairDrainClient({url:config.drainUrl,actor:'operator',
  privateKey:readProtected(config.drainOperatorPrivateKeyFile,true),authorityPublicKey:readProtected(config.drainAuthorityPublicKeyFile)}):undefined
if(drain) driver.beginMaintenance=async ticket=>{
  await drain.request('begin',ticket)
  const deadline=Math.min(Date.now()+30_000,ticket.expiresAt)
  do {
    const status=await drain.request('status',ticket)
    if(status.bindingHash===repairHash(ticket)&&status.toolActionsDrained===true) {
      if(config.writerHosts){
        const active=publicationDeployment.releases[await driver.currentRelease(config.targetId)]
        const candidate=publicationDeployment.releases[publicationDeployment.catalog[ticket.candidateHash]]
        const hosts=structuredClone(config.writerHosts)
        for(const host of hosts){
          const engine=localDockerRepairEngine(host.socketPath)
          if(host.members.some(m=>targetContainerIds.includes(m.containerId))){
            host.members=host.members.map(m=>targetContainerIds.includes(m.containerId)?{containerId:active.containerId,configHash:active.configHash}:m)
            host.staged=[{containerId:candidate.containerId,configHash:candidate.configHash}]
            const old=await engine.call('GET',`/containers/${active.containerId}/json`)
            host.preserveSources=(old.Mounts||[]).filter(m=>m.RW&&m.Type!=='tmpfs').map(m=>m.Source)
          }
          for(const member of [...host.members,...(host.staged||[])]){
            const info=await engine.call('GET',`/containers/${member.containerId}/json`)
            host.protectedSources=[...new Set([...host.protectedSources,...(info.Mounts||[]).filter(m=>m.RW&&m.Type!=='tmpfs').map(m=>m.Source)])]
          }
        }
        atomicWriteJsonSync(join(config.stateRoot,`writer-inventory-${ticket.attemptId}.json`),hosts)
        writerBarrier=loadWriterBarrier(ticket,hosts)
        await writerBarrier.halt(ticket);writerQuiescence=t=>writerBarrier.quiescent(t)
      }
      return
    }
    if(status.uncertain>0) throw new Error('Uncertain actions require independent operator reconciliation')
    await delay(250)
  } while(Date.now()<deadline)
  throw new Error('Tool drain incomplete; maintenance remains closed')
}
const server=createRepairControllerServer({stateRoot:config.stateRoot,approvalPublicKey,receiptPrivateKey,driver,probe:createHttpRepairProbe(config.probes,driver),
  onVerifiedReceipt:drain||config.publisherConfigFile?async receipt=>{
    if(config.publisherConfigFile&&receipt.payload.status==='resolved')await publisher('commit-source',receipt)
    // A status request may reconcile an older attempt while another barrier is
    // current. Never borrow the current transaction's writer inventory.
    if(config.writerHosts){
      const completedBarrier=loadWriterBarrier(receipt.payload.binding,JSON.parse(readProtected(join(config.stateRoot,`writer-inventory-${receipt.payload.binding.attemptId}.json`))))
      await completedBarrier.resumePeers(receipt.payload.binding,targetContainerIds,receipt.payload.status==='rolled-back')
    }
    if(drain)await drain.request('release',{ticket:receipt.payload.binding,receipt})
  }:undefined})
server.listen(config.port,'127.0.0.1',()=>console.log('Xaventra repair controller ready on configured loopback port'))
// Expose remotely only behind an operator-managed authenticated HTTPS gateway.
