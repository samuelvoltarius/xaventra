// Explicit opt-in, disposable PRIVATE mount namespace. No production paths.
import { verifyNativeReadOnlyMount } from '../src/doctor/native-state-mount.ts'
import { NativeSnapshotAdapter } from '../src/doctor/native-snapshot-adapter.ts'
import { NativeSystemdService } from '../src/doctor/native-systemd-service.ts'
import { NativeStateHelper } from '../src/doctor/native-state-helper.ts'
import { EnrolledNativeUpdateOperations } from '../src/doctor/native-update-operations.ts'
import { NativeUpdateDriver } from '../src/doctor/native-update-driver.ts'
import { NativeRollbackState } from '../src/doctor/native-rollback-state.ts'
import { UpdateActivationController } from '../src/core/update-activation.ts'
import { signRepairValue } from '../src/doctor/repair-activation.ts'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, statSync, chmodSync, chownSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

assert.equal(process.env.XAVENTRA_NATIVE_FIXTURE, '1')
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0)
const positiveRollback = process.env.XAVENTRA_NATIVE_ROLLBACK_FIXTURE === '1'
const namespace = readlinkSync('/proc/self/ns/mnt')
assert.notEqual(namespace, readlinkSync('/proc/1/ns/mnt'), 'Run with unshare --mount --propagation private')
const run = (bin, args) => execFileSync(bin, args, { timeout: 10000, maxBuffer: 65536, stdio: ['ignore','pipe','pipe'] })
// Ensure fixture mounts cannot propagate out, even if caller omitted the flag.
run('/usr/bin/mount', ['--make-rprivate', '/'])
const root = mkdtempSync('/var/lib/xaventra-state-mount-'); chmodSync(root,0o755)
const source = join(root, 'source'), view = join(root, 'readonly-view'), candidate = join(root, 'candidate')
for (const p of [source, view, candidate]) mkdirSync(p)
let sourceMounted = false, viewMounted = false
let fixtureUnit
try {
    run('/usr/bin/mount', ['-t','tmpfs','-o','size=4m,nosuid,nodev,noexec','xaventra-fixture',source]); sourceMounted = true
    writeFileSync(join(source,'memory.json'), '{"preserve":"baseline"}')
    writeFileSync(join(source,'audit.jsonl'), 'fixture evidence\n')
    run('/usr/bin/mount', ['--bind',source,view]); viewMounted = true
    run('/usr/bin/mount', ['-o','remount,bind,ro',view])
    const entry = readFileSync('/proc/self/mountinfo','utf8').split('\n').map(l=>l.split(' ')).find(f=>f[4]===view)
    assert.ok(entry)
    const profile = { path:view, namespace, device:entry[2], inode:statSync(view,{bigint:true}).ino.toString(), fsType:'tmpfs' }
    await assert.rejects(()=>verifyNativeReadOnlyMount(profile), /not read-only/)
    // An alternate writable path really exists despite the ro bind.
    writeFileSync(join(source,'alias-write'), 'possible before whole-filesystem fence')
    const uid=65534,gid=65534
    for(const p of [source,candidate,join(source,'memory.json'),join(source,'audit.jsonl'),join(source,'alias-write')])chownSync(p,uid,gid)
    run('/usr/bin/mount', ['-o','remount,ro',source])
    const before = await verifyNativeReadOnlyMount(profile)
    for (const p of [view, source]) assert.throws(()=>writeFileSync(join(p,'forbidden'),'x'), {code:'EROFS'})
    // Protected receipt directory is outside world-writable /tmp ancestors.
    const receiptRoot=join('/var/lib',`xaventra-snapshot-fixture-${randomUUID()}`); mkdirSync(receiptRoot,{mode:0o700})
    const binding={targetId:'isolated-fixture',proposalId:'upstream-fixture',probeId:'isolated-probe',patchHash:'a'.repeat(64),baselineHash:'b'.repeat(64),candidateHash:'c'.repeat(64)}, ticket={...binding,attemptId:`repair-${randomUUID()}`,expiresAt:Date.now()+540000}
    const helperProfile={node:realpathSync(process.execPath),nodeHash:createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
        setprivHash:createHash('sha256').update(readFileSync('/usr/bin/setpriv')).digest('hex'),uid,gid,source:view,destination:candidate,limits:{timeoutMs:10000}}
    const helper=new NativeStateHelper(helperProfile)
    await assert.rejects(()=>new NativeStateHelper({...helperProfile,nodeHash:'0'.repeat(64)}).copy(),/identity mismatch/)
    await assert.rejects(()=>helper.hash('/etc/shadow'),/Unenrolled/)
    const config={root:receiptRoot,sourceStateId:'fixture-old',candidateStateId:'fixture-next',sourceMount:profile,destination:candidate,binding}
    fixtureUnit=`xaventra-snapshot-${randomUUID()}.service`
    const fragmentPath=`/etc/systemd/system/${fixtureUnit}`
    const unitText='[Unit]\nDescription=Disposable snapshot guard fixture\n[Service]\nType=exec\nUser=nobody\nGroup=nogroup\nExecStart=/usr/bin/sleep 60\nWorkingDirectory=/\nRestart=no\nKillMode=control-group\nTimeoutStopSec=5\nRuntimeMaxSec=60\nNoNewPrivileges=yes\nPrivateNetwork=yes\nProtectSystem=strict\nProtectHome=yes\n'
    writeFileSync(fragmentPath,unitText,{flag:'wx',mode:0o600})
    run('/usr/bin/systemctl',['daemon-reload'])
    const unitHash=createHash('sha256').update(unitText).digest('hex')
    const processProfile={executable:'/usr/bin/sleep',executableHash:createHash('sha256').update(readFileSync('/usr/bin/sleep')).digest('hex'),argv:['/usr/bin/sleep','60'],cwd:'/',cgroup:`0::/system.slice/${fixtureUnit}\n`}
    const enrolled={snapshot:config,helper:helperProfile,unit:fixtureUnit,fragmentPath,
        baseline:{unitHash,process:processProfile},candidate:{unitHash:createHash('sha256').update(unitText+'# next\n').digest('hex'),process:processProfile}}
    const authority={authorized:async()=>true,quiescent:async()=>true} // PRIVATE fixture, never production proof.
    const service=new NativeSystemdService({unit:fixtureUnit,fragmentPath,fragmentHash:unitHash,process:processProfile})
    const store=new NativeSnapshotAdapter(enrolled,authority)
    const rollbackPath=join(root,'rollback'),rollbackRoot=join(receiptRoot,'rollback-journal')
    mkdirSync(rollbackPath);chownSync(rollbackPath,uid,gid);mkdirSync(rollbackRoot,{mode:0o700})
    const restoreEnrollment={root:rollbackRoot,destination:rollbackPath,stateId:'fixture-rollback'}
    const rollback=new NativeRollbackState(enrolled,restoreEnrollment,authority)
    await service.start(async()=>true)
    await assert.rejects(()=>store.snapshot(ticket),/fence/)
    await assert.rejects(()=>rollback.restore(ticket),/clean stopped/)
    await service.stop(async()=>true)
    const hashes=await store.snapshot(ticket)
    // A second copy would reject the nonempty destination. Replay only rehashes.
    assert.deepEqual(await new NativeSnapshotAdapter(enrolled,authority).snapshot(ticket),hashes)
    assert.equal(hashes.sourceHash,hashes.copyHash); assert.equal(hashes.sourceHash,hashes.sourceAfterHash)
    // Full component composition with a REAL shared signed controller, but
    // deliberately simulated publisher/lease proof and sleep workload only.
    // The rollback runtime is NOT writable, so it must remain blocked/stopped.
    const oldUnit=join(receiptRoot,'old.service'),nextUnit=join(receiptRoot,'next.service')
    writeFileSync(oldUnit,unitText,{flag:'wx',mode:0o600})
    writeFileSync(nextUnit,unitText+'# next\n',{flag:'wx',mode:0o600})
    const releases={old:{id:'old',sourceHash:binding.baselineHash,programHash:processProfile.executableHash,stateId:'fixture-old',unitFile:oldUnit,unitHash,process:processProfile},
        next:{id:'next',sourceHash:binding.candidateHash,programHash:processProfile.executableHash,stateId:'fixture-next',previousReleaseId:'old',packageHash:binding.patchHash,binding,unitFile:nextUnit,unitHash:enrolled.candidate.unitHash,process:processProfile}}
    let rollbackConfig
    if(positiveRollback){
        const rollbackUnit=join(receiptRoot,'rollback.service')
        // A real service-owned post-start writer proves the selected restored
        // runtime is writable. Original executable remains the same sleep binary.
        const text=unitText+`ReadWritePaths=${rollbackPath}\nExecStartPost=/usr/bin/touch ${rollbackPath}/service-started\n`
        writeFileSync(rollbackUnit,text,{flag:'wx',mode:0o600})
        releases.old.rollbackStateId='fixture-rollback'
        rollbackConfig={...restoreEnrollment,unitFile:rollbackUnit,unitHash:createHash('sha256').update(text).digest('hex'),process:processProfile}
    }
    const ops=new EnrolledNativeUpdateOperations({root:receiptRoot,targetId:binding.targetId,baseline:'old',candidate:'next',releases,snapshot:enrolled,rollback:rollbackConfig},
        {...authority,beginMaintenance:async()=>{},verifyRelease:async()=>true,runtimeReady:async(id,_t,stateId)=>id==='next'||positiveRollback&&id==='old'&&stateId==='fixture-rollback'&&readFileSync(join(rollbackPath,'memory.json'),'utf8')==='{"preserve":"baseline"}'})
    await service.start(async()=>true)
    const driver=new NativeUpdateDriver({targetId:binding.targetId,releases,catalog:{[binding.candidateHash]:'next'}},ops)
    const keys=generateKeyPairSync('ed25519'),signed=signRepairValue(ticket,keys.privateKey.export({type:'pkcs8',format:'pem'}).toString())
    const activationRoot=join(receiptRoot,'activation');mkdirSync(activationRoot,{mode:0o700})
    let candidateObserved=false
    const controller=new UpdateActivationController(activationRoot,keys.publicKey.export({type:'spki',format:'pem'}).toString(),driver,
        async id=>{if(id==='next'){const observed=await ops.inspect();assert.equal(observed.releaseId,'next');assert.equal(observed.running,true);candidateObserved=true;if(positiveRollback)writeFileSync(join(candidate,'memory.json'),'{"changed":"rejected candidate"}');throw Error('Intentional fixture acceptance failure')}
            if(positiveRollback&&candidateObserved){const observed=await ops.inspect();assert.equal(observed.stateId,'fixture-rollback');assert.equal(observed.running,true);assert.equal(readFileSync(join(rollbackPath,'memory.json'),'utf8'),'{"preserve":"baseline"}');assert.equal(statSync(join(rollbackPath,'service-started')).uid,uid)}
            return 'baseline-ready'},async()=>{})
    const activation=await controller.deploy(signed,{})
    assert.equal(candidateObserved,true,'Candidate must actually reach the acceptance probe')
    if(positiveRollback){
        assert.equal(activation.status,'rolled-back')
        const beforeReplay=run('/usr/bin/systemctl',['show',fixtureUnit,'--property=MainPID']).toString()
        assert.deepEqual(await controller.deploy(signed,{}),activation)
        assert.equal(run('/usr/bin/systemctl',['show',fixtureUnit,'--property=MainPID']).toString(),beforeReplay)
        assert.equal(readFileSync(join(view,'memory.json'),'utf8'),'{"preserve":"baseline"}')
        assert.equal(readFileSync(join(candidate,'memory.json'),'utf8'),'{"changed":"rejected candidate"}')
        const report={evidenceClass:'real-isolated-systemd-signed-controller-rollback-with-service-owned-write-not-production',
            candidateObserved,rollbackAccepted:true,originalPreserved:true,candidateFailureDataPreserved:true,
            restoredRuntimeWrittenByServiceUid:true,terminalReplayWithoutRestart:true,simulatedPublisherAndAuthority:true,
            activation,root,receiptRoot,fixtureUnit,rollbackPath}
        writeFileSync(join(root,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
    }else{
    assert.equal(activation.status,'blocked','Readonly rollback source must not be called restored')
    assert.deepEqual(await service.inspect(),{running:false,cleanStopped:true,pid:0})
    assert.deepEqual(await controller.deploy(signed,{}),activation,'Blocked replay must not repeat effects')
    assert.equal(await ops.baselineUnchanged('old',ticket),true)
    writeFileSync(join(candidate,'memory.json'), '{"changed":"candidate only"}')
    assert.equal(await store.baselineUnchanged(ticket),true)
    await assert.rejects(()=>store.snapshot(ticket),/state changed/)
    // Restore original bytes, NOT the now-mutated candidate. This is data
    // preparation only: do not turn the blocked controller receipt into success.
    const restored=await rollback.restore(ticket)
    assert.equal(restored.copyHash,hashes.sourceHash)
    assert.equal(restored.candidateStateId,'fixture-rollback')
    assert.deepEqual(await new NativeRollbackState(enrolled,restoreEnrollment,authority).restore(ticket),restored)
    assert.equal(readFileSync(join(rollbackPath,'memory.json'),'utf8'),'{"preserve":"baseline"}')
    run('/usr/bin/setpriv',['--reuid',String(uid),'--regid',String(gid),'--clear-groups','--no-new-privs','--',helperProfile.node,'-e',
        "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({restoredRuntime:'writable'}))",join(rollbackPath,'memory.json')])
    assert.equal(readFileSync(join(rollbackPath,'memory.json'),'utf8'),'{"restoredRuntime":"writable"}')
    assert.equal(readFileSync(join(candidate,'memory.json'),'utf8'),'{"changed":"candidate only"}')
    await assert.rejects(()=>rollback.restore(ticket),/state changed/)
    assert.equal(readFileSync(join(view,'memory.json'),'utf8'), '{"preserve":"baseline"}')
    assert.deepEqual(await verifyNativeReadOnlyMount(profile), before)
    const report = {evidenceClass:'real-private-namespace-readonly-filesystem-and-independent-copy-not-mesh-fencing',
        readOnlyBindOverWritableFilesystemRejected:true, alternatePathWriteRejectedAfterFence:true,
        threeWayHashMatch:true,candidateMutationPreservesBaseline:true,receiptReplayWithoutRecopy:true,
        mutatedCandidateReplayRejected:true,unprivilegedHelperWithoutSupplementaryGroups:true,
        wrongHelperHashRejected:true,unenrolledHashPathRejected:true,runningServiceCopyRejected:true,
        cleanStoppedServiceSnapshotAccepted:true,composedSignedControllerCandidateStarted:candidateObserved,
        failedAcceptanceWithMissingWritableRollbackBlocked:true,blockedReplayWithoutRestart:true,
        originalRestoredIntoThirdState:true,restoreReceiptReplayWithoutCopy:true,restoredStateWrittenByUnprivilegedChild:true,
        changedRestoreReplayRejected:true,restoreWhileRunningRejected:true,rollbackPath,restored,
        simulatedPublisherAndAuthority:true,activation,fixtureUnit,root,receiptRoot, hashes}
    writeFileSync(join(root,'evidence.json'), JSON.stringify(report,null,2))
    console.log(JSON.stringify(report))
    }
} finally {
    if(fixtureUnit)run('/usr/bin/systemctl',['stop',fixtureUnit]) // Unique fixture only, never enabled.
    // Unmount only our freshly created fixture paths; preserve disk evidence/copy.
    if(viewMounted)run('/usr/bin/umount',[view])
    if(sourceMounted)run('/usr/bin/umount',[source])
}
