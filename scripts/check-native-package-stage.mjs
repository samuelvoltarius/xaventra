import { stageSignedNativePackage } from '../src/doctor/native-package-stage.ts'
import { stageSignedNativePackageOnce } from '../src/doctor/native-stage-journal.ts'
import { publishNativeRuntimeOnce } from '../src/doctor/native-runtime-publication.ts'
import { nativeArchiveHeader } from '../src/core/native-archive.ts'
import { releaseTreeHash } from '../src/core/release-tree.ts'
import { encodeNativeUpdatePackage } from '../src/core/update-package.ts'
import { createHash,generateKeyPairSync,sign } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,statSync,readdirSync,symlinkSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
assert.equal(process.env.XAVENTRA_NATIVE_FIXTURE,'1');assert.equal(process.platform,'linux');assert.equal(process.getuid(),0)
if(process.argv[2]==='--journal'){
    const input=JSON.parse(readFileSync(process.argv[3],'utf8'))
    console.log(JSON.stringify(await stageSignedNativePackageOnce(process.argv[4],input.receipts,input.signed,input.policy,input.expected,Buffer.from(input.descriptor,'base64'),input.paths)))
    process.exit(0)
}
if(process.argv[2]==='--publication'){
    const i=JSON.parse(readFileSync(process.argv[3],'utf8'))
    console.log(JSON.stringify(await publishNativeRuntimeOnce('runtime',i.receipts,i.account,i.signed,i.policy,i.expected,Buffer.from(i.descriptor,'base64'),i.paths)))
    process.exit(0)
}
const root=mkdtempSync('/var/lib/xaventra-native-stage-qa-'),results=[]
chmodSync(root,0o755) // Only this fresh synthetic fixture; stages remain private.
const hash=b=>createHash('sha256').update(b).digest('hex')
for(const mode of ['valid','runtime-publication','invalid-signature','changed-archive','signed-truncated','writable-archive','linked-archive','linked-parent']){
    const base=join(root,mode),parent=join(base,'staging');mkdirSync(base);mkdirSync(parent)
    const entries=[{path:'dist/daemon.js',mode:0o755,bytes:Buffer.from('throw Error("Must never execute during staging")\n')},
        {path:'assets/empty',mode:mode==='runtime-publication'?0o644:0o600,bytes:Buffer.alloc(0)},{path:'assets/large',mode:0o644,bytes:Buffer.alloc(180000,7)}]
    const treeHash=releaseTreeHash(entries.map(f=>({path:f.path,size:f.bytes.length,sha256:hash(f.bytes)})).sort((a,b)=>a.path.localeCompare(b.path)))
    let raw=Buffer.concat([...entries.flatMap(f=>[nativeArchiveHeader(f.path,f.bytes.length,f.mode),f.bytes,Buffer.alloc((512-f.bytes.length%512)%512)]),Buffer.alloc(1024)])
    if(mode==='signed-truncated')raw=raw.subarray(0,raw.length-512)
    const bytes=gzipSync(raw),archive=join(base,'archive.gz');writeFileSync(archive,bytes,{mode:0o600})
    const commit='a'.repeat(40),version='2.79.0',keys=generateKeyPairSync('ed25519')
    const descriptor=encodeNativeUpdatePackage({schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version,commit,platform:'linux',arch:'arm64',treeHash,archive:{sha256:hash(bytes),size:bytes.length},entrypoint:'dist/daemon.js'})
    const payload={schema:1,repository:'samuelvoltarius/xaventra',version,commit,minUpdater:'2.78.56',artifacts:[{name:'xaventra-native-2.79.0-linux-arm64.tar.gz',platform:'linux',arch:'arm64',size:descriptor.length,sha256:hash(descriptor)}]}
    const signed={keyId:'fixture',payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString('base64')}
    const policy={publisherKeys:{fixture:keys.publicKey.export({type:'spki',format:'pem'}).toString()}}
    const expected={version,commit,arch:'arm64',updater:'2.78.56',treeHash,descriptorHash:hash(descriptor)}
    const paths={archive,parent}
    if(mode==='invalid-signature')signed.signature=Buffer.alloc(64).toString('base64')
    if(mode==='changed-archive')writeFileSync(archive,Buffer.alloc(bytes.length,1))
    if(mode==='writable-archive')chmodSync(archive,0o666)
    if(mode==='linked-archive'){paths.archive=join(base,'alias.gz');symlinkSync(archive,paths.archive)}
    if(mode==='linked-parent'){paths.parent=join(base,'alias');symlinkSync(parent,paths.parent)}
    const stage=()=>stageSignedNativePackage(signed,policy,expected,descriptor,paths)
    if(mode==='runtime-publication'){
        const receipts=join(base,'receipts');mkdirSync(receipts,{mode:0o700})
        const account={uid:65534,gid:65534},publish=(id='runtime')=>publishNativeRuntimeOnce(id,receipts,account,signed,policy,expected,descriptor,paths)
        const privateStage=await stage(),before=readdirSync(parent).length
        const request=join(base,'publication-request.json')
        writeFileSync(request,JSON.stringify({receipts,account,signed,policy,expected,descriptor:descriptor.toString('base64'),paths}),{mode:0o600})
        const child=()=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--publication',request],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))
        const first=child(),second=child()
        assert.equal(first.replayed,false);assert.equal(second.replayed,true);assert.equal(first.root,second.root)
        assert.equal(readdirSync(parent).length,before+1);assert.equal(statSync(privateStage.root).mode&0o777,0o700)
        assert.equal(statSync(first.root).mode&0o777,0o755)
        for(const f of entries){assert.deepEqual(readFileSync(join(first.root,f.path)),f.bytes);assert.equal(statSync(join(first.root,f.path)).mode&0o7777,f.mode)}
        const record=JSON.parse(readFileSync(join(receipts,'runtime.publication.json'),'utf8'))
        writeFileSync(join(receipts,'interrupted.publication.json'),JSON.stringify({...record,status:'intent'}),{mode:0o600})
        await assert.rejects(()=>publish('interrupted'),/reconciliation/);assert.equal(readdirSync(parent).length,before+1)
        await assert.rejects(()=>publishNativeRuntimeOnce('runtime',receipts,{uid:65533,gid:65533},signed,policy,expected,descriptor,paths),/binding mismatch/)
        writeFileSync(join(first.root,'dist/daemon.js'),'changed');await assert.rejects(publish)
    }else if(mode==='valid'){
        const first=await stage(),second=await stage();assert.notEqual(first.root,second.root)
        for(const r of [first,second]){
            assert.equal(r.staged,true);assert.equal(r.activated,false);assert.equal(r.files,3)
            assert.equal(r.installedTreeVerified,true);assert.equal(r.archiveTreeVerified,true)
            for(const f of entries){assert.deepEqual(readFileSync(join(r.root,f.path)),f.bytes);assert.equal(statSync(join(r.root,f.path)).mode&0o7777,f.mode)}
        }
        assert.deepEqual(readFileSync(archive),bytes)
        const receipts=join(base,'receipts');mkdirSync(receipts,{mode:0o700})
        const beforePublication=readdirSync(parent).length
        await assert.rejects(()=>publishNativeRuntimeOnce('private-file',receipts,{uid:65534,gid:65534},signed,policy,expected,descriptor,paths),/EACCES/)
        assert.equal(readdirSync(parent).length,beforePublication+1)
        for(const dir of readdirSync(parent))assert.equal(statSync(join(parent,dir)).mode&0o777,0o700)
        await assert.rejects(()=>publishNativeRuntimeOnce('private-file',receipts,{uid:65534,gid:65534},signed,policy,expected,descriptor,paths),/reconciliation/)
        const request=join(base,'request.json'),input={receipts,signed,policy,expected,descriptor:descriptor.toString('base64'),paths}
        writeFileSync(request,JSON.stringify(input),{mode:0o600})
        const resume=(id='request')=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--journal',request,id],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))
        const count=readdirSync(parent).length,firstResume=resume(),secondResume=resume()
        assert.equal(firstResume.replayed,false);assert.equal(secondResume.replayed,true)
        assert.equal(firstResume.root,secondResume.root);assert.equal(readdirSync(parent).length,count+1)
        const receipt=JSON.parse(readFileSync(join(receipts,'request.json'),'utf8'))
        writeFileSync(join(receipts,'interrupted.json'),JSON.stringify({...receipt,status:'intent'}),{mode:0o600})
        assert.throws(()=>resume('interrupted'));assert.equal(readdirSync(parent).length,count+1)
        mkdirSync(join(receipts,'locked.lock'));assert.throws(()=>resume('locked'))
        const alt=join(base,'other-staging');mkdirSync(alt)
        writeFileSync(request,JSON.stringify({...input,paths:{...paths,parent:alt}}))
        assert.throws(()=>resume());assert.deepEqual(readdirSync(alt),[])
        writeFileSync(request,JSON.stringify(input))
        writeFileSync(join(firstResume.root,'dist/daemon.js'),'changed')
        assert.throws(()=>resume());assert.equal(readdirSync(parent).length,count+1)
        results.push({mode:'fresh-process-replay-without-duplicate-and-interrupted-drift-refusal',passed:true})
    }else{await assert.rejects(stage);assert.deepEqual(readdirSync(parent),[])}
    results.push({mode,passed:true})
}
const report={evidenceClass:'actual-isolated-linux-signed-archive-staging-not-production-installation',root,results,productionChanged:false,noCodeExecuted:true,noUnitsOrRuntimeStateChanged:true}
writeFileSync(join(root,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
