import { it,expect } from 'vitest'
import { mkdtempSync,mkdirSync,writeFileSync,realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { validateNativeBinaryHeader,buildQualifiedNativeArchive } from './native-build-qualification.js'
function elf(machine=62){const b=Buffer.alloc(64);b.set([127,69,76,70,2,1,1]);b.writeUInt16LE(3,16);b.writeUInt16LE(machine,18);return b}
it.each([['x64',62],['arm64',183]] as const)('accepts %s ELF header', (arch,m)=>expect(validateNativeBinaryHeader('addon.node',elf(m),arch)).toBe(true))
it.each(['arch','short','endian','class','type','windows','text'])('rejects %s native binary',mode=>{
    let b=elf();if(mode==='arch')b=elf(183);if(mode==='short')b=b.subarray(0,30);if(mode==='endian')b[5]=2;if(mode==='class')b[4]=1;if(mode==='type')b.writeUInt16LE(1,16);if(mode==='windows')b=Buffer.from('MZ');if(mode==='text')b=Buffer.from('text')
    expect(()=>validateNativeBinaryHeader('addon.node',b,'x64')).toThrow()
})
function fixture(wrong=false){
    const dir=realpathSync(mkdtempSync(join(tmpdir(),'native-qualified-'))),root=join(dir,'app');mkdirSync(root);mkdirSync(join(root,'dist'))
    const version='2.79.0',pkg={name:'@xaventra/core',version,type:'module',main:'dist/daemon.js'}
    const values={'package.json':Buffer.from(JSON.stringify(pkg)),'package-lock.json':Buffer.from(JSON.stringify({name:pkg.name,version:wrong?'0.0.0':version,lockfileVersion:3,packages:{'':{version}}})),'dist/daemon.js':Buffer.from('export {}'),'dist/addon.node':elf()}
    const files=Object.entries(values).map(([path,b])=>{writeFileSync(join(root,path),b);return {path,size:b.length,sha256:createHash('sha256').update(b).digest('hex')}})
    return {root,out:join(dir,'archive.tar.gz'),files,expected:{version,commit:'a'.repeat(40),arch:'x64' as const}}
}
it('qualifies and packs actual approved bytes',async()=>{const f=fixture();expect((await buildQualifiedNativeArchive(f.root,f.out,f.files,f.expected)).binaries).toBe(1)})
it('rejects mismatched lock before packaging',async()=>{const f=fixture(true);await expect(buildQualifiedNativeArchive(f.root,f.out,f.files,f.expected)).rejects.toThrow('package/lock')})
