// Disposable process-boundary proof. No downloads, installation, production keys
// or running application files. Retains public fixture evidence, never private key.
import { verifyNativeReleaseEvidence } from '../src/core/native-release-evidence.ts'
import { encodeNativeUpdatePackage } from '../src/core/update-package.ts'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

assert.equal(process.env.XAVENTRA_NATIVE_FIXTURE,'1')
if(process.argv[2]==='--verify'){
    try{
        const input=JSON.parse(readFileSync(process.argv[3],'utf8'))
        const proof=verifyNativeReleaseEvidence(input.signed,input.policy,input.expected,readFileSync(process.argv[4]))
        console.log(JSON.stringify(proof))
    }catch{console.error('Native evidence rejected');process.exitCode=1}
}else{
    const root=mkdtempSync(join(tmpdir(),'xaventra-native-publisher-'))
    const keys=generateKeyPairSync('ed25519')
    const descriptor={schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version:'2.79.0',commit:'a'.repeat(40),platform:'linux',arch:'arm64',treeHash:'b'.repeat(64),archive:{sha256:'c'.repeat(64),size:1234},entrypoint:'dist/daemon.js'}
    const bytes=encodeNativeUpdatePackage(descriptor),descriptorHash=createHash('sha256').update(bytes).digest('hex')
    const payload={schema:1,repository:descriptor.repository,version:descriptor.version,commit:descriptor.commit,minUpdater:'2.78.56',artifacts:[{name:'xaventra-2.79.0-linux-arm64.tar.gz',platform:'linux',arch:'arm64',size:bytes.length,sha256:descriptorHash}]}
    const input={signed:{keyId:'isolated',payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),keys.privateKey).toString('base64')},
        policy:{publisherKeys:{isolated:keys.publicKey.export({type:'spki',format:'pem'}).toString()}},
        expected:{version:descriptor.version,updater:'2.78.56',arch:'arm64',commit:descriptor.commit,descriptorHash,treeHash:descriptor.treeHash}}
    const inputPath=join(root,'public-evidence.json'),packagePath=join(root,'descriptor.tar.gz')
    writeFileSync(inputPath,JSON.stringify(input,null,2),{flag:'wx'});writeFileSync(packagePath,bytes,{flag:'wx'})
    const run=(path)=>spawnSync(process.execPath,[process.argv[1],'--verify',inputPath,path],{encoding:'utf8',timeout:10000,maxBuffer:16384})
    const valid=run(packagePath);assert.equal(valid.status,0,valid.stderr)
    assert.deepEqual(JSON.parse(valid.stdout).descriptor,descriptor)
    const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1
    const badPath=join(root,'tampered.tar.gz');writeFileSync(badPath,corrupt,{flag:'wx'})
    assert.equal(run(badPath).status,1)
    // A fresh process must independently repeat signature and byte validation.
    assert.equal(run(packagePath).status,0)
    const report={evidenceClass:'real-isolated-child-process-signature-and-descriptor-verification-not-installed-tree',
        verified:true,tamperedBytesRejected:true,freshProcessReverification:true,productionChanged:false,root}
    writeFileSync(join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
