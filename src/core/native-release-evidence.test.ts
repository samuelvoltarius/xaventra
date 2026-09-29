import { it, expect } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { encodeNativeUpdatePackage, decodeNativeUpdatePackage, encodeUpdatePackage, decodeUpdatePackage, type NativeUpdatePackage } from './update-package.js'
import { verifyNativeReleaseEvidence } from './native-release-evidence.js'
function fixture() {
    const keys=generateKeyPairSync('ed25519'),value:NativeUpdatePackage={schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version:'2.79.0',commit:'a'.repeat(40),platform:'linux',arch:'arm64',treeHash:'b'.repeat(64),archive:{sha256:'c'.repeat(64),size:1234},entrypoint:'dist/daemon.js'}
    const bytes=encodeNativeUpdatePackage(value),sha=createHash('sha256').update(bytes).digest('hex')
    const payload={schema:1 as const,repository:value.repository,version:value.version,commit:value.commit,minUpdater:'2.78.56',artifacts:[{name:'xaventra-2.79.0-linux-arm64.tar.gz',platform:'linux',arch:'arm64',size:bytes.length,sha256:sha}]}
    const signed={keyId:'fixture',payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString('base64')}
    const policy={publisherKeys:{fixture:keys.publicKey.export({type:'spki',format:'pem'}).toString()}},expected={version:value.version,updater:'2.78.56',arch:'arm64' as const,commit:value.commit,descriptorHash:sha,treeHash:value.treeHash}
    return {value,bytes,payload,signed,policy,expected}
}
it('binds native tree and archive commitments through the existing real Ed25519 publisher verifier',()=>{
    const f=fixture();expect(verifyNativeReleaseEvidence(f.signed,f.policy,f.expected,f.bytes).descriptor).toEqual(f.value)
})
it.each(['key','signature','bytes','commit','tree','architecture'])('rejects altered %s evidence',mode=>{
    const f=fixture()
    if(mode==='key')f.policy.publisherKeys.fixture=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString()
    if(mode==='signature')f.signed.payload.commit='d'.repeat(40)
    if(mode==='bytes')f.bytes[0]^=1
    if(mode==='commit')f.expected.commit='d'.repeat(40)
    if(mode==='tree')f.expected.treeHash='d'.repeat(64)
    if(mode==='architecture')f.expected.arch='x64' as any
    expect(()=>verifyNativeReleaseEvidence(f.signed,f.policy,f.expected,f.bytes)).toThrow()
})
it('never interprets a Docker package as native or native as Docker',()=>{
    const f=fixture(),docker=encodeUpdatePackage({...f.value,kind:'docker',image:`ghcr.io/samuelvoltarius/xaventra@sha256:${'d'.repeat(64)}`} as any)
    expect(()=>decodeNativeUpdatePackage(docker,f.payload,'arm64')).toThrow()
    expect(()=>decodeUpdatePackage(f.bytes,f.payload,'arm64')).toThrow()
})
it.each(['entrypoint','archive','extra','tree'])('rejects invalid native %s fields',mode=>{
    const f=fixture(),v:any=structuredClone(f.value)
    if(mode==='entrypoint')v.entrypoint='../run.sh'
    if(mode==='archive')v.archive.size=Number.MAX_SAFE_INTEGER
    if(mode==='extra')v.command='run something'
    if(mode==='tree')v.treeHash=''
    expect(()=>decodeNativeUpdatePackage(encodeNativeUpdatePackage(v),f.payload,'arm64')).toThrow('identity')
})
it('retains bounded archive parsing and rejection of extra archive content',()=>{
    const f=fixture();expect(()=>decodeNativeUpdatePackage(gzipSync(Buffer.alloc(200000)),f.payload,'arm64')).toThrow()
    expect(()=>decodeNativeUpdatePackage(gzipSync(Buffer.concat([gunzipSync(f.bytes),Buffer.alloc(512)])),f.payload,'arm64')).toThrow()
})

