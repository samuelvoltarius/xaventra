// Disposable publication acceptance for CL-20260929-01. Opt-in only
// (XAVENTRA_NATIVE_FIXTURE=1), bundle first, pass the bundled publisher:
//   node check-native-publication.bundle.mjs --publisher <publish-native-update.bundle.mjs>
// Runs the actual publisher in a child with an EPHEMERAL key and verifies its
// output in a separate fresh child. Fixture workload only: no production key,
// network, GitHub, installation or daemon start. Retains public evidence only.
import { buildNativeArchive } from '../src/core/native-package-builder.ts'
import { verifyNativeArchive } from '../src/core/native-archive.ts'
import { verifyNativePublication } from '../src/core/native-release-evidence.ts'
import { NATIVE_CHECKSUM_ASSET,NATIVE_MANIFEST_ASSET,nativeProgramAsset,nativeDescriptorAsset,parseNativeChecksums } from '../src/core/native-release-assets.ts'
import { createHash,generateKeyPairSync } from 'node:crypto'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,createReadStream,cpSync,rmSync,copyFileSync,existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

assert.equal(process.env.XAVENTRA_NATIVE_FIXTURE,'1')
const hash=b=>createHash('sha256').update(b).digest('hex')
const VERSION='2.79.0',COMMIT='a'.repeat(40)

