// Explicit operator entrypoint. Install this supervisor outside all candidate
// release trees. It does not build/sign releases or auto-adopt a service manager.
import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ManagedRepairDriver } from '../dist/doctor/managed-repair-driver.js'
import { createRepairControllerServer, createHttpRepairProbe } from '../dist/doctor/repair-controller-server.js'
import { repairRpc } from '../dist/doctor/repair-activation.js'

function readProtected(path) {
  const full=resolve(path), stat=lstatSync(full)
  if(process.platform!=='linux'||process.getuid()!==0||realpathSync(full)!==full||stat.uid!==0||(stat.mode&0o022)||!stat.isFile()) throw new Error('Root-owned unlinked private controller configuration required')
  protectDirectory(dirname(full))
  return readFileSync(full,'utf8')
}
function protectDirectory(path){
  let cursor=resolve(path)
  if(realpathSync(cursor)!==cursor)throw new Error('Linked controller state directory')
  while(true){const stat=lstatSync(cursor);if(!stat.isDirectory()||stat.uid!==0||(stat.mode&0o022))throw new Error('Controller state and ancestors must be root-owned and runtime-nonwritable');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent}
}
const config=JSON.parse(readProtected(process.argv[2]||''))
protectDirectory(config.stateRoot)
if(!Number.isInteger(config.port)||config.port<1024||config.port>65535) throw new Error('Explicit controller port required')
const approvalPublicKey=readProtected(config.approvalPublicKeyFile)
const receiptPrivateKey=readProtected(config.receiptPrivateKeyFile)
const releasePublicKey=readProtected(config.releasePublicKeyFile)
const authorityPublicKey=readProtected(config.authorityPublicKeyFile)
const driver=new ManagedRepairDriver({...config,releasePublicKey,hasAuthority:async ticket=>{
  const challenge=randomUUID()
  const decision=await repairRpc(config.authorityUrl,{challenge,targetId:ticket.targetId,patchHash:ticket.patchHash},authorityPublicKey)
  return decision.allowed===true&&decision.challenge===challenge&&decision.targetId===ticket.targetId&&decision.patchHash===ticket.patchHash
    &&decision.expiresAt>Date.now()&&decision.expiresAt<Date.now()+60_000
}})
const server=createRepairControllerServer({stateRoot:config.stateRoot,approvalPublicKey,receiptPrivateKey,driver,probe:createHttpRepairProbe(config.probes,driver)})
server.listen(config.port,'127.0.0.1',()=>console.log('Xaventra repair controller ready on configured loopback port'))
// Expose remotely only behind an operator-managed authenticated HTTPS gateway.
