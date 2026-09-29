import { join, resolve } from 'node:path'
import { readProtectedControllerFile } from './repair-controller-files.js'
import { verifyNativeInstalledRelease } from './native-program-verifier.js'
import { verifyNativeRuntimeAccess, type NativeRuntimeAccount } from './native-runtime-access.js'
import { repairHash, type RepairBinding, type RepairTicket } from './repair-activation.js'
import { EnrolledNativeUpdateOperations, type NativeOperationsAuthority, type NativeOperationsEnrollment } from './native-update-operations.js'
import type { NativeRelease } from './native-update-driver.js'
import type { NativeSelectedRelease } from './native-release-selection.js'

interface ReleaseEvidenceEnrollment {
    version:string; updater:string; arch:'x64'|'arm64'; commit:string
    sourceHash:string; treeHash:string; descriptorHash:string
    manifestPath:string; descriptorRecordPath:string; publisherKeyPath:string; publisherKeyId:string
    root:string; archive:string
    runtimeAccount:NativeRuntimeAccount
}
interface Enrollment { schema:1; binding:RepairBinding; releases:Record<string,ReleaseEvidenceEnrollment> }
/** Operator-owned 0600 enrollment, not downloaded manifest authority. Every
 * verify rereads protected files and actual bytes; no cached success receipt. */
export class NativeReleaseEnrollment {
    private config:Enrollment
    private identity:string
    constructor(private path:string){
        const text=readProtectedControllerFile(path,true)
        this.config=JSON.parse(text);this.identity=repairHash(text)
        if(this.config.schema!==1||!this.config.binding||!this.config.releases||Object.keys(this.config.releases).length!==2)throw Error('Native release evidence enrollment invalid')
    }
    async verify(id:string,release:NativeRelease & NativeSelectedRelease,ticket:RepairTicket):Promise<boolean>{
        // Full archive/tree scans yield; success must remain bound to the
        // exact request admitted before that asynchronous work.
        const callerRelease=release,callerTicket=ticket
        const requestIdentity=repairHash({release,ticket})
        release=structuredClone(release);ticket=structuredClone(ticket)
        if(repairHash(readProtectedControllerFile(this.path,true))!==this.identity)throw Error('Native release enrollment changed')
        const {attemptId,expiresAt,...binding}=ticket
        if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||repairHash(binding)!==repairHash(this.config.binding)
            || !Object.hasOwn(this.config.releases,id))throw Error('Native release evidence ticket mismatch')
        const c=this.config.releases[id]
        if(release.id!==id||release.sourceHash!==c.sourceHash||release.programHash!==c.treeHash
            || release.packageHash!==undefined&&release.packageHash!==c.descriptorHash
            || ![ticket.baselineHash,ticket.candidateHash].includes(c.sourceHash))throw Error('Native driver evidence identity mismatch')
        // Executable identity itself is verified by the service observer. Bind
        // its script argument to THIS verified tree, not another JS file.
        const p=release.process
        if(!c.runtimeAccount||!p?.runtimeAccount||repairHash(p.runtimeAccount)!==repairHash(c.runtimeAccount))throw Error('Native runtime account enrollment mismatch')
        if(!p||p.argv[0]!==p.executable||p.argv[1]!==join(resolve(c.root),'dist','daemon.js'))throw Error('Native program entrypoint enrollment mismatch')
        const key=readProtectedControllerFile(c.publisherKeyPath)
        const signed=JSON.parse(readProtectedControllerFile(c.manifestPath))
        const record=JSON.parse(readProtectedControllerFile(c.descriptorRecordPath))
        if(typeof record.base64!=='string'||record.base64.length>32768)throw Error('Native descriptor record invalid')
        const bytes=Buffer.from(record.base64,'base64')
        if(bytes.toString('base64')!==record.base64)throw Error('Native descriptor encoding invalid')
        await verifyNativeInstalledRelease(signed,{publisherKeys:{[c.publisherKeyId]:key}},c,bytes,{root:c.root,archive:c.archive})
        if(repairHash({release:callerRelease,ticket:callerTicket})!==requestIdentity)throw Error('Native release request changed during verification')
        verifyNativeRuntimeAccess(c.root,c.runtimeAccount)
        if(repairHash(readProtectedControllerFile(this.path,true))!==this.identity)throw Error('Native release enrollment changed during verification')
        return ticket.expiresAt>Date.now()
    }
}

/** Production-facing composition cannot supply an always-true publisher hook.
 * Lease/fence/readiness are independent and still require real enrollment. */
export function createPublisherVerifiedNativeOperations(config:NativeOperationsEnrollment,
    authority:Omit<NativeOperationsAuthority,'verifyRelease'>, evidenceFile:string):EnrolledNativeUpdateOperations {
    const enrolled=structuredClone(config),verifier=new NativeReleaseEnrollment(evidenceFile)
    if(enrolled.rollback){
        const original=enrolled.releases[enrolled.baseline].process
        if(enrolled.rollback.process.argv[0]!==original.argv[0]||enrolled.rollback.process.argv[1]!==original.argv[1])throw Error('Rollback must execute original verified entrypoint')
    }
    return new EnrolledNativeUpdateOperations(enrolled,{...authority,
        verifyRelease:async(id,ticket)=>verifier.verify(id,enrolled.releases[id],ticket)})
}
