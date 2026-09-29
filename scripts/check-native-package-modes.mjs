import { buildNativeArchive } from '../src/core/native-package-builder.ts'
import { nativeArchiveHeader } from '../src/core/native-archive.ts'
import { gzipSync } from 'node:zlib'
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync,statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
assert.equal(process.platform,'linux')
const root=mkdtempSync(join(tmpdir(),'native-mode-acceptance-')),source=join(root,'source'),target=join(root,'extracted')
mkdirSync(source);mkdirSync(join(source,'dist'));mkdirSync(target)
const files=[['dist/daemon.js','#!/bin/sh\nprintf native_mode_ok\n',0o755],['package.json','{"name":"fixture"}',0o644]].map(([path,body,mode])=>{
    writeFileSync(join(source,path),body,{mode});chmodSync(join(source,path),mode)
    return {path,mode,size:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}
})
await assert.rejects(()=>buildNativeArchive(source,join(root,'unapproved.tar.gz'),files.map(({mode,...f})=>f)),/explicit matching approval/)
// Reproduce the prior producer's unconditional 0644 header with real execution.
const oldTarget=join(root,'old-extracted'),oldArchive=join(root,'old-mode.tar.gz');mkdirSync(oldTarget)
writeFileSync(oldArchive,gzipSync(Buffer.concat([...files.flatMap(f=>[nativeArchiveHeader(f.path,f.size),readFileSync(join(source,f.path)),Buffer.alloc((512-f.size%512)%512)]),Buffer.alloc(1024)])))
assert.equal(spawnSync('/usr/bin/tar',['-xzf',oldArchive,'-C',oldTarget],{timeout:10000}).status,0)
const baseline=spawnSync(join(oldTarget,'dist/daemon.js'),[],{encoding:'utf8',timeout:10000});assert.equal(baseline.error?.code,'EACCES')
const archive=join(root,'approved.tar.gz'),result=await buildNativeArchive(source,archive,files)
// Trusted fixture produced above, not the production installer. Do not use
// generic tar extraction for downloaded/untrusted release packages.
const extracted=spawnSync('/usr/bin/tar',['-xzf',archive,'-C',target],{encoding:'utf8',timeout:10000});assert.equal(extracted.status,0,extracted.stderr)
assert.equal(statSync(join(target,'dist/daemon.js')).mode&0o777,0o755)
const executed=spawnSync(join(target,'dist/daemon.js'),[],{encoding:'utf8',timeout:10000});assert.equal(executed.status,0);assert.equal(executed.stdout,'native_mode_ok')
assert.equal(readFileSync(join(source,'dist/daemon.js'),'utf8'),readFileSync(join(target,'dist/daemon.js'),'utf8'))
const evidence={root,result,baselineFailure:baseline.error.code,missingModeApprovalRejected:true,extractedMode:'0755',actualExecutionExit:executed.status,evidenceClass:'actual Linux trusted fixture packaging/extraction/execution; not production installer or Xaventra workload',productionChanged:false}
writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
