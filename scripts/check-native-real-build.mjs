// Explicit disposable public-source acceptance. No production configuration.
import { mkdtempSync,writeFileSync,readFileSync,copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
const [builder,commit,version,dependencyPatch]=process.argv.slice(2)
if(!/^[a-f0-9]{40}$/.test(commit||''))throw Error('Exact published commit required')
const root=mkdtempSync(join(tmpdir(),'native-real-build-')),source=join(root,'source')
// Keep builder output beside this fixture's logs/source. The caller can choose
// durable retention via TMPDIR; do not silently fall back to system /tmp inside
// the intentionally minimal child environment.
const env={PATH:dirname(process.execPath)+':'+process.env.PATH,HOME:root,TMPDIR:root}
const clone=spawnSync('git',['clone','--depth','1','https://github.com/samuelvoltarius/xaventra',source],{env,encoding:'utf8',timeout:120000,maxBuffer:1024*1024})
writeFileSync(join(root,'clone.log'),clone.stdout+'\n'+clone.stderr)
if(clone.status!==0)throw Error('Public clone failed; retained '+root)
let buildCommit=commit
if(dependencyPatch){
    const git=(...args)=>{const r=spawnSync('git',args,{cwd:source,env,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim()}
    if(git('rev-parse','HEAD')!==commit)throw Error('Dependency fixture base changed')
    for(const name of ['package.json','package-lock.json']){
        const original=JSON.parse(readFileSync(join(source,name),'utf8')),next=JSON.parse(readFileSync(join(dependencyPatch,name),'utf8'))
        if(name==='package.json')delete original.dependencies.chromium
        else{delete original.packages[''].dependencies.chromium;delete original.packages['node_modules/chromium']}
        if(JSON.stringify(original)!==JSON.stringify(next))throw Error('Only evidenced chromium removal allowed in fixture')
        copyFileSync(join(dependencyPatch,name),join(source,name))
    }
    git('checkout','-b','codex/native-browser-dependency-fixture');git('add','package.json','package-lock.json')
    git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Isolated native dependency correction fixture')
    buildCommit=git('rev-parse','HEAD')
}
const build=spawnSync(process.execPath,[builder,source,buildCommit,version,process.arch],{env,encoding:'utf8',timeout:1800000,maxBuffer:8*1024*1024})
writeFileSync(join(root,'build.log'),build.stdout+'\n'+build.stderr)
const evidence={root,commit,buildCommit,dependencyPatchFixture:Boolean(dependencyPatch),version,exit:build.status,signal:build.signal,error:build.error?.message,output:build.stdout.trim().split('\n').at(-1),productionChanged:false}
writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));process.exitCode=build.status===0?0:1
