import { createRequire } from 'node:module'
import { join } from 'node:path'
import { readFileSync,existsSync,writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const stage=process.argv[2],root=join(stage,'payload'),require=createRequire(join(root,'package.json'))
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
assert.ok(pkg.dependencies.playwright);assert.equal(pkg.dependencies.chromium,undefined)
assert.equal(existsSync(join(root,'node_modules/chromium')),false)
const pw=require('playwright')
assert.equal(pw.chromium.name(),'chromium');assert.equal(typeof pw.chromium.launch,'function')
const evidence={playwrightImport:true,chromiumBrowserTypePreserved:true,unusedTintPackageAbsent:true,browserLaunchTested:false,productionChanged:false}
writeFileSync(join(stage,'browser-dependency-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
