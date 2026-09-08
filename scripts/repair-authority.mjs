// Operator-installed, outside candidate mounts. Grants and keys are private.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createRepairAuthorityServer } from '../dist/doctor/repair-authority-server.js'
import { RepairDrainClient } from '../dist/doctor/repair-drain-client.js'
import { readProtectedControllerFile as read, protectControllerDirectory } from '../dist/doctor/repair-controller-files.js'

const config=JSON.parse(read(process.argv[2]||'',true))
protectControllerDirectory(config.grantsRoot)
if(!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw Error('Explicit authority port required')
const base=new URL(config.coordinatorRestUrl)
if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error('Pinned operator HTTPS coordinator required')
const apiKey=read(config.coordinatorKeyFile,true).trim()
const drain=config.drainUrl?new RepairDrainClient({url:config.drainUrl,actor:config.drainObserverId,
  privateKey:read(config.drainObserverPrivateKeyFile,true),authorityPublicKey:read(config.drainAuthorityPublicKeyFile)}):undefined
const server=createRepairAuthorityServer({privateKey:read(config.authorityPrivateKeyFile,true),readGrant:hash=>{
  const path=join(config.grantsRoot,`${hash}.json`)
  return existsSync(path)?JSON.parse(read(path,true)):undefined
},readToolDrain:drain?ticket=>drain.request('status',ticket):undefined,readLease:async()=>{
  const response=await fetch(`${base.href.replace(/\/$/,'')}/nova_mesh_leases?service=eq.nova-main&select=holder_node_id,epoch,expires_at&limit=2`,{
    headers:{apikey:apiKey,Authorization:`Bearer ${apiKey}`},redirect:'error',signal:AbortSignal.timeout(3000)})
  if(!response.ok)return undefined
  const chunks=[];let size=0
  if(!response.body)throw Error('Missing lease response')
  for await(const chunk of response.body){size+=chunk.length;if(size>8192)throw Error('Lease response exceeds budget');chunks.push(chunk)}
  const text=Buffer.concat(chunks).toString('utf8')
  const rows=JSON.parse(text);if(!Array.isArray(rows)||rows.length!==1)return undefined
  return {holderNodeId:rows[0].holder_node_id,epoch:rows[0].epoch,expiresAt:Date.parse(rows[0].expires_at)}
}})
server.listen(config.port,'127.0.0.1',()=>console.log('Xaventra repair authority ready on configured loopback port'))
