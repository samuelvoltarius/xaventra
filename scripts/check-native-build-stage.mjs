import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,dirname } from 'node:path'
import { execFileSync,spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
assert.equal(process.platform,'linux')
const root=mkdtempSync(join(tmpdir(),'native-stage-fixture-')),source=join(root,'source');mkdirSync(source);mkdirSync(join(source,'assets'))
const version='2.79.0',pkg={name:'@xaventra/core',version,type:'module',main:'dist/daemon.js',scripts:{build:'node build.mjs'}}
writeFileSync(join(source,'package.json'),JSON.stringify(pkg))
writeFileSync(join(source,'package-lock.json'),JSON.stringify({name:pkg.name,version,lockfileVersion:3,packages:{'':{name:pkg.name,version}}}))
writeFileSync(join(source,'build.mjs'),'import{mkdirSync,writeFileSync}from"node:fs";mkdirSync("dist");writeFileSync("dist/daemon.js","export const fixture=true");')
writeFileSync(join(source,'.gitignore'),'dist/\nnode_modules/\n')
for(const file of ['SOUL.md','LICENSE','THIRD_PARTY_NOTICES.md','xaventra.config.example.json','assets/fixture.txt'])writeFileSync(join(source,file),file.endsWith('.json')?'{}':'fixture')
const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8'}).trim()
git('init','-b','codex/native-build-fixture');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','isolated build fixture')
const commit=git('rev-parse','HEAD'),env={PATH:dirname(process.execPath)+':'+process.env.PATH,HOME:root,TMPDIR:root}
const run=(revision=commit)=>spawnSync(process.execPath,[process.argv[2],source,revision,version,process.arch],{encoding:'utf8',env,timeout:120000,maxBuffer:1024*1024})
const wrong=run('f'.repeat(40));assert.notEqual(wrong.status,0)
const good=run();writeFileSync(join(root,'build.log'),good.stdout+'\n'+good.stderr);assert.equal(good.status,0,good.stderr)
const line=good.stdout.trim().split('\n').at(-1),receipt=JSON.parse(line),report=JSON.parse(readFileSync(receipt.report,'utf8'));assert.equal(report.passed,true)
assert.equal(dirname(report.root),root,'Nested builder output must stay in the retained fixture workspace')
const stale=run();assert.notEqual(stale.status,0);assert.match(stale.stderr,/Fresh checkout/)
const evidence={root,receipt:receipt.report,sourceRevision:commit,wrongRevisionRejected:true,actualBuildAndProductionInstall:true,staleArtifactsRejected:true,productionChanged:false,scope:'actual isolated npm/build/inventory/package processes with minimal fixture repository; not real Xaventra payload or daemon'}
writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
