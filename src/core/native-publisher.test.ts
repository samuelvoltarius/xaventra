import { it,expect,beforeAll } from 'vitest'
import { mkdtempSync,writeFileSync,readFileSync,existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash,generateKeyPairSync } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { nativeArchiveHeader } from './native-archive.js'
import { releaseTreeHash } from './release-tree.js'
import { verifyNativeReleaseEvidence } from './native-release-evidence.js'
const dir=mkdtempSync(join(tmpdir(),'native-publisher-')),script=join(dir,'publisher.mjs'),hash=(b:any)=>createHash('sha256').update(b).digest('hex')
beforeAll(async()=>{await build({entryPoints:[fileURLToPath(new URL('../../scripts/publish-native-update.mjs',import.meta.url))],outfile:script,bundle:true,platform:'node',format:'esm'})})
function fixture(){
    const root=mkdtempSync(join(dir,'case-')),body=Buffer.from('fixture'),archive=join(root,'payload.tar.gz')
    const bytes=gzipSync(Buffer.concat([nativeArchiveHeader('dist/daemon.js',body.length),body,Buffer.alloc(512-body.length+1024)]));writeFileSync(archive,bytes)
    const treeHash=releaseTreeHash([{path:'dist/daemon.js',size:body.length,sha256:hash(body)}]),version='2.79.0',commit='a'.repeat(40)
    const plan={schema:1,version,commit,builds:['x64','arm64'].map(arch=>({arch,archive,treeHash,size:bytes.length,sha256:hash(bytes)}))}
    const key=generateKeyPairSync('ed25519'),out=join(root,'out'),planPath=join(root,'plan.json')
    const run=(change:(p:any)=>void=()=>{},wrongHash=false)=>{
        change(plan);const text=JSON.stringify(plan);writeFileSync(planPath,text)
        return spawnSync(process.execPath,[script,version,commit,planPath,wrongHash?'f'.repeat(64):hash(text),out],{encoding:'utf8',timeout:30000,env:{...process.env,XAVENTRA_UPDATE_PUBLISHER_ID:'fixture',XAVENTRA_UPDATE_PUBLISHER_KEY:key.privateKey.export({type:'pkcs8',format:'pem'}).toString()}})
    }
    return {run,plan,out,key,archive}
}
it('runs the actual signing entrypoint and independently verifies both native descriptors',()=>{
    const f=fixture(),r=f.run();expect(r.status,r.stderr).toBe(0)
    const signed=JSON.parse(readFileSync(join(f.out,'xaventra-native-update.json'),'utf8'))
    for(const a of signed.payload.artifacts){const b=f.plan.builds.find(b=>b.arch===a.arch)!;expect(verifyNativeReleaseEvidence(signed,{publisherKeys:{fixture:f.key.publicKey.export({type:'spki',format:'pem'}).toString()}},{version:f.plan.version,commit:f.plan.commit,updater:'2.78.56',arch:a.arch,treeHash:b.treeHash,descriptorHash:a.sha256},readFileSync(join(f.out,a.name))).descriptor.kind).toBe('native')}
    expect(existsSync(join(f.out,'xaventra-update.json'))).toBe(false)
    expect(f.run().status).not.toBe(0)
})
it.each(['approval','version','commit','duplicate','tree','archive'])('rejects %s before emitting publication',mode=>{
    const f=fixture()
    if(mode==='archive')writeFileSync(f.archive,'corrupt')
    const r=f.run(p=>{
        if(mode==='version')p.version='2.80.0'
        if(mode==='commit')p.commit='b'.repeat(40)
        if(mode==='duplicate')p.builds[1].arch='x64'
        if(mode==='tree')p.builds[0].treeHash='f'.repeat(64)
    },mode==='approval')
    expect(r.status).not.toBe(0);expect(existsSync(f.out)).toBe(false)
})
