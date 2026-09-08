// Install outside runtime mounts. This process owns the release key; candidate
// compilation never sees this process environment, source store or signing key.
import { readProtectedControllerFile as read, protectControllerDirectory } from '../dist/doctor/repair-controller-files.js'
import { RepairPublication } from '../dist/doctor/repair-publication.js'
import { createDockerRepairBuilder } from '../dist/doctor/docker-repair-builder.js'
import { createPublishedRepairContainer } from '../dist/doctor/docker-repair-publication.js'
import { localDockerRepairEngine } from '../dist/doctor/docker-repair-driver.js'
import { verifyRepairValue, signRepairValue, repairHash } from '../dist/doctor/repair-activation.js'
import { atomicWriteJsonSync } from '../dist/core/atomic-storage.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const config=JSON.parse(read(process.argv[2]||'',true)),operation=process.argv[3]
for(const path of [config.root,config.stagingRoot])protectControllerDirectory(path)
const signingPrivateKey=read(config.signingPrivateKeyFile,true),signingPublicKey=read(config.signingPublicKeyFile)
process.env.XAVENTRA_REPAIR_SANDBOX_IMAGE=config.imageId
const publication=new RepairPublication({root:config.root,signingPrivateKey,signingPublicKey,receiptPublicKey:read(config.receiptPublicKeyFile),profiles:config.profiles,
  builder:createDockerRepairBuilder({imageId:config.imageId,stagingRoot:config.stagingRoot})})
if(operation==='enroll'){
  protectControllerDirectory(config.initialSourceRoot)
  publication.enroll(config.initialSourceRoot,config.initialReleaseId)
  console.log(JSON.stringify({enrolled:true}))
}else if(operation==='publish'){
  const request=JSON.parse(read(process.argv[4]||'',true))
  const ticket=verifyRepairValue(request.authorization,read(config.approvalPublicKeyFile))
  if(ticket.expiresAt<=Date.now()||ticket.expiresAt>Date.now()+600_000)throw Error('Publication approval expired')
  const {attemptId,expiresAt,...binding}=ticket
  const signed=await publication.publish(binding,request.patch),artifact=verifyRepairValue(signed,signingPublicKey)
  const preparedFile=join(config.root,`prepared-${repairHash(binding)}.json`)
  if(existsSync(preparedFile)){
    const prepared=JSON.parse(read(preparedFile));verifyRepairValue(prepared,signingPublicKey);console.log(JSON.stringify(prepared))
  }else{
    // Publication and container preparation are separate crash domains. Refuse
    // repeating an ambiguous Engine create after interruption.
    const {mkdirSync,rmdirSync}=await import('node:fs'),lock=join(config.root,'container-publication.lock');mkdirSync(lock)
    const registration=await createPublishedRepairContainer(localDockerRepairEngine(config.dockerSocket),artifact,JSON.parse(read(config.candidateTemplateFile,true)))
    const prepared=signRepairValue(registration,signingPrivateKey)
    atomicWriteJsonSync(preparedFile,prepared);rmdirSync(lock)
    console.log(JSON.stringify(prepared))
  }
}else if(operation==='commit-source'){
  publication.commitSource(JSON.parse(read(process.argv[4]||'',true)))
  console.log(JSON.stringify({sourceAdvanced:true}))
}else throw Error('Explicit enroll, publish or commit-source operation required')
