// Explicit operator entrypoint. Install this supervisor outside all candidate
// release trees. It does not build/sign releases or auto-adopt a service manager.
import { randomUUID } from 'node:crypto'
import { ManagedRepairDriver } from '../dist/doctor/managed-repair-driver.js'
import { DockerRepairDriver, localDockerRepairEngine } from '../dist/doctor/docker-repair-driver.js'
import { createDockerRepairStateCloner } from '../dist/doctor/docker-repair-state.js'
import { verifyRepairValue, repairHash } from '../dist/doctor/repair-activation.js'
import { atomicWriteJsonSync } from '../dist/core/atomic-storage.js'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRepairControllerServer, createHttpRepairProbe } from '../dist/doctor/repair-controller-server.js'
import { repairRpc } from '../dist/doctor/repair-activation.js'
import { readProtectedControllerFile as readProtected, protectControllerDirectory } from '../dist/doctor/repair-controller-files.js'

const config=JSON.parse(readProtected(process.argv[2]||'',true))
protectControllerDirectory(config.stateRoot)
if(!Number.isInteger(config.port)||config.port<1024||config.port>65535) throw new Error('Explicit controller port required')
const approvalPublicKey=readProtected(config.approvalPublicKeyFile)
const receiptPrivateKey=readProtected(config.receiptPrivateKeyFile,true)
const releasePublicKey=readProtected(config.releasePublicKeyFile)
const authorityPublicKey=readProtected(config.authorityPublicKeyFile)
const hasAuthority=async ticket=>{
  const challenge=randomUUID()
  const decision=await repairRpc(config.authorityUrl,{challenge,targetId:ticket.targetId,patchHash:ticket.patchHash},authorityPublicKey)
  return decision.allowed===true&&decision.challenge===challenge&&decision.targetId===ticket.targetId&&decision.patchHash===ticket.patchHash
    &&decision.expiresAt>Date.now()&&decision.expiresAt<Date.now()+60_000
}
let driver
if(config.driver==='docker'){
  const engine=localDockerRepairEngine(config.dockerSocket)
  protectControllerDirectory(dirname(config.stateFile))
  const deployment=verifyRepairValue(JSON.parse(readProtected(config.dockerDeploymentFile)),releasePublicKey)
  if(deployment.targetId!==config.targetId) throw new Error('Signed Docker deployment target mismatch')
  const stateReady=config.stateAuthorityUrl&&config.stateHelperImageId?createDockerRepairStateCloner({engine,helperImageId:config.stateHelperImageId,quiescent:async ticket=>{
    const challenge=randomUUID()
    const decision=await repairRpc(config.stateAuthorityUrl,{challenge,ticket},authorityPublicKey)
    return decision.allowed===true&&decision.challenge===challenge&&decision.bindingHash===repairHash(ticket)
      &&decision.externalWritersQuiesced===true&&decision.expiresAt>Date.now()&&decision.expiresAt<Date.now()+60_000
  }}):undefined
  driver=new DockerRepairDriver({...deployment,hasAuthority,stateReady,
    loadState:()=>existsSync(config.stateFile)?JSON.parse(readProtected(config.stateFile)):undefined,
    saveState:state=>atomicWriteJsonSync(config.stateFile,state)},engine)
}else if(!config.driver||config.driver==='managed')driver=new ManagedRepairDriver({...config,releasePublicKey,hasAuthority})
else throw new Error('Unknown repair deployment adapter')
const server=createRepairControllerServer({stateRoot:config.stateRoot,approvalPublicKey,receiptPrivateKey,driver,probe:createHttpRepairProbe(config.probes,driver)})
server.listen(config.port,'127.0.0.1',()=>console.log('Xaventra repair controller ready on configured loopback port'))
// Expose remotely only behind an operator-managed authenticated HTTPS gateway.
