// Actual signed HTTP admission and disposable child processes, NOT a live Mesh
// partition, external-writer fencing, model benchmark or production activation.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { fork, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RepairDrain } from '../dist/doctor/repair-drain.js'
import { RepairDrainClient } from '../dist/doctor/repair-drain-client.js'
import { createRepairDrainServer } from '../dist/doctor/repair-drain-server.js'

if(process.argv[2]==='worker'){
  process.once('message',async ({config,file,hold})=>{
    try{
      await new RepairDrainClient(config).execute('fixture_write',true,async()=>{
        const gate=hold?once(process,'message'):Promise.resolve()
        process.send({state:'admitted'}); await gate
        writeFileSync(file,'one verified write',{flag:'wx'})
      })
      process.send({state:'settled'});process.disconnect()
    }catch{process.send({state:'denied'});process.disconnect()}
  })
}else{
  const root=resolve('.nova-data','repair-drain-qa',`${Date.now()}-${randomUUID()}`)
  mkdirSync(root,{recursive:true})
  const report={version:JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version,
    sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    sourceDirty:Boolean(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim()),
    startedAt:new Date().toISOString(),kind:'real HTTP and child-process protocol; not production or external-writer fencing',platform:process.platform,checks:[]}
  const keys=()=>{const k=generateKeyPairSync('ed25519');return{privateKey:k.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKey:k.publicKey.export({type:'spki',format:'pem'}).toString()}}
  const authority=keys(),operator=keys(),a=keys(),b=keys(),receipt=keys()
  const t={proposalId:'fixture',patchHash:'a'.repeat(64),baselineHash:'b'.repeat(64),candidateHash:'c'.repeat(64),probeId:'original',targetId:'fixture',attemptId:`repair-${randomUUID()}`,expiresAt:Date.now()+120_000}
  let server,drain,op,url
  const children=[]
  const start=async()=>{
    drain=new RepairDrain(join(root,'coordinator'),['a','b'])
    server=createRepairDrainServer({drain,privateKey:authority.privateKey,operatorPublicKey:operator.publicKey,receiptPublicKey:receipt.publicKey,
      nodes:{a:{publicKey:a.publicKey,settledTools:['fixture_write']},b:{publicKey:b.publicKey,settledTools:['fixture_write']}}})
    await new Promise(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${server.address().port}/drain`
    op=new RepairDrainClient({url,actor:'operator',privateKey:operator.privateKey,authorityPublicKey:authority.publicKey})
  }
  const stop=()=>new Promise(r=>server.close(r))
  const worker=(actor,key,file,hold)=>{
    const child=fork(fileURLToPath(import.meta.url),['worker'],{stdio:['ignore','ignore','inherit','ipc'],env:{PATH:process.env.PATH,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})}})
    children.push(child)
    const messages=[],waiters=[]
    child.on('message',m=>{if(waiters.length)waiters.shift()(m);else messages.push(m)})
    const message=()=>Promise.race([messages.length?Promise.resolve(messages.shift()):new Promise(r=>waiters.push(r)),
      new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Child handshake timeout')),10_000);timer.unref()})])
    child.send({config:{url,actor,privateKey:key.privateKey,authorityPublicKey:authority.publicKey},file,hold})
    return{child,message}
  }
  const check=(name,fn)=>{fn();report.checks.push({name,passed:true})}
  try{
    await start()
    const fileA=join(root,'a.txt'),fileB=join(root,'b.txt')
    const first=worker('a',a,fileA,true)
    assert.equal((await first.message()).state,'admitted')
    await op.request('begin',t)
    const denied=worker('b',b,fileB,false)
    assert.equal((await denied.message()).state,'denied')
    check('second node cannot execute while first node is draining',()=>assert.equal(existsSync(fileB),false))
    const pending=await op.request('status',t)
    check('unsettled real child blocks admission barrier',()=>assert.equal(pending.toolActionsDrained,false))
    first.child.send('finish');assert.equal((await first.message()).state,'settled')
    const settled=await op.request('status',t)
    check('actual file write completes before barrier reports drained',()=>{assert.equal(readFileSync(fileA,'utf8'),'one verified write');assert.equal(settled.toolActionsDrained,true);assert.equal(settled.externalWritersQuiesced,false)})
    // Direct method is operator-owned TEST recovery; real server reopening needs
    // a separate signed controller receipt, covered by the HTTP regressions.
    drain.release(t)
    const lost=worker('a',a,join(root,'lost.txt'),true)
    assert.equal((await lost.message()).state,'admitted')
    const next={...t,attemptId:`repair-${randomUUID()}`};await op.request('begin',next)
    const exit=once(lost.child,'exit');lost.child.kill();await exit
    await stop();await start()
    const restored=await op.request('status',next)
    check('lost node stays pending across actual coordinator close/reopen',()=>{assert.equal(restored.pending,1);assert.equal(restored.toolActionsDrained,false)})
    const deniedAgain=worker('b',b,fileB,false)
    assert.equal((await deniedAgain.message()).state,'denied')
    check('restart cannot reopen admission or replay uncertain work',()=>{assert.equal(existsSync(fileB),false);assert.equal(existsSync(join(root,'lost.txt')),false)})
  }catch(error){report.checks.push({name:'acceptance failure',passed:false,error:String(error)});process.exitCode=1}
  finally{
    for(const child of children)if(child.exitCode===null&&!child.killed)child.kill()
    if(server?.listening)await stop()
    report.completedAt=new Date().toISOString()
    writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({report:join(root,'report.json'),passed:report.checks.filter(x=>x.passed).length,total:report.checks.length}))
  }
}
