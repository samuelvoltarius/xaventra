import { closeSync,constants,createReadStream,fchmodSync,fstatSync,fsyncSync,lstatSync,mkdirSync,mkdtempSync,openSync,realpathSync,writeSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import { verifyNativeArchive,stageNativeArchiveBytes } from '../core/native-archive.js'
import { verifyNativeReleaseEvidence } from '../core/native-release-evidence.js'
import { verifyNativeInstalledRelease } from './native-program-verifier.js'
import { protectControllerDirectory } from './repair-controller-files.js'
import type { GitHubUpdatePolicy,SignedUpstreamManifest } from '../core/github-update.js'

const identity=(s:ReturnType<typeof lstatSync>)=>[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':')
/** Protected host component, NOT an installer/activation command. All identities
 * and paths must come from independent operator enrollment. Never invokes code,
 * copies runtime state, overwrites a release, creates units or changes pointers.
 * Failures retain staging without a success receipt; callers must not enroll it.
 * Does not defend against a concurrently malicious privileged operator. */
export async function stageSignedNativePackage(signed:SignedUpstreamManifest,policy:GitHubUpdatePolicy,
    expected:Parameters<typeof verifyNativeReleaseEvidence>[2],descriptorBytes:Buffer,
    paths:{archive:string;parent:string}) {
    // Snapshot mutable caller inputs before asynchronous work.
    signed=structuredClone(signed);policy=structuredClone(policy);expected=structuredClone(expected);descriptorBytes=Buffer.from(descriptorBytes)
    const evidence=verifyNativeReleaseEvidence(signed,policy,expected,descriptorBytes)
    if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Native staging requires Linux root')
    const parent=resolve(paths.parent),archive=resolve(paths.archive)
    protectControllerDirectory(parent);protectControllerDirectory(dirname(archive))
    const before=lstatSync(archive)
    if(!before.isFile()||before.nlink!==1||before.uid!==0||before.mode&0o6022||realpathSync(archive)!==archive
        ||before.size!==evidence.descriptor.archive.size)throw Error('Native staging archive is not protected')
    let output:number|undefined,root:string|undefined,mode=0,remaining=0
    const unchanged=()=>{
        if(identity(before)!==identity(lstatSync(archive)))throw Error('Native staging archive changed')
    }
    const source=()=>{
        unchanged()
        const fd=openSync(archive,constants.O_RDONLY|constants.O_NOFOLLOW)
        if(identity(before)!==identity(fstatSync(fd))){closeSync(fd);throw Error('Native staging opened archive changed')}
        // Each verifier stream owns its descriptor, including on destroy/error.
        // Never reuse or synchronously close a descriptor owned by a stream.
        return createReadStream(archive,{fd,autoClose:true})
    }
    const commitment={...evidence.descriptor.archive,treeHash:expected.treeHash}
    try{
        unchanged()
        // Authenticate the entire canonical payload before any staging write.
        await verifyNativeArchive(source(),commitment)
        unchanged();protectControllerDirectory(parent)
        root=mkdtempSync(join(parent,'native-stage-'))
        const directories=new Set([root])
        const result=await stageNativeArchiveBytes(source(),commitment,{
            begin(file){
                if(output!==undefined)throw Error('Native staging file overlap')
                // The shared canonical parser rejects traversal, links, duplicate
                // names and file/directory conflicts before invoking this sink.
                let dir=root!
                for(const part of file.path.split('/').slice(0,-1)){
                    dir=join(dir,part)
                    if(!directories.has(dir)){mkdirSync(dir,{mode:0o755});directories.add(dir)}
                }
                output=openSync(join(root!,file.path),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
                mode=file.mode;remaining=file.size
            },
            write(bytes){
                if(output===undefined||bytes.length>remaining)throw Error('Native staging payload mismatch')
                let offset=0
                while(offset<bytes.length){const n=writeSync(output,bytes,offset,bytes.length-offset);if(n<1)throw Error('Native staging short write');offset+=n}
                remaining-=bytes.length
            },
            end(){
                if(output===undefined||remaining)throw Error('Native staging incomplete file')
                fchmodSync(output,mode);fsyncSync(output);closeSync(output);output=undefined
            },
        })
        unchanged()
        // Includes independent archive recheck, two disk inventories and exact
        // signed file-mode comparison. Never reuse the streaming sink as proof.
        const verified=await verifyNativeInstalledRelease(signed,policy,expected,descriptorBytes,{root,archive})
        for(const dir of [...directories].reverse().concat(parent)){
            const d=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
            try{fsyncSync(d)}finally{closeSync(d)}
        }
        unchanged()
        return {...verified,root,files:result.length,staged:true as const,activated:false as const}
    }catch(error){
        throw new Error(root?`Native staging failed; untrusted partial output retained at ${root}`:'Native staging refused before output',{cause:error})
    }finally{if(output!==undefined)closeSync(output)}
}
