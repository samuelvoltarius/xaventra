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
    const root=mkdtempSync(join(dir,'case-')),version='2.79.0',commit='a'.repeat(40)
    // One distinct archive per architecture; the publisher rejects a shared program.
    const builds=['x64','arm64'].map(arch=>{
        const body=Buffer.from('fixture-'+arch),archive=join(root,`payload-${arch}.tar.gz`)
        const bytes=gzipSync(Buffer.concat([nativeArchiveHeader('dist/daemon.js',body.length),body,Buffer.alloc(512-body.length+1024)]));writeFileSync(archive,bytes)
        return {arch,archive,treeHash:releaseTreeHash([{path:'dist/daemon.js',size:body.length,sha256:hash(body)}]),size:bytes.length,sha256:hash(bytes)}
    }),archive=builds[1].archive
    const plan={schema:1,version,commit,builds}
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
    // The actual program archives are published under the contract name, byte-identical.
    for(const b of f.plan.builds)expect(hash(readFileSync(join(f.out,`xaventra-native-program-2.79.0-linux-${b.arch}.tar.gz`)))).toBe(b.sha256)
    expect(f.run().status).not.toBe(0)
})
it.each(['approval','version','commit','duplicate','tree','archive','shared','extra-field'])('rejects %s before emitting publication',mode=>{
    const f=fixture()
    if(mode==='archive')writeFileSync(f.archive,'corrupt')
    const r=f.run(p=>{
        if(mode==='version')p.version='2.80.0'
        if(mode==='commit')p.commit='b'.repeat(40)
        if(mode==='duplicate')p.builds[1].arch='x64'
        if(mode==='tree')p.builds[0].treeHash='f'.repeat(64)
        if(mode==='shared')p.builds[1]={...p.builds[0],arch:'arm64'}
        if(mode==='extra-field')p.builds[0].url='https://example.invalid/payload.tar.gz'
    },mode==='approval')
    expect(r.status).not.toBe(0);expect(existsSync(f.out)).toBe(false)
})
it('rejects architecture labels swapped together with their archives via the ELF machine',()=>{
    const root=mkdtempSync(join(dir,'elf-')),version='2.79.0',commit='a'.repeat(40)
    const builds=(['x64','arm64'] as const).map(arch=>{
        const elf=Buffer.alloc(64);elf.write('\x7fELF','latin1');elf[4]=2;elf[5]=1;elf[6]=1;elf.writeUInt16LE(3,16);elf.writeUInt16LE(arch==='x64'?62:183,18)
        const body=Buffer.from('fixture-'+arch),path='node_modules/fixture/addon.node',archive=join(root,`${arch}.tar.gz`)
        const bytes=gzipSync(Buffer.concat([nativeArchiveHeader('dist/daemon.js',body.length),body,Buffer.alloc(512-body.length),
            nativeArchiveHeader(path,elf.length),elf,Buffer.alloc(512-elf.length+1024)]));writeFileSync(archive,bytes)
        const treeHash=releaseTreeHash([{path:'dist/daemon.js',size:body.length,sha256:hash(body)},{path,size:elf.length,sha256:hash(elf)}])
        return {arch,archive,treeHash,size:bytes.length,sha256:hash(bytes)}
    })
    const key=generateKeyPairSync('ed25519'),env={...process.env,XAVENTRA_UPDATE_PUBLISHER_ID:'fixture',XAVENTRA_UPDATE_PUBLISHER_KEY:key.privateKey.export({type:'pkcs8',format:'pem'}).toString()}
    const run=(entries:any[],name:string)=>{const text=JSON.stringify({schema:1,version,commit,builds:entries}),planPath=join(root,name+'.json');writeFileSync(planPath,text)
        return spawnSync(process.execPath,[script,version,commit,planPath,hash(text),join(root,name)],{encoding:'utf8',timeout:30000,env})}
    const correct=run(builds,'correct');expect(correct.status,correct.stderr).toBe(0)
    const swapped=run([{...builds[1],arch:'x64'},{...builds[0],arch:'arm64'}],'swapped')
    expect(swapped.status).not.toBe(0);expect(swapped.stderr).toMatch(/ELF architecture/);expect(existsSync(join(root,'swapped'))).toBe(false)
})
