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
