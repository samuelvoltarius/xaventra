import { buildNativeArchive } from '../src/core/native-package-builder.ts'
import { verifyNativeArchive } from '../src/core/native-archive.ts'
import { encodeNativeUpdatePackage } from '../src/core/update-package.ts'
import { verifyNativeReleaseEvidence } from '../src/core/native-release-evidence.ts'
import { createHash,generateKeyPairSync,sign } from 'node:crypto'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const hash=b=>createHash('sha256').update(b).digest('hex')
if(process.argv[2]==='verify'){
    const r=JSON.parse(readFileSync(process.argv[3],'utf8'))
    const bytes=Buffer.from(r.descriptor,'base64')
    const e=verifyNativeReleaseEvidence(r.signed,{publisherKeys:{fixture:r.publicKey}},r.expected,bytes)
    await verifyNativeArchive(createReadStream(r.archive),{...e.descriptor.archive,treeHash:e.descriptor.treeHash})
    console.log('independent child verified signature, descriptor and produced archive')
}else{
    const dir=mkdtempSync(join(tmpdir(),'native-package-acceptance-')),root=join(dir,'build');mkdirSync(root);mkdirSync(join(root,'dist'))
    const files=[['dist/daemon.js','export const fixture=true\n'],['package.json','{"name":"fixture"}']].map(([path,text])=>{
        writeFileSync(join(root,path),text);return {path,size:Buffer.byteLength(text),sha256:hash(text)}
    })
    const archive=join(dir,'native.tar.gz'),result=await buildNativeArchive(root,archive,files)
    const descriptor={schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version:'2.79.0',commit:'a'.repeat(40),platform:'linux',arch:'arm64',treeHash:result.treeHash,archive:{sha256:result.sha256,size:result.size},entrypoint:'dist/daemon.js'}
    const bytes=encodeNativeUpdatePackage(descriptor),keys=generateKeyPairSync('ed25519')
    const payload={schema:1,repository:descriptor.repository,version:descriptor.version,commit:descriptor.commit,minUpdater:'2.78.56',artifacts:[{name:'xaventra-native-2.79.0-linux-arm64.tar.gz',platform:'linux',arch:'arm64',size:bytes.length,sha256:hash(bytes)}]}
    const record={archive,descriptor:bytes.toString('base64'),publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString(),signed:{keyId:'fixture',payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString('base64')},expected:{version:descriptor.version,updater:'2.78.56',arch:'arm64',commit:descriptor.commit,treeHash:result.treeHash,descriptorHash:hash(bytes)}}
    let actualPublisher=false
    if(process.argv[2]==='--publisher'){
        // The publisher rejects one archive for both architectures; build a distinct x64 payload.
        const x64Root=join(dir,'build-x64');mkdirSync(join(x64Root,'dist'),{recursive:true})
        const x64Files=[['dist/daemon.js','export const fixture="x64"\n'],['package.json','{"name":"fixture"}']].map(([path,text])=>{
            writeFileSync(join(x64Root,path),text);return {path,size:Buffer.byteLength(text),sha256:hash(text)}})
        const x64Archive=join(dir,'native-x64.tar.gz'),x64=await buildNativeArchive(x64Root,x64Archive,x64Files)
        const plan={schema:1,version:descriptor.version,commit:descriptor.commit,builds:[{arch:'x64',archive:x64Archive,...x64},{arch:'arm64',archive,...result}]}
        const text=JSON.stringify(plan),planPath=join(dir,'approved-plan.json'),out=join(dir,'signed')
        writeFileSync(planPath,text)
        const publisher=spawnSync(process.execPath,[process.argv[3],descriptor.version,descriptor.commit,planPath,hash(text),out],{encoding:'utf8',timeout:30000,env:{...process.env,XAVENTRA_UPDATE_PUBLISHER_ID:'fixture',XAVENTRA_UPDATE_PUBLISHER_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()}})
        assert.equal(publisher.status,0,publisher.stderr)
        record.signed=JSON.parse(readFileSync(join(out,'xaventra-native-update.json'),'utf8'))
        const artifact=record.signed.payload.artifacts.find(a=>a.arch==='arm64'),actualBytes=readFileSync(join(out,artifact.name))
        record.descriptor=actualBytes.toString('base64');record.expected.descriptorHash=hash(actualBytes)
        actualPublisher=true
    }
    const path=join(dir,'record.json');writeFileSync(path,JSON.stringify(record))
    const run=()=>spawnSync(process.execPath,[process.argv[1],'verify',path],{encoding:'utf8',timeout:30000})
    const good=run();assert.equal(good.status,0,good.stderr)
    const original=readFileSync(archive),changed=Buffer.from(original);changed[changed.length-1]^=1;writeFileSync(archive,changed)
    const bad=run();assert.notEqual(bad.status,0)
    writeFileSync(archive,original);const restored=run();assert.equal(restored.status,0,restored.stderr)
    const evidence={evidenceClass:'isolated actual file producer and independent process signature/archive verification; ephemeral publisher, fixture workload',actualPublisher,validExit:good.status,tamperedExit:bad.status,restoredExit:restored.status,productionChanged:false,directory:dir}
    writeFileSync(join(dir,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
}
