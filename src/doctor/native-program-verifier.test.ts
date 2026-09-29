import { it,expect,vi,afterEach } from 'vitest'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash,generateKeyPairSync,sign } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { nativeArchiveHeader } from '../core/native-archive.js'
// Simulate Linux ownership only; file contents and signature checks are real.
vi.mock('./repair-controller-files.js',()=>({protectControllerDirectory:()=>{}}))
vi.mock('node:fs',async original=>{
    const fs:any=await original();const wrap=(s:any)=>new Proxy(s,{get:(target,key)=>key==='uid'?0:key==='mode'?(target.isDirectory()?0o40755:0o100644):Reflect.get(target,key)})
    return {...fs,lstatSync:(...a:any[])=>wrap(fs.lstatSync(...a)),fstatSync:(...a:any[])=>wrap(fs.fstatSync(...a))}
})
import { nativeProgramInventory,verifyNativeInstalledRelease } from './native-program-verifier.js'
import { releaseTreeHash } from '../core/release-verifier.js'
import { encodeNativeUpdatePackage } from '../core/update-package.js'
afterEach(()=>vi.unstubAllGlobals())
function fixture(archiveContent='fixture'){
    vi.stubGlobal('process',{...process,platform:'linux',getuid:()=>0})
    const root=mkdtempSync(join(tmpdir(),'native-program-'));mkdirSync(join(root,'app'));mkdirSync(join(root,'app','dist'))
    const app=join(root,'app'),daemon=join(app,'dist','daemon.js'),archive=join(root,'archive');writeFileSync(daemon,'fixture')
    const content=Buffer.from(archiveContent)
    writeFileSync(archive,gzipSync(Buffer.concat([nativeArchiveHeader('dist/daemon.js',content.length),content,Buffer.alloc((512-content.length%512)%512+1024)])))
    const hash=(b:any)=>createHash('sha256').update(b).digest('hex'),treeHash=releaseTreeHash(nativeProgramInventory(app))
    const descriptor:any={schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version:'2.79.0',commit:'a'.repeat(40),platform:'linux',arch:'arm64',treeHash,archive:{sha256:hash(readFileSync(archive)),size:readFileSync(archive).length},entrypoint:'dist/daemon.js'}
    const bytes=encodeNativeUpdatePackage(descriptor),descriptorHash=hash(bytes),keys=generateKeyPairSync('ed25519')
    const payload:any={schema:1,repository:descriptor.repository,version:descriptor.version,commit:descriptor.commit,minUpdater:'2.78.56',artifacts:[{name:'xaventra-2.79.0-linux-arm64.tar.gz',platform:'linux',arch:'arm64',size:bytes.length,sha256:descriptorHash}]}
    const signed={keyId:'test',payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString('base64')}
    const policy={publisherKeys:{test:keys.publicKey.export({type:'spki',format:'pem'}).toString()}},expected:any={version:descriptor.version,updater:'2.78.56',arch:'arm64',commit:descriptor.commit,treeHash,descriptorHash}
    return {app,daemon,archive,verify:()=>verifyNativeInstalledRelease(signed,policy,expected,bytes,{root:app,archive})}
}
it('verifies actual archive and complete file inventory',async()=>{expect((await fixture().verify()).archiveTreeVerified).toBe(true)})
it('rejects a correctly signed archive whose contents differ from the correctly signed installed tree',async()=>{
    await expect(fixture('different bytes signed by same publisher').verify()).rejects.toThrow('Native archive commitment mismatch')
})
it.each(['changed','extra','archive'])('rejects %s bytes',async mode=>{
    const f=fixture();if(mode==='changed')writeFileSync(f.daemon,'changed');if(mode==='extra')writeFileSync(join(f.app,'extra'),'x');if(mode==='archive')writeFileSync(f.archive,'changed')
    await expect(f.verify()).rejects.toThrow()
})
