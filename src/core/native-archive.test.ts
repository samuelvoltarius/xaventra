import { it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { nativeArchiveHeader, verifyNativeArchive } from './native-archive.js'
import { releaseTreeHash } from './release-tree.js'

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex')
function fixture(entries = [{path:'dist/daemon.js',data:Buffer.from('real file bytes')},{path:'empty',data:Buffer.alloc(0)}]) {
    const raw = Buffer.concat([...entries.flatMap(f=>[nativeArchiveHeader(f.path,f.data.length),f.data,Buffer.alloc((512-f.data.length%512)%512)]),Buffer.alloc(1024)])
    const treeHash = releaseTreeHash(entries.map(f=>({path:f.path,size:f.data.length,sha256:hash(f.data)})).sort((a,b)=>a.path.localeCompare(b.path)))
    return {raw,treeHash}
}
function verify(raw:Buffer,treeHash:string,chunkSize=65536) {
    const compressed=gzipSync(raw)
    return verifyNativeArchive(Readable.from((function*(){for(let i=0;i<compressed.length;i+=chunkSize)yield compressed.subarray(i,i+chunkSize)})()),{sha256:hash(compressed),size:compressed.length,treeHash})
}
it.each([1,17,65536])('validates real compressed bytes across %s-byte input chunks',async n=>{
    const f=fixture();expect(await verify(f.raw,f.treeHash,n)).toHaveLength(2)
})
it('hashes files larger than stream chunks without buffering entire payload',async()=>{
    const f=fixture([{path:'dist/daemon.js',data:Buffer.alloc(200000,7)}]);expect((await verify(f.raw,f.treeHash))[0].size).toBe(200000)
})
it.each(['payload','link','hardlink','pax','checksum','padding','truncated','one-end','extra-end','after-end','duplicate','parent-file','bad-mode','wrong-tree'])('rejects %s even with correctly committed compressed bytes',async mode=>{
    const f=fixture();let raw=Buffer.from(f.raw),tree=f.treeHash
    if(mode==='payload')raw[512]^=1
    if(mode==='link')raw[156]=50
    if(mode==='hardlink')raw[156]=49
    if(mode==='pax')raw[156]=120
    if(mode==='checksum')raw[148]^=1
    if(mode==='padding')raw[600]=1
    if(mode==='truncated')raw=raw.subarray(0,520)
    if(mode==='one-end')raw=raw.subarray(0,raw.length-512)
    if(mode==='extra-end')raw=Buffer.concat([raw,Buffer.alloc(512)])
    if(mode==='after-end')raw=Buffer.concat([raw,nativeArchiveHeader('later',0)])
    if(mode==='duplicate')raw=Buffer.concat([raw.subarray(0,1536),nativeArchiveHeader('empty',0),Buffer.alloc(1024)])
    if(mode==='parent-file')raw=Buffer.concat([nativeArchiveHeader('dist',0),raw])
    if(mode==='bad-mode')raw.write('0000777\0',100)
    if(mode==='wrong-tree')tree='f'.repeat(64)
    await expect(verify(raw,tree)).rejects.toThrow()
})
it.each(['../escape','/absolute','C:/drive','a\\b','a//b','a/./b','a\nb'])('refuses unsafe path %s',path=>{
    expect(()=>nativeArchiveHeader(path,0)).toThrow()
})
it('rejects compressed digest/length disagreement and corrupt gzip',async()=>{
    const f=fixture(),b=gzipSync(f.raw),expected={sha256:hash(b),size:b.length,treeHash:f.treeHash}
    await expect(verifyNativeArchive(Readable.from([b]),{...expected,sha256:'f'.repeat(64)})).rejects.toThrow()
    await expect(verifyNativeArchive(Readable.from([b]),{...expected,size:b.length-1})).rejects.toThrow()
    b[b.length-1]^=1
    await expect(verifyNativeArchive(Readable.from([b]),expected)).rejects.toThrow()
})
