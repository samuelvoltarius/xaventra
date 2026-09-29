import { it,expect } from 'vitest'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,linkSync,realpathSync,symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { buildNativeArchive } from './native-package-builder.js'
function fixture(){
    const dir=realpathSync(mkdtempSync(join(tmpdir(),'native-package-'))),root=join(dir,'source');mkdirSync(root);mkdirSync(join(root,'dist'))
    const entries=[{path:'dist/daemon.js',body:'export const fixture = true\n'},{path:'package.json',body:'{"name":"fixture"}'}]
    const files=entries.map(e=>{writeFileSync(join(root,e.path),e.body);return {path:e.path,size:Buffer.byteLength(e.body),sha256:createHash('sha256').update(e.body).digest('hex')}})
    return {dir,root,files,out:join(dir,'archive.tar.gz')}
}
it('still rejects a symlinked source root rather than normalizing away the protection',async()=>{
    const f=fixture(),alias=join(f.dir,'alias');symlinkSync(f.root,alias,'junction')
    await expect(buildNativeArchive(alias,f.out,f.files)).rejects.toThrow('source root invalid')
})
it('packages public dependency git metadata without treating it as a private git checkout', async () => {
    const f=fixture()
    for(const path of ['node_modules/example/.github/workflows/test.yml','node_modules/example/.gitkeep','node_modules/example/.gitattributes']){
        mkdirSync(dirname(join(f.root,path)),{recursive:true});writeFileSync(join(f.root,path),'public')
        f.files.push({path,size:6,sha256:createHash('sha256').update('public').digest('hex')})
    }
    await expect(buildNativeArchive(f.root,f.out,f.files)).resolves.toHaveProperty('treeHash')
})
it.each(['.git/config','.GIT','.git-credentials','.gitconfig','.env','.env.production','.nova-data/memory.json','PROJECT_MEMORY.md','nova.config.json','private.key','.github/token.pem'])('still rejects private dependency path %s',async path=>{
    const f=fixture()
    await expect(buildNativeArchive(f.root,f.out,[...f.files,{...f.files[0],path:'node_modules/example/'+path}])).rejects.toThrow('private or unapproved')
})
it('builds deterministic real archives and independently verifies contents',async()=>{
    const f=fixture(),a=await buildNativeArchive(f.root,f.out,f.files),b=await buildNativeArchive(f.root,join(f.dir,'second.tar.gz'),f.files)
    expect(a).toEqual(b);expect(readFileSync(f.out)).toEqual(readFileSync(join(f.dir,'second.tar.gz')))
})
it.each(['hash','size','duplicate','missing','private','traversal','hardlink','inside'])('rejects %s input without a successful package receipt',async mode=>{
    const f=fixture()
    if(mode==='hash')f.files[0].sha256='a'.repeat(64)
    if(mode==='size')f.files[0].size++
    if(mode==='duplicate')f.files.push(f.files[0])
    if(mode==='missing')f.files.shift()
    if(mode==='private')f.files.push({...f.files[0],path:'dist/.env'})
    if(mode==='traversal')f.files[0].path='../escape'
    if(mode==='hardlink')linkSync(join(f.root,'dist/daemon.js'),join(f.root,'alias'))
    if(mode==='inside')f.out=join(f.root,'archive.tar.gz')
    await expect(buildNativeArchive(f.root,f.out,f.files)).rejects.toThrow()
})
it('never overwrites existing output',async()=>{
    const f=fixture();writeFileSync(f.out,'preserved');await expect(buildNativeArchive(f.root,f.out,f.files)).rejects.toThrow();expect(readFileSync(f.out,'utf8')).toBe('preserved')
})
it('preserves explicitly approved executable mode in signed archive bytes',async()=>{
    const f=fixture();const files=f.files.map(e=>({...e,mode:(e.path==='dist/daemon.js'?0o755:0o644) as 0o755|0o644}))
    if(process.platform!=='win32'){
        const {chmodSync}=await import('node:fs');chmodSync(join(f.root,'dist/daemon.js'),0o755)
    }
    await buildNativeArchive(f.root,f.out,files)
    expect(gunzipSync(readFileSync(f.out)).subarray(100,107).toString()).toBe('0000755')
})
it('rejects unapproved privilege modes',async()=>{
    const f=fixture();await expect(buildNativeArchive(f.root,f.out,f.files.map(e=>({...e,mode:0o4755 as any})))).rejects.toThrow()
})
it('admits explicitly required release assets without admitting live configuration',async()=>{
    const f=fixture();mkdirSync(join(f.root,'assets'))
    for(const path of ['assets/fixture.txt','SOUL.md','LICENSE','THIRD_PARTY_NOTICES.md','xaventra.config.example.json']){
        const body='fixture';writeFileSync(join(f.root,path),body);f.files.push({path,size:body.length,sha256:createHash('sha256').update(body).digest('hex')})
    }
    await expect(buildNativeArchive(f.root,f.out,f.files)).resolves.toHaveProperty('treeHash')
    await expect(buildNativeArchive(f.root,join(f.dir,'bad.tar.gz'),[...f.files,{...f.files[0],path:'xaventra.config.json'}])).rejects.toThrow('private or unapproved')
})
