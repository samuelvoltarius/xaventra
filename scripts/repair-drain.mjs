// Explicit protected operator deployment; no model/issue supplied configuration.
import { RepairDrain } from '../dist/doctor/repair-drain.js'
import { createRepairDrainServer } from '../dist/doctor/repair-drain-server.js'
import { readProtectedControllerFile as read, protectControllerDirectory } from '../dist/doctor/repair-controller-files.js'
const config=JSON.parse(read(process.argv[2]||'',true))
if(!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw Error('Explicit drain port required')
protectControllerDirectory(config.stateRoot)
const nodes=Object.fromEntries(Object.entries(config.nodes).map(([id,node])=>{
  if(id==='operator'||!Array.isArray(node.settledTools))throw Error('Explicit node policy required')
  return [id,{publicKey:read(node.publicKeyFile),settledTools:node.settledTools}]
}))
const drain=new RepairDrain(config.stateRoot,Object.keys(nodes))
const observers=Object.fromEntries(Object.entries(config.observers||{}).map(([id,path])=>{
  if(id==='operator'||nodes[id])throw Error('Observer identity conflicts with a writer')
  return [id,read(path)]
}))
const server=createRepairDrainServer({drain,nodes,observers,privateKey:read(config.authorityPrivateKeyFile,true),
  operatorPublicKey:read(config.operatorPublicKeyFile),receiptPublicKey:read(config.receiptPublicKeyFile),
  updateReceiptPublicKey:config.updateReceiptPublicKeyFile?read(config.updateReceiptPublicKeyFile):undefined})
server.on('error',()=>{drain.close();process.exitCode=1})
server.listen(config.port,'127.0.0.1',()=>console.log('Repair tool-admission authority ready; external writer quiescence is a separate gate'))
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close())
