import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { nativeArchiveHeader, verifyNativeArchive } from './native-archive.js'
import { releaseTreeHash, type ReleaseFileEvidence } from './release-tree.js'

const identity = (s: ReturnType<typeof lstatSync>) => [s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeMs,s.ctimeMs].join(':')
export interface NativeBuildFileEvidence extends ReleaseFileEvidence { mode?: 0o600 | 0o644 | 0o755 }
/** Offline build-stage producer. Input is an independently approved build
 * inventory, NOT runtime discovery. No signing keys, loading code or extraction.
 * Failed/partial output is retained; only a resolved result authorizes signing. */
export async function buildNativeArchive(root: string, output: string, approved: NativeBuildFileEvidence[]) {
    root=resolve(root); output=resolve(output)
    const inside=(p:string)=>p===root||p.startsWith(root+sep)
    if(inside(output)||inside(realpathSync(dirname(output))))throw Error('Native package output must be outside source')
    if(realpathSync(root)!==root||!lstatSync(root).isDirectory())throw Error('Native package source root invalid')
    const files=structuredClone(approved).sort((a,b)=>a.path.localeCompare(b.path)), paths=new Set<string>()
    let total=0
    if(!files.length||files.length>100000)throw Error('Native package inventory budget invalid')
    for(const f of files){
        nativeArchiveHeader(f.path,f.size,f.mode??0o644)
        if(!/^[a-f0-9]{64}$/.test(f.sha256)||paths.has(f.path))throw Error('Native package inventory invalid')
        if(!/^(?:dist\/|node_modules\/|assets\/|package\.json$|package-lock\.json$|SOUL\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$|xaventra\.config\.example\.json$)/.test(f.path)
            || f.path.split('/').some(p=>/^\.(?:env|nova)/i.test(p)
                || (/^\.git/i.test(p) && !(f.path.startsWith('node_modules/') && /^\.(?:github|gitkeep|gitattributes|gitignore|gitmodules)$/i.test(p)))
                || /^(?:PROJECT_MEMORY\.md|(?:nova|xaventra)\.config\.json)$/i.test(p)||/\.(?:pem|key|p12|pfx)$/i.test(p)))throw Error('Native package private or unapproved path')
        paths.add(f.path);total+=f.size
        if(total>2*1024**3)throw Error('Native package byte budget exceeded')
    }
    if(!paths.has('dist/daemon.js')||!paths.has('package.json'))throw Error('Native package entrypoint/metadata missing')
    const check=(relative:string)=>{
        const parts=relative.split('/');let p=root
        for(let i=0;i<parts.length;i++){
            p=resolve(p,parts[i]);const s=lstatSync(p)
            if(!inside(p)||s.isSymbolicLink()||realpathSync(p)!==p|| (i<parts.length-1?!s.isDirectory():!s.isFile()||s.nlink!==1))throw Error('Native package source link or type invalid')
        }
        return lstatSync(p)
    }
    const initial=files.map(f=>{
        const s=check(f.path)
        if(s.size!==f.size)throw Error('Native package source size changed')
        if(process.platform!=='win32' && ((s.mode&0o6022)!==0 || Boolean(s.mode&0o111)!==((f.mode??0o644)===0o755)))throw Error('Native package executable mode requires explicit matching approval')
        return identity(s)
    })
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),60_000),compressedHash=createHash('sha256')
    let size=0
    try{
        await pipeline(Readable.from((async function*(){
            for(let i=0;i<files.length;i++){
                const f=files[i],s=check(f.path)
                if(identity(s)!==initial[i])throw Error('Native package source changed before read')
                const handle=await open(resolve(root,f.path),'r')
                try{
                    if(identity(await handle.stat())!==initial[i])throw Error('Native package opened source changed')
                    yield nativeArchiveHeader(f.path,f.size,f.mode??0o644)
                    const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let count=0
                    while(true){
                        if(abort.signal.aborted)throw Error('Native package time budget exceeded')
                        const {bytesRead}=await handle.read(buffer,0,buffer.length,null)
                        if(!bytesRead)break
                        count+=bytesRead;if(count>f.size)throw Error('Native package source grew')
                        const chunk=Buffer.from(buffer.subarray(0,bytesRead));hash.update(chunk);yield chunk
                    }
                    if(count!==f.size||hash.digest('hex')!==f.sha256||identity(await handle.stat())!==initial[i]||identity(check(f.path))!==initial[i])throw Error('Native package source hash/identity mismatch')
                    yield Buffer.alloc((512-f.size%512)%512)
                }finally{await handle.close()}
            }
            yield Buffer.alloc(1024)
        })()),createGzip({level:9}),async function*(input){
            for await(const chunk of input){size+=chunk.length;if(size>2*1024**3)throw Error('Native package compressed budget exceeded');compressedHash.update(chunk);yield chunk}
        },createWriteStream(output,{flags:'wx',mode:0o600,flush:true}),{signal:abort.signal})
        const result={sha256:compressedHash.digest('hex'),size,treeHash:releaseTreeHash(files)}
        await verifyNativeArchive(createReadStream(output),result)
        return result
    }finally{clearTimeout(timer)}
}
