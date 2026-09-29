// Disposable real filesystem acceptance; does NOT assert read-only/mesh fencing.
import { createNativeStateCopyScript } from '../src/doctor/docker-repair-state.ts'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
if(process.platform!=='linux')throw Error('Linux fixture required')
const root=mkdtempSync(join(tmpdir(),'xaventra-native-copy-'))
const run=(source,destination,limits={})=>JSON.parse(execFileSync(process.execPath,['-e',createNativeStateCopyScript(source,destination,limits)],{timeout:10000,maxBuffer:65536,stdio:['ignore','pipe','pipe']}).toString())
const source=join(root,'source'),destination=join(root,'candidate')
mkdirSync(source);mkdirSync(destination);mkdirSync(join(source,'nested'))
writeFileSync(join(source,'nested','memory.json'),JSON.stringify({corrected:'preserve me'}))
writeFileSync(join(source,'audit.jsonl'),'retained evidence\n')
writeFileSync(join(source,'binary'),Buffer.alloc(2*1024*1024,0x7a))
const proof=run(source,destination)
assert.equal(proof.sourceHash,proof.copyHash);assert.equal(proof.sourceHash,proof.sourceAfterHash)
assert.equal(readFileSync(join(destination,'nested','memory.json'),'utf8'),readFileSync(join(source,'nested','memory.json'),'utf8'))
assert.throws(()=>run(source,destination)) // No reuse of populated candidate.
const small=join(root,'over-budget');mkdirSync(small)
assert.throws(()=>run(source,small,{maxBytes:1024,maxFileBytes:1024}))
const linked=join(root,'linked');mkdirSync(linked)
symlinkSync(join(root,'outside'),join(source,'untrusted-link'))
assert.throws(()=>run(source,linked))
const report={evidenceClass:'real-linux-filesystem-copy-not-readonly-or-mesh-fencing',copyHash:proof.copyHash,threeWayHashMatch:true,populatedDestinationRejected:true,budgetRejected:true,linkRejected:true,root}
writeFileSync(join(root,'evidence.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify(report))
