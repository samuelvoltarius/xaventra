import { verifyNativeRuntimeAccess } from '../src/doctor/native-runtime-access.ts'
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);assert.equal(process.env.XAVENTRA_NATIVE_FIXTURE,'1')
const root=mkdtempSync('/var/lib/xaventra-native-access-'),account={uid:65534,gid:65534}
const report={root,passed:false,productionChanged:false,evidenceClass:'real-dropped-uid-dac-observer-not-service-activation'}
try{
    chmodSync(root,0o755);mkdirSync(join(root,'dist'),{mode:0o755})
    const script=join(root,'dist/daemon.js');writeFileSync(script,'throw Error("This must never execute")',{mode:0o644})
    verifyNativeRuntimeAccess(root,account);report.readableAccepted=true
    chmodSync(script,0o600);assert.throws(()=>verifyNativeRuntimeAccess(root,account));report.privateFileRejected=true
    chmodSync(script,0o644);chmodSync(root,0o700);assert.throws(()=>verifyNativeRuntimeAccess(root,account));report.privateRootRejected=true
    assert.throws(()=>verifyNativeRuntimeAccess(root,{uid:0,gid:0}));report.rootAccountRejected=true
    if(process.argv[2]){
        assert.match(process.argv[2],/^\/var\/lib\/xaventra-native-real-stage-[A-Za-z0-9]+\/staging\/native-stage-[A-Za-z0-9]+$/)
        assert.throws(()=>verifyNativeRuntimeAccess(process.argv[2],account));report.retainedPrivateStageRejected=true
    }
    report.passed=true
}catch(error){report.error=String(error);throw error}
finally{writeFileSync(join(root,'evidence.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(report))}
