import { existsSync,mkdirSync } from 'node:fs'
import { join,resolve,dirname,basename } from 'node:path'
import { createHash } from 'node:crypto'
import { writeUpdateState } from '../core/update-store.js'
import { verifyNativeReleaseEvidence } from '../core/native-release-evidence.js'
import { verifyNativeInstalledRelease } from './native-program-verifier.js'
import { stageSignedNativePackage } from './native-package-stage.js'
import { protectControllerDirectory,readProtectedControllerFile } from './repair-controller-files.js'

type StageArgs=Parameters<typeof stageSignedNativePackage>
/** One operator-bound staging request, durable before extraction. A crash or
 * failure leaves intent/lock and NEVER automatically repeats extraction.
 * Completed replay revalidates actual signed archive/tree, not just a receipt.
 * This is staging only, not service activation or production enrollment. */
export async function stageSignedNativePackageOnce(requestId:string,receiptRoot:string,...args:StageArgs){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(requestId))throw Error('Native stage request identity invalid')
    const [signed,policy,expected,descriptor,paths]=args
    const input=[structuredClone(signed),structuredClone(policy),structuredClone(expected),Buffer.from(descriptor),{
        archive:resolve(paths.archive),parent:resolve(paths.parent),
    }] as StageArgs
    verifyNativeReleaseEvidence(input[0],input[1],input[2],input[3])
    if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Native staging journal requires Linux root')
    receiptRoot=resolve(receiptRoot);protectControllerDirectory(receiptRoot)
    const bindingHash=createHash('sha256').update(JSON.stringify([input[0],input[1],input[2],input[3].toString('base64'),input[4]])).digest('hex')
    const receipt=join(receiptRoot,`${requestId}.json`),lock=join(receiptRoot,`${requestId}.lock`)
    if(existsSync(receipt)){
        const prior=JSON.parse(readProtectedControllerFile(receipt,true))
        if(prior.schema!==1||prior.bindingHash!==bindingHash)throw Error('Native stage replay binding mismatch')
        if(prior.status!=='staged')throw Error('Native stage intent requires independent reconciliation; extraction not repeated')
        if(typeof prior.root!=='string'||dirname(prior.root)!==input[4].parent||!/^native-stage-[a-zA-Z0-9]+$/.test(basename(prior.root)))throw Error('Native stage receipt root mismatch')
        const verified=await verifyNativeInstalledRelease(input[0],input[1],input[2],input[3],{archive:input[4].archive,root:prior.root})
        return {...verified,root:prior.root,staged:true as const,activated:false as const,replayed:true}
    }
    // mkdir provides exclusive admission. Locks are permanent request markers;
    // no automatic stale-lock deletion or guessing about interrupted writes.
    mkdirSync(lock,{mode:0o700})
    writeUpdateState(receipt,{schema:1,bindingHash,status:'intent'})
    const staged=await stageSignedNativePackage(...input)
    writeUpdateState(receipt,{schema:1,bindingHash,status:'staged',root:staged.root})
    return {...staged,replayed:false}
}