// ---- Complete native publication (CL-20260929-01) ----
import { verifyNativePublication } from './native-release-evidence.js'
import { formatNativeChecksums, nativeDescriptorAsset, nativeProgramAsset, nativeReleaseInventory } from './native-release-assets.js'
function publication() {
    const keys=generateKeyPairSync('ed25519'),version='2.79.0',commit='a'.repeat(40),sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
    const descriptors:Record<string,Buffer>={},programs:Record<string,string>={}
    const artifacts=(['x64','arm64'] as const).map((arch,i)=>{
        programs[arch]=String(i+1).repeat(64)
        const bytes=encodeNativeUpdatePackage({schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version,commit,platform:'linux',arch,
            treeHash:String(i+5).repeat(64),archive:{sha256:programs[arch],size:1000+i},entrypoint:'dist/daemon.js'})
        descriptors[arch]=bytes
        return {name:nativeDescriptorAsset(version,arch),platform:'linux',arch,size:bytes.length,sha256:sha(bytes)}
    })
    const payload={schema:1 as const,repository:'samuelvoltarius/xaventra',version,commit,minUpdater:'2.78.56',artifacts}
    const signed={keyId:'fixture',payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString('base64')}
    const hashes:Record<string,string>={}
    for(const a of ['x64','arm64']){hashes[nativeProgramAsset(version,a)]=programs[a];hashes[nativeDescriptorAsset(version,a)]=sha(descriptors[a])}
    return {keys,signed,descriptors,names:nativeReleaseInventory(version),checksums:formatNativeChecksums(version,n=>hashes[n]),
        policy:{publisherKeys:{fixture:keys.publicKey.export({type:'spki',format:'pem'}).toString()}},expected:{version,commit,updater:'2.78.56'}}
}
function resign(p:ReturnType<typeof publication>){p.signed.signature=sign(null,Buffer.from(JSON.stringify(p.signed.payload)),p.keys.privateKey).toString('base64')}
it('cross-binds manifest, both descriptors, checksums and the exact inventory',()=>{
    const p=publication(),r=verifyNativePublication(p)
    expect(r.targets.map(t=>[t.arch,t.programAsset,t.descriptor.archive.sha256])).toEqual([
        ['x64','xaventra-native-program-2.79.0-linux-x64.tar.gz','1'.repeat(64)],['arm64','xaventra-native-program-2.79.0-linux-arm64.tar.gz','2'.repeat(64)]])
})
it.each(['missing-archive','missing-manifest','duplicate-asset','swapped-descriptors','tampered-descriptor','checksum-program','checksum-descriptor',
    'wrong-commit','unsigned-extra-artifact','shared-program','wrong-key','docker-only-manifest'])('rejects %s',mode=>{
    const p=publication() as any
    if(mode==='missing-archive')p.names=p.names.filter((n:string)=>n!==nativeProgramAsset('2.79.0','arm64'))
    if(mode==='missing-manifest')p.names=p.names.slice(0,-1)
    if(mode==='duplicate-asset')p.names=[...p.names,p.names[0]]
    if(mode==='swapped-descriptors')[p.descriptors.x64,p.descriptors.arm64]=[p.descriptors.arm64,p.descriptors.x64]
    if(mode==='tampered-descriptor')p.descriptors.x64=Buffer.from(p.descriptors.x64),p.descriptors.x64[5]^=1
    if(mode==='checksum-program')p.checksums=p.checksums.replace('1'.repeat(64),'3'.repeat(64))
    if(mode==='checksum-descriptor')p.checksums=p.checksums.replace(/^([\s\S]*?\n)[a-f0-9]{64}/,`$1${'4'.repeat(64)}`)
    if(mode==='wrong-commit')p.expected.commit='b'.repeat(40)
    if(mode==='unsigned-extra-artifact')p.signed.payload.artifacts.push({...p.signed.payload.artifacts[0],name:'xaventra-2.79.0-darwin-x64.tar.gz',platform:'darwin'}),resign(p)
    if(mode==='wrong-key')p.policy.publisherKeys.fixture=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString()
    if(mode==='docker-only-manifest')p.signed.payload.artifacts=p.signed.payload.artifacts.map((a:any)=>({...a,name:`xaventra-2.79.0-linux-${a.arch}.tar.gz`})),resign(p)
    if(mode==='shared-program'){
        const q=publication(),same=encodeNativeUpdatePackage({...decodeNativeUpdatePackage(q.descriptors.x64,q.signed.payload,'x64'),arch:'arm64'})
        p.descriptors.arm64=same
        const art=p.signed.payload.artifacts.find((a:any)=>a.arch==='arm64');art.size=same.length;art.sha256=createHash('sha256').update(same).digest('hex');resign(p)
        // Consistent checksums, so ONLY the shared-program rule can reject.
        const h:Record<string,string>={[nativeProgramAsset('2.79.0','x64')]:'1'.repeat(64),[nativeProgramAsset('2.79.0','arm64')]:'1'.repeat(64),
            [nativeDescriptorAsset('2.79.0','x64')]:createHash('sha256').update(p.descriptors.x64).digest('hex'),[nativeDescriptorAsset('2.79.0','arm64')]:art.sha256}
        p.checksums=formatNativeChecksums('2.79.0',n=>h[n])
    }
    const reasons:Record<string,RegExp>={'missing-archive':/Incomplete/,'missing-manifest':/Incomplete/,'duplicate-asset':/Duplicate/,
        'swapped-descriptors':/descriptor bytes/,'tampered-descriptor':/descriptor bytes/,'checksum-program':/program checksum/,
        'checksum-descriptor':/descriptor bytes/,'wrong-commit':/commit mismatch/,'unsigned-extra-artifact':/manifest inventory/,
        'shared-program':/share one program/,'wrong-key':/signature/,'docker-only-manifest':/manifest inventory/}
    expect(()=>verifyNativePublication(p)).toThrow(reasons[mode])
})
