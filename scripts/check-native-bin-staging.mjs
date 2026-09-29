import { materializeNativeBin } from '../src/core/native-bin-staging.ts'
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,lstatSync,readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
assert.equal(process.platform,'linux')
const root=mkdtempSync(join(tmpdir(),'native-bin-staging-')),mods=join(root,'node_modules'),pkg=join(mods,'fixture'),bins=join(mods,'.bin')
mkdirSync(pkg,{recursive:true});mkdirSync(bins)
writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'fixture',type:'module',bin:{fixture:'cli.js'}}))
writeFileSync(join(pkg,'value.js'),'export default "relative-import-ok"')
writeFileSync(join(pkg,'cli.js'),'#!/usr/bin/env node\nimport value from "./value.js"; console.log(value,process.argv[2])\n',{mode:0o755})
symlinkSync('../fixture/cli.js',join(bins,'fixture'))
const run=()=>spawnSync(join(bins,'fixture'),['argument with spaces'],{encoding:'utf8',timeout:10000,env:{PATH:join(process.execPath,'..')+':/usr/bin:/bin'}})
const before=run();assert.equal(before.status,0,before.stderr)
const result=materializeNativeBin(root,'node_modules/.bin/fixture');assert.equal(lstatSync(join(bins,'fixture')).isFile(),true)
const after=run();assert.equal(after.status,0,after.stderr);assert.equal(after.stdout,before.stdout)
symlinkSync('/usr/bin/true',join(bins,'escape'));assert.throws(()=>materializeNativeBin(root,'node_modules/.bin/escape'));assert.equal(readlinkSync(join(bins,'escape')),'/usr/bin/true')
symlinkSync('../fixture/cli.js',join(bins,'undeclared'));assert.throws(()=>materializeNativeBin(root,'node_modules/.bin/undeclared'))
assert.throws(()=>materializeNativeBin(root,'node_modules/.bin/fixture'))
assert.throws(()=>materializeNativeBin(root,'node_modules/../../.bin/escape'),/path invalid/)
const evidence={root,result,actualRelativeImportAndArgumentsPreserved:true,escapeAndUndeclaredRejected:true,existingRegularFileNotOverwritten:true,productionChanged:false}
writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
