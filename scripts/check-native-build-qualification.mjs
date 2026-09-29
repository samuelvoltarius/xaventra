import { validateNativeBinaryHeader } from '../src/core/native-build-qualification.ts'
import { openSync,readSync,closeSync,mkdtempSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
assert.equal(process.platform,'linux');assert.ok(['x64','arm64'].includes(process.arch))
const fd=openSync(process.argv[2],'r'),header=Buffer.alloc(64)
try{assert.equal(readSync(fd,header,0,64,0),64)}finally{closeSync(fd)}
assert.equal(validateNativeBinaryHeader('actual-addon.node',header,process.arch),true)
assert.throws(()=>validateNativeBinaryHeader('actual-addon.node',header,process.arch==='arm64'?'x64':'arm64'))
const directory=mkdtempSync(join(tmpdir(),'native-architecture-check-'))
const evidence={actualNativeAddonHeader:true,hostArchitecture:process.arch,correctArchitectureAccepted:true,wrongArchitectureRejected:true,productionChanged:false,limitedTo:'read-only 64-byte ELF header; not ABI, dependency completeness, clean build or workload proof',directory}
writeFileSync(join(directory,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