if(process.argv[2]==='--verify'){
    // Independent reader: only the output directory (or an injected release
    // asset listing), the public key and expected identity. Never the plan.
    try{
        const [dir,publicKey,listing]=process.argv.slice(3)
        const names=listing?JSON.parse(readFileSync(listing,'utf8')):readdirSync(dir)
        const read=n=>readFileSync(join(dir,n))
        const checksums=read(NATIVE_CHECKSUM_ASSET).toString('utf8'),sums=parseNativeChecksums(checksums,VERSION)
        const result=verifyNativePublication({names,signed:JSON.parse(read(NATIVE_MANIFEST_ASSET).toString('utf8')),
            policy:{publisherKeys:{fixture:readFileSync(publicKey,'utf8')}},expected:{version:VERSION,commit:COMMIT,updater:'2.78.56'},checksums,
            descriptors:{x64:read(nativeDescriptorAsset(VERSION,'x64')),arm64:read(nativeDescriptorAsset(VERSION,'arm64'))}})
        for(const t of result.targets){
            const bytes=read(t.programAsset)
            if(hash(bytes)!==sums.get(t.programAsset))throw Error('Published program bytes differ from checksum file')
            await verifyNativeArchive(createReadStream(join(dir,t.programAsset)),{...t.descriptor.archive,treeHash:t.descriptor.treeHash})
        }
        for(const n of names)if(/PRIVATE KEY/.test(read(n).toString('latin1')))throw Error('Private key material in publication')
        console.log(JSON.stringify({verified:true,releaseId:result.releaseId,targets:result.targets.map(t=>t.arch)}))
    }catch(error){console.error('Native publication rejected: '+String(error?.message).slice(0,200));process.exitCode=1}
}else{
    assert.equal(process.argv[2],'--publisher')
    const publisher=process.argv[3],root=mkdtempSync(join(tmpdir(),'xaventra-native-publication-'))
    const keys=generateKeyPairSync('ed25519'),publicKey=join(root,'publisher-public.pem')
    writeFileSync(publicKey,keys.publicKey.export({type:'spki',format:'pem'}).toString(),{flag:'wx'})
    const builds={}
    for(const arch of ['x64','arm64']){
        const source=join(root,'payload-'+arch);mkdirSync(join(source,'dist'),{recursive:true})
        const files=[['dist/daemon.js',`export const fixture=${JSON.stringify(arch)}\n`],['package.json','{"name":"fixture"}\n']].map(([path,text])=>{
            writeFileSync(join(source,path),text);return {path,size:Buffer.byteLength(text),sha256:hash(text)}})
        const archive=join(root,`build-${arch}.tar.gz`),r=await buildNativeArchive(source,archive,files)
        builds[arch]={arch,archive,sha256:r.sha256,size:r.size,treeHash:r.treeHash}
    }
    const env={...process.env,XAVENTRA_UPDATE_PUBLISHER_ID:'fixture',XAVENTRA_UPDATE_PUBLISHER_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()}
    let n=0
    const plan=(entries,name)=>{const text=JSON.stringify({schema:1,version:VERSION,commit:COMMIT,builds:entries}),path=join(root,(name||'plan')+'-'+(++n)+'.json');writeFileSync(path,text,{flag:'wx'});return {path,sha:hash(text)}}
    const publish=(p,{commit=COMMIT,sha=p.sha,out=join(root,'out-'+(++n))}={})=>{
        const r=spawnSync(process.execPath,[publisher,VERSION,commit,p.path,sha,out],{encoding:'utf8',timeout:60000,env,maxBuffer:1024*1024})
        return {status:r.status,out,stderr:(r.stderr||'').split('\n').find(l=>/Error/.test(l))?.slice(0,200)}}
    const verify=(dir,listing,key=publicKey)=>{const r=spawnSync(process.execPath,[process.argv[1],'--verify',dir,key,...(listing?[listing]:[])],{encoding:'utf8',timeout:60000,env:{PATH:process.env.PATH,XAVENTRA_NATIVE_FIXTURE:'1'}});return {status:r.status,stderr:r.stderr.trim().slice(0,200)}}
    const cases={}
    const good=publish(plan([builds.x64,builds.arm64]))
    assert.equal(good.status,0,good.stderr)
    cases.valid={publish:good.status,verify:verify(good.out).status}
    assert.equal(cases.valid.verify,0)
    const reject=(name,result)=>{cases[name]=result;assert.notEqual(result.status,0,name)}
    // Publisher-side negatives: each must fail before a publishable manifest exists.
    reject('wrong-plan-hash',publish(plan([builds.x64,builds.arm64]),{sha:'0'.repeat(64)}))
    reject('missing-archive',publish(plan([builds.x64,{...builds.arm64,archive:join(root,'absent.tar.gz')}])))
    reject('wrong-architecture',publish(plan([builds.x64,{...builds.x64,arch:'x64'}])))
    reject('wrong-revision',publish(plan([builds.x64,builds.arm64]),{commit:'b'.repeat(40)}))
    reject('shared-archive',publish(plan([builds.x64,{...builds.x64,arch:'arm64'}])))
    reject('existing-output',publish(plan([builds.x64,builds.arm64]),{out:good.out}))
    const original=readFileSync(builds.arm64.archive),changed=Buffer.from(original);changed[changed.length>>1]^=1
    writeFileSync(builds.arm64.archive,changed)
    const tampered=publish(plan([builds.x64,builds.arm64]));reject('manipulated-archive',tampered)
    writeFileSync(builds.arm64.archive,original)
    // Every publisher-side rejection must leave NO output directory at all.
    for(const [name,c] of Object.entries(cases))if(name!=='valid'&&name!=='existing-output'){c.outputCreated=existsSync(c.out);assert.equal(c.outputCreated,false,name)}
    // Reader-side negatives against copies of the valid publication.
    const variant=(name,mutate)=>{const dir=join(root,'variant-'+name);cpSync(good.out,dir,{recursive:true});const listing=mutate(dir);reject(name,verify(dir,listing))}
    variant('incomplete-publication',dir=>{rmSync(join(dir,nativeProgramAsset(VERSION,'x64')))})
    variant('tampered-published-program',dir=>{const p=join(dir,nativeProgramAsset(VERSION,'arm64')),b=readFileSync(p);b[b.length>>1]^=1;writeFileSync(p,b)})
    variant('swapped-program-archives',dir=>{const a=join(dir,nativeProgramAsset(VERSION,'x64')),b=join(dir,nativeProgramAsset(VERSION,'arm64')),t=join(dir,'swap');copyFileSync(a,t);copyFileSync(b,a);copyFileSync(t,b);rmSync(t)})
    variant('extra-native-asset',dir=>{writeFileSync(join(dir,'xaventra-native-2.79.0-linux-x64.tar.gz.bak'),'x')})
    variant('duplicate-release-asset',dir=>{const l=join(root,'listing-duplicate.json');const names=readdirSync(dir);writeFileSync(l,JSON.stringify([...names,nativeProgramAsset(VERSION,'x64')]));return l})
    const otherKey=join(root,'other-public.pem');writeFileSync(otherKey,generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString(),{flag:'wx'})
    reject('foreign-publisher-key',verify(good.out,undefined,otherKey))
    // Re-run the untouched valid publication in a fresh child last.
    cases.validAgain={verify:verify(good.out).status};assert.equal(cases.validAgain.verify,0)
    const evidence={evidenceClass:'isolated real child-process publisher and independent reader; ephemeral key; fixture workload; not CI, publication or activation',
        platform:process.platform,arch:process.arch,node:process.version,root,cases,privateKeyRetained:false,productionChanged:false}
    writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2),{flag:'wx'})
    console.log(JSON.stringify(evidence))
}
