import { createHash } from 'node:crypto'
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readSync, opendirSync, realpathSync } from 'node:fs'
import { verifyNativeArchive } from '../core/native-archive.js'
import { dirname, join, resolve } from 'node:path'
import { releaseTreeHash, type ReleaseFileEvidence } from '../core/release-tree.js'
import { verifyNativeReleaseEvidence } from '../core/native-release-evidence.js'
import type { GitHubUpdatePolicy, SignedUpstreamManifest } from '../core/github-update.js'
import { protectControllerDirectory } from './repair-controller-files.js'

const MAX_BYTES = 2 * 1024 ** 3, MAX_ENTRIES = 100_000
function identity(s: ReturnType<typeof lstatSync>): string {
    return [s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':')
}
/** Linux root observer only. Root-owned, runtime-nonwritable paths are required;
 * this is not protection against a concurrently malicious privileged operator. */
export function nativeProgramInventory(root: string): ReleaseFileEvidence[] {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('Native program verification requires Linux root')
    root = resolve(root); protectControllerDirectory(root)
    const deadline=Date.now()+60_000, files:ReleaseFileEvidence[]=[]
    let entries=0, bytes=0
    const visit=(directory:string, prefix:string, depth:number) => {
        if(depth>64 || Date.now()>deadline)throw Error('Native program traversal budget exceeded')
        const before=lstatSync(directory)
        if(!before.isDirectory() || before.uid!==0 || before.mode&0o6022 || realpathSync(directory)!==directory)throw Error('Native program directory is not protected')
        const handle=opendirSync(directory)
        try { for(let entry=handle.readSync();entry;entry=handle.readSync()){
            const name=entry.name
            if(++entries>MAX_ENTRIES || !name || /[\x00-\x1f\x7f\\]/.test(name))throw Error('Native program inventory budget or path invalid')
            const path=join(directory,name),rel=prefix?`${prefix}/${name}`:name,s=lstatSync(path)
            if(s.isDirectory())visit(path,rel,depth+1)
            else{
                if(!s.isFile() || s.isSymbolicLink() || s.nlink!==1 || s.uid!==0 || s.mode&0o6022)throw Error('Native program file is not protected')
                bytes+=s.size
                if(!Number.isSafeInteger(bytes) || bytes>MAX_BYTES)throw Error('Native program byte budget exceeded')
                files.push({path:rel,size:s.size,sha256:protectedFileHash(path,s.size,deadline)})
            }
        }}finally{handle.closeSync()}
        if(identity(lstatSync(directory))!==identity(before))throw Error('Native program directory changed during scan')
    }
    visit(root,'',0)
    if(!files.some(f=>f.path==='dist/daemon.js'))throw Error('Native daemon entrypoint missing')
    return files.sort((a,b)=>a.path.localeCompare(b.path))
}
function protectedFileHash(path:string, size:number, deadline:number):string{
    const before=lstatSync(path)
    if(!before.isFile() || before.nlink!==1 || before.uid!==0 || before.mode&0o6022
        || before.size!==size || size>MAX_BYTES || realpathSync(path)!==path)throw Error('Native artifact file is not protected')
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024)
    try{
        if(identity(fstatSync(fd))!==identity(before))throw Error('Native artifact changed before read')
        let count=0
        while(true){
            if(Date.now()>deadline)throw Error('Native artifact read budget exceeded')
            const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break
            count+=n;if(count>size)throw Error('Native artifact grew during read');hash.update(buffer.subarray(0,n))
        }
        if(count!==size || identity(fstatSync(fd))!==identity(before) || identity(lstatSync(path))!==identity(before))throw Error('Native artifact changed during read')
        return hash.digest('hex')
    }finally{closeSync(fd)}
}
/** Verify signed commitments AND actual bytes. Never extracts or executes them.
 * Enrollment/expected values and publisher keys must come from protected host
 * configuration. Canonical archive contents and installed tree must agree;
 * safe extraction and executable/unit enrollment are separate obligations. */
export async function verifyNativeInstalledRelease(signed:SignedUpstreamManifest, policy:GitHubUpdatePolicy,
    expected:Parameters<typeof verifyNativeReleaseEvidence>[2], descriptorBytes:Buffer,
    paths:{root:string;archive:string}) {
    const evidence=verifyNativeReleaseEvidence(signed,policy,expected,descriptorBytes)
    if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Native program verification requires Linux root')
    const archive=resolve(paths.archive);protectControllerDirectory(dirname(archive))
    const archiveBefore=identity(lstatSync(archive))
    if(protectedFileHash(archive,evidence.descriptor.archive.size,Date.now()+60_000)!==evidence.descriptor.archive.sha256)throw Error('Native archive hash mismatch')
    const fd=openSync(archive,constants.O_RDONLY|constants.O_NOFOLLOW)
    if(identity(fstatSync(fd))!==archiveBefore){closeSync(fd);throw Error('Native archive changed before inventory')}
    // The stream owns this descriptor. A second synchronous close races its
    // asynchronous cleanup and can close a newly reused directory descriptor.
    await verifyNativeArchive(createReadStream(archive,{fd,autoClose:true}), {...evidence.descriptor.archive,treeHash:expected.treeHash})
    const first=nativeProgramInventory(paths.root), second=nativeProgramInventory(paths.root)
    if(releaseTreeHash(first)!==expected.treeHash || releaseTreeHash(second)!==expected.treeHash
        || archiveBefore!==identity(lstatSync(archive)))throw Error('Native installed program tree or archive mismatch')
    return {...evidence,installedTreeVerified:true as const,archiveTreeVerified:true as const,files:first.length}
}
