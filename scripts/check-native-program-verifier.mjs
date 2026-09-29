import { nativeProgramInventory, verifyNativeInstalledRelease } from '../src/doctor/native-program-verifier.ts'
import { NativeReleaseEnrollment,createPublisherVerifiedNativeOperations } from '../src/doctor/native-release-enrollment.ts'
import { releaseTreeHash } from '../src/core/release-tree.ts'
import { encodeNativeUpdatePackage } from '../src/core/update-package.ts'
import { nativeArchiveHeader } from '../src/core/native-archive.ts'
import { gzipSync } from 'node:zlib'
import { createHash,generateKeyPairSync,sign } from 'node:crypto'
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,symlinkSync,linkSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
assert.equal(process.env.XAVENTRA_NATIVE_FIXTURE,'1')
assert.equal(process.platform,'linux');assert.equal(process.getuid(),0)
const root=mkdtempSync('/var/lib/xaventra-native-program-'),results=[]
for(const mode of ['valid','changed-code','extra-file','symlink','hardlink','writable','archive','wrong-tree','archive-tree-mismatch']){
    const base=join(root,mode),app=join(base,'app');mkdirSync(base);mkdirSync(app);mkdirSync(join(app,'dist'))
    const daemon=join(app,'dist','daemon.js');writeFileSync(daemon,'export const fixture = true\n',{mode:0o644})
    const content=Buffer.from(mode==='archive-tree-mismatch'?'different signed archive contents\n':'export const fixture = true\n')
    const archive=join(base,'archive.tar.gz'),archiveBytes=gzipSync(Buffer.concat([nativeArchiveHeader('dist/daemon.js',content.length),content,Buffer.alloc((512-content.length%512)%512+1024)]))
    writeFileSync(archive,archiveBytes,{mode:0o600})
    const digest=b=>createHash('sha256').update(b).digest('hex')
    const treeHash=releaseTreeHash(nativeProgramInventory(app)),keys=generateKeyPairSync('ed25519')
    const descriptor={schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version:'2.79.0',commit:'a'.repeat(40),platform:'linux',arch:'arm64',treeHash,
        archive:{sha256:digest(archiveBytes),size:archiveBytes.length},entrypoint:'dist/daemon.js'}
    const bytes=encodeNativeUpdatePackage(descriptor),descriptorHash=digest(bytes)
    const payload={schema:1,repository:descriptor.repository,version:descriptor.version,commit:descriptor.commit,minUpdater:'2.78.56',artifacts:[{name:'xaventra-2.79.0-linux-arm64.tar.gz',platform:'linux',arch:'arm64',size:bytes.length,sha256:descriptorHash}]}
    const signed={keyId:'fixture',payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString('base64')}
    const policy={publisherKeys:{fixture:keys.publicKey.export({type:'spki',format:'pem'}).toString()}},expected={version:descriptor.version,updater:'2.78.56',arch:'arm64',commit:descriptor.commit,treeHash,descriptorHash}
    const binding={targetId:'fixture',proposalId:'upstream-fixture',probeId:'isolated',baselineHash:'b'.repeat(64),candidateHash:'d'.repeat(64),patchHash:descriptorHash}
    const ticket={...binding,attemptId:'repair-11111111-1111-4111-8111-111111111111',expiresAt:Date.now()+60000}
    const manifestPath=join(base,'manifest.json'),descriptorRecordPath=join(base,'descriptor.json'),publisherKeyPath=join(base,'publisher.pub'),enrollmentPath=join(base,'enrollment.json')
    writeFileSync(manifestPath,JSON.stringify(signed),{mode:0o600});writeFileSync(descriptorRecordPath,JSON.stringify({base64:bytes.toString('base64')}),{mode:0o600});writeFileSync(publisherKeyPath,policy.publisherKeys.fixture,{mode:0o600})
    const enrolled={...expected,sourceHash:binding.baselineHash,manifestPath,descriptorRecordPath,publisherKeyPath,publisherKeyId:'fixture',root:app,archive}
    writeFileSync(enrollmentPath,JSON.stringify({schema:1,binding,releases:{old:enrolled,next:{...enrolled,sourceHash:binding.candidateHash}}}),{mode:0o600})
    const profile={executable:'/fixture/node',executableHash:'a'.repeat(64),argv:['/fixture/node',join(app,'dist','daemon.js')],cwd:'/',cgroup:'fixture'}
    const old={id:'old',sourceHash:binding.baselineHash,programHash:treeHash,stateId:'old-state',unitFile:join(base,'old.service'),unitHash:'1'.repeat(64),process:profile}
    const next={...old,id:'next',sourceHash:binding.candidateHash,stateId:'next-state',previousReleaseId:'old',packageHash:descriptorHash,binding,unitHash:'2'.repeat(64)}
    const source=join(base,'old-state'),destination=join(base,'next-state')
    const ops=createPublisherVerifiedNativeOperations({root:base,targetId:'fixture',baseline:'old',candidate:'next',releases:{old,next},snapshot:{unit:'xaventra-verifier-fixture.service',fragmentPath:'/etc/systemd/system/xaventra-verifier-fixture.service',baseline:{unitHash:old.unitHash,process:profile},candidate:{unitHash:next.unitHash,process:profile},snapshot:{root:base,sourceStateId:'old-state',candidateStateId:'next-state',sourceMount:{path:source},destination,binding},helper:{node:'/fixture/node',nodeHash:'a'.repeat(64),setprivHash:'a'.repeat(64),uid:65534,gid:65534,source,destination}}},
        {authorized:async()=>true,quiescent:async()=>true,beginMaintenance:async()=>{},runtimeReady:async()=>true},enrollmentPath)
    if(mode==='changed-code')writeFileSync(daemon,'export const fixture = false\n')
    if(mode==='extra-file')writeFileSync(join(app,'extra.js'),'unexpected')
    if(mode==='symlink')symlinkSync(daemon,join(app,'alias.js'))
    if(mode==='hardlink')linkSync(daemon,join(app,'alias.js'))
    if(mode==='writable')chmodSync(daemon,0o666)
    if(mode==='archive')writeFileSync(archive,Buffer.alloc(archiveBytes.length,1))
    if(mode==='wrong-tree')expected.treeHash='d'.repeat(64)
    const verify=()=>verifyNativeInstalledRelease(signed,policy,expected,bytes,{root:app,archive})
    if(mode==='valid'){const result=await verify();assert.equal(result.installedTreeVerified,true);assert.equal(result.archiveTreeVerified,true);assert.equal(result.files,1);assert.equal(await new NativeReleaseEnrollment(enrollmentPath).verify('old',old,ticket),true);assert.equal(await ops.verifyRelease('next',ticket),true)}
    else await assert.rejects(verify)
    if(['changed-code','extra-file','symlink','hardlink','writable','archive','archive-tree-mismatch'].includes(mode)){
        // No fixture unit is installed: rejection must occur at publisher/tree
        // verification before unit selection, reload or start can be reached.
        await assert.rejects(()=>ops.select('next','old',ticket),/Native (program|artifact|archive|installed)/)
        await assert.rejects(()=>ops.start('next',ticket),/Native (program|artifact|archive|installed)/)
    }
    results.push({mode,passed:true})
}
const report={evidenceClass:'actual-isolated-linux-signed-archive-content-and-installed-tree-verification-not-package-installation',results,
    protectedEnrollmentAccepted:true,mutatedBytesBlockSelectionAndStart:true,noFixtureUnitInstalled:true,root,productionChanged:false}
writeFileSync(join(root,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
