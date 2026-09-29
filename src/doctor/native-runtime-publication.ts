import { existsSync,mkdirSync,openSync,closeSync,fchmodSync,fsyncSync,constants } from 'node:fs'
import { join,resolve,dirname,basename } from 'node:path'
import { repairHash } from './repair-activation.js'
import { writeUpdateState } from '../core/update-store.js'
import { protectControllerDirectory,readProtectedControllerFile } from './repair-controller-files.js'
import { stageSignedNativePackage } from './native-package-stage.js'
import { verifyNativeInstalledRelease } from './native-program-verifier.js'
import { verifyNativeRuntimeAccess,type NativeRuntimeAccount } from './native-runtime-access.js'

type StageArgs=Parameters<typeof stageSignedNativePackage>
/** Explicit operator-bound publication, NOT service selection or activation.
 * Re-extracts authenticated bytes into a separate fresh root. Signed file modes
 * are never changed; only the verified new root becomes traversable. */
export async function publishNativeRuntimeOnce(id:string,receipts:string,account:NativeRuntimeAccount,...args:StageArgs){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw Error('Native publication identity invalid')
    if(!account||![account.uid,account.gid].every(n=>Number.isSafeInteger(n)&&n>0&&n<0xffffffff))throw Error('Unprivileged native runtime account required')
    if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Native publication requires Linux root')
    account=structuredClone(account)
    const input=[structuredClone(args[0]),structuredClone(args[1]),structuredClone(args[2]),Buffer.from(args[3]),{
        archive:resolve(args[4].archive),parent:resolve(args[4].parent),
    }] as StageArgs
    receipts=resolve(receipts);protectControllerDirectory(receipts);protectControllerDirectory(input[4].parent)
    const binding=repairHash({account,input:[input[0],input[1],input[2],input[3].toString('base64'),input[4]]})
    const path=join(receipts,`${id}.publication.json`),lock=join(receipts,`${id}.publication.lock`)
    if(existsSync(path)){
        const prior=JSON.parse(readProtectedControllerFile(path,true))
        if(prior.schema!==1||prior.binding!==binding)throw Error('Native publication binding mismatch')
        if(prior.status!=='published')throw Error('Native publication intent requires reconciliation')
        if(typeof prior.root!=='string'||dirname(prior.root)!==input[4].parent||!/^native-stage-[A-Za-z0-9]+$/.test(basename(prior.root)))throw Error('Native publication root mismatch')
        await verifyNativeInstalledRelease(input[0],input[1],input[2],input[3],{archive:input[4].archive,root:prior.root})
        verifyNativeRuntimeAccess(prior.root,account)
        return {root:prior.root,published:true as const,activated:false as const,replayed:true}
    }
    mkdirSync(lock,{mode:0o700});writeUpdateState(path,{schema:1,binding,status:'intent'})
    const staged=await stageSignedNativePackage(...input)
    const fd=openSync(staged.root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    try{
        fchmodSync(fd,0o755);fsyncSync(fd)
        verifyNativeRuntimeAccess(staged.root,account)
        await verifyNativeInstalledRelease(input[0],input[1],input[2],input[3],{archive:input[4].archive,root:staged.root})
        writeUpdateState(path,{schema:1,binding,status:'published',root:staged.root})
    }catch(error){
        // Only our fresh root is returned to private quarantine. No file mode,
        // existing release, original stage or receipt is silently repaired.
        fchmodSync(fd,0o700);fsyncSync(fd);throw error
    }finally{closeSync(fd)}
    return {root:staged.root,published:true as const,activated:false as const,replayed:false}
}
