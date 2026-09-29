// Actual payload acceptance with an EPHEMERAL fixture signer. No production
// publisher identity, service enrollment, runtime data or activation is used.
import { stageSignedNativePackageOnce } from '../src/doctor/native-stage-journal.ts'
import { NativeReleaseEnrollment } from '../src/doctor/native-release-enrollment.ts'
import { publishNativeRuntimeOnce } from '../src/doctor/native-runtime-publication.ts'
import { verifyNativeArchive } from '../src/core/native-archive.ts'
import { encodeNativeUpdatePackage } from '../src/core/update-package.ts'
import { createHash,generateKeyPairSync,sign } from 'node:crypto'
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,chmodSync,chownSync,createReadStream,constants,lstatSync } from 'node:fs'
import { dirname,join } from 'node:path'
import assert from 'node:assert/strict'
assert.equal(process.env.XAVENTRA_NATIVE_FIXTURE,'1');assert.equal(process.platform,'linux');assert.equal(process.getuid(),0)
const [reportPath,commit,approvedHash]=process.argv.slice(2)
assert.match(commit,/^[a-f0-9]{40}$/);assert.match(approvedHash,/^[a-f0-9]{64}$/)
const build=JSON.parse(readFileSync(reportPath,'utf8'))
assert.equal(build.commit,commit);assert.equal(build.passed,true);assert.equal(build.sourceDirty,false)
assert.equal(build.arch,process.arch);assert.equal(build.archive.sha256,approvedHash)
const source=join(dirname(reportPath),'payload.tar.gz'),s=lstatSync(source)
assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size===build.archive.size&&s.size<=2*1024**3)
const root=mkdtempSync('/var/lib/xaventra-native-real-stage-'),archive=join(root,'archive.gz')
const report={root,commit,version:build.version,archiveHash:approvedHash,passed:false,productionChanged:false,
    evidenceClass:'actual-Xaventra-native-payload-staging-with-ephemeral-fixture-signer-not-production-publisher-or-activation'}
try{
    copyFileSync(source,archive,constants.COPYFILE_EXCL);chownSync(archive,0,0);chmodSync(archive,0o600)
    await verifyNativeArchive(createReadStream(archive),build.archive)
    const hash=b=>createHash('sha256').update(b).digest('hex'),keys=generateKeyPairSync('ed25519')
    const bytes=encodeNativeUpdatePackage({schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version:build.version,commit,
        platform:'linux',arch:process.arch,treeHash:build.archive.treeHash,archive:{sha256:approvedHash,size:s.size},entrypoint:'dist/daemon.js'})
    const payload={schema:1,repository:'samuelvoltarius/xaventra',version:build.version,commit,minUpdater:'2.78.56',
        artifacts:[{name:`xaventra-native-${build.version}-linux-${process.arch}.tar.gz`,platform:'linux',arch:process.arch,size:bytes.length,sha256:hash(bytes)}]}
    const signed={keyId:'isolated-only',payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString('base64')}
    const policy={publisherKeys:{'isolated-only':keys.publicKey.export({type:'spki',format:'pem'}).toString()}}
    const expected={version:build.version,commit,arch:process.arch,updater:'2.78.56',treeHash:build.archive.treeHash,descriptorHash:hash(bytes)}
    const parent=join(root,'staging'),receipts=join(root,'receipts');mkdirSync(parent);mkdirSync(receipts)
    const result=await stageSignedNativePackageOnce('actual-payload',receipts,signed,policy,expected,bytes,{archive,parent})
    const replay=await stageSignedNativePackageOnce('actual-payload',receipts,signed,policy,expected,bytes,{archive,parent})
    assert.equal(replay.root,result.root);assert.equal(replay.replayed,true);assert.equal(result.replayed,false)
    report.stagedRoot=result.root;report.files=result.files;report.replayWithoutExtraction=true
    // Exercise the existing controller's publisher-verification boundary with
    // actual staged bytes. These two synthetic roles are NOT an update pair.
    const manifestPath=join(root,'manifest.json'),descriptorRecordPath=join(root,'descriptor.json'),publisherKeyPath=join(root,'publisher.pem')
    writeFileSync(manifestPath,JSON.stringify(signed),{flag:'wx',mode:0o600})
    writeFileSync(descriptorRecordPath,JSON.stringify({base64:bytes.toString('base64')}),{flag:'wx',mode:0o600})
    writeFileSync(publisherKeyPath,policy.publisherKeys['isolated-only'],{flag:'wx',mode:0o600})
    const binding={targetId:'isolated-stage-admission',baselineHash:'a'.repeat(64),candidateHash:'b'.repeat(64)}
    const ticket={...binding,attemptId:'repair-00000000-0000-0000-0000-000000000000',expiresAt:Date.now()+120000}
    const c={...expected,runtimeAccount:{uid:65534,gid:65534},sourceHash:binding.baselineHash,manifestPath,descriptorRecordPath,publisherKeyPath,publisherKeyId:'isolated-only',root:result.root,archive}
    const enrollment=join(root,'enrollment.json')
    writeFileSync(enrollment,JSON.stringify({schema:1,binding,releases:{old:c,next:{...c,sourceHash:binding.candidateHash}}}),{flag:'wx',mode:0o600})
    const registry=new NativeReleaseEnrollment(enrollment)
    const release={id:'old',sourceHash:binding.baselineHash,programHash:expected.treeHash,process:{runtimeAccount:c.runtimeAccount,executable:process.execPath,argv:[process.execPath,join(result.root,'dist/daemon.js')]}}
    // Private staging is deliberately not a runtime-visible installed release.
    await assert.rejects(registry.verify('old',release,ticket),/EACCES/)
    const pending=registry.verify('old',release,ticket)
    queueMicrotask(()=>{ticket.candidateHash='c'.repeat(64)})
    await assert.rejects(pending,/request changed during verification/)
    report.controllerAdmission=false;report.privateStagingRuntimeAdmissionRejected=true;report.concurrentRequestDriftRejected=true
    // Only the fresh fixture parent becomes traversable. Private stages and
    // archive/enrollment records remain private; publication creates a new tree.
    chmodSync(root,0o755)
    const runtimeParent=join(root,'runtime');mkdirSync(runtimeParent,{mode:0o755})
    const publish=()=>publishNativeRuntimeOnce('runtime',receipts,{uid:65534,gid:65534},signed,policy,expected,bytes,{archive,parent:runtimeParent})
    const installed=await publish(),again=await publish()
    assert.equal(again.root,installed.root);assert.equal(again.replayed,true)
    assert.equal(lstatSync(result.root).mode&0o777,0o700)
    report.runtimeRoot=installed.root;report.runtimePublication=true;report.runtimeReplayWithoutExtraction=true;report.passed=true
}catch(error){report.error=String(error.stack||error);throw error}
finally{writeFileSync(join(root,'evidence.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(report))}
