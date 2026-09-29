import { readFileSync,openSync,readSync,closeSync,lstatSync,realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { buildNativeArchive, type NativeBuildFileEvidence } from './native-package-builder.js'
import { nativeArchiveHeader } from './native-archive.js'

/** Header validation only, never loads binaries. Not an ABI/libc compatibility
 * proof. All ELF files must be little-endian ELF64 for the requested machine. */
export function validateNativeBinaryHeader(path:string,header:Buffer,arch:'x64'|'arm64'):boolean {
    const elf=header.subarray(0,4).equals(Buffer.from([127,69,76,70]))
    const required=/\.(?:node|so(?:\.\d+)*)$/i.test(path)
    if(!elf){
        if(required||header.subarray(0,2).toString()==='MZ'||['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe'].includes(header.subarray(0,4).toString('hex')))throw Error('Native build contains non-Linux binary')
        return false
    }
    if(header.length<64||header[4]!==2||header[5]!==1||header[6]!==1||header.readUInt16LE(18)!==(arch==='x64'?62:183)
        ||![2,3].includes(header.readUInt16LE(16)))throw Error('Native build ELF architecture/type mismatch')
    return true
}

/** Build-stage gate. Expected identity comes from the clean build job, not from
 * payload metadata. Source revision provenance and secret scans remain CI gates. */
export async function buildQualifiedNativeArchive(root:string,output:string,files:NativeBuildFileEvidence[],expected:{version:string;commit:string;arch:'x64'|'arm64'}){
    if(!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(expected.version)||!/^[a-f0-9]{40}$/.test(expected.commit)||!['x64','arm64'].includes(expected.arch))throw Error('Native build expected identity invalid')
    root=resolve(root)
    if(realpathSync(root)!==root||files.length>100000)throw Error('Native build root/budget invalid')
    let total=0;const deadline=Date.now()+60000
    for(const f of files){nativeArchiveHeader(f.path,f.size);total+=f.size;if(total>2*1024**3)throw Error('Native build byte budget exceeded')}
    // Qualify immutable approved bytes, then let the producer rehash every file
    // during packaging. Changed contents cannot inherit this qualification.
    const metadata=(name:string)=>{
        const f=files.find(f=>f.path===name)
        if(!f||f.size>16*1024*1024)throw Error('Native build metadata missing/oversized')
        const path=resolve(root,name),s=lstatSync(path)
        if(!s.isFile()||s.nlink!==1||s.size!==f.size||realpathSync(path)!==path)throw Error('Native build metadata path invalid')
        const bytes=readFileSync(path)
        if(bytes.length!==f.size||createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw Error('Native build metadata hash mismatch')
        return JSON.parse(bytes.toString('utf8'))
    }
    const pkg=metadata('package.json'),lock=metadata('package-lock.json')
    if(pkg.name!=='@xaventra/core'||pkg.version!==expected.version||pkg.type!=='module'||pkg.main!=='dist/daemon.js'
        ||lock.name!==pkg.name||lock.version!==pkg.version||lock.lockfileVersion!==3||lock.packages?.['']?.version!==pkg.version)throw Error('Native build package/lock identity mismatch')
    let binaries=0
    for(const f of files){
        // The producer validates all paths before any reads; repeat that safe
        // relative-path boundary here before header observation.
        if(!f.path||f.path.startsWith('/')||/[:\\\x00-\x1f]/.test(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Native build path invalid')
        const path=resolve(root,f.path),s=lstatSync(path)
        if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==f.size||realpathSync(path)!==path)throw Error('Native build file identity invalid')
        const fd=openSync(path,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let count=0,header=Buffer.alloc(0)
        try{while(true){if(Date.now()>deadline)throw Error('Native build time budget exceeded');const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;if(!count)header=Buffer.from(buffer.subarray(0,Math.min(n,64)));count+=n;if(count>f.size)throw Error('Native build file grew');hash.update(buffer.subarray(0,n))}}finally{closeSync(fd)}
        if(count!==f.size||hash.digest('hex')!==f.sha256)throw Error('Native build file hash mismatch')
        try{if(validateNativeBinaryHeader(f.path,header,expected.arch))binaries++}
        catch(error){throw Error(`${(error as Error).message}: ${f.path}`)}
    }
    const archive=await buildNativeArchive(root,output,files)
    return {...archive,...expected,binaries,evidenceClass:'package-lock-and-ELF-header-qualified-not-runtime-or-source-provenance'}
}
