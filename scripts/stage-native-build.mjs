// Run bundled reviewed tooling in a disposable Linux build host, without
// publisher credentials. Never point this at an installed runtime or dirty tree.
import { assertReleaseSource } from './release-source-provenance.mjs'
import { materializeNativeBin } from '../src/core/native-bin-staging.ts'
import { buildQualifiedNativeArchive } from '../src/core/native-build-qualification.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,lstatSync,opendirSync,openSync,readSync,closeSync,existsSync,chmodSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
const [sourceArg,commit,version,arch]=process.argv.slice(2),source=resolve(sourceArg||'.')
if(process.platform!=='linux'||process.arch!==arch||!['x64','arm64'].includes(arch)||!/^[a-f0-9]{40}$/.test(commit||'')||!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version||''))throw Error('Exact native Linux build identity required')
process.umask(0o022)
if(assertReleaseSource(source)!==commit)throw Error('Native build source revision mismatch')
if(existsSync(join(source,'dist'))||existsSync(join(source,'node_modules')))throw Error('Fresh checkout without ignored build artifacts required')
const pkg=JSON.parse(readFileSync(join(source,'package.json'),'utf8'))
if(pkg.name!=='@xaventra/core'||pkg.version!==version)throw Error('Native build package mismatch')
const root=mkdtempSync(join(tmpdir(),'xaventra-native-build-')),payload=join(root,'payload'),home=join(root,'home')
mkdirSync(payload);mkdirSync(home)
const env={PATH:process.env.PATH,HOME:home,NODE_ENV:'development',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1',npm_config_cache:join(root,'npm-cache'),npm_config_userconfig:join(home,'empty-user-npmrc'),npm_config_globalconfig:join(home,'empty-global-npmrc'),npm_config_audit:'false',npm_config_fund:'false'}
const run=(args,cwd)=>execFileSync('npm',args,{cwd,env,stdio:'inherit',timeout:900000})
const report={schema:1,commit,version,arch,sourceDirty:false,root,phase:'build',passed:false}
try{
    run(['ci','--ignore-scripts'],source);run(['run','build'],source)
    if(assertReleaseSource(source)!==commit)throw Error('Native source changed during build')
    for(const name of ['package.json','package-lock.json','dist','assets','SOUL.md','LICENSE','THIRD_PARTY_NOTICES.md','xaventra.config.example.json']){
        const from=join(source,name);if(lstatSync(from).isSymbolicLink())throw Error('Native build input link')
        cpSync(from,join(payload,name),{recursive:true,errorOnExist:true,force:false,dereference:false})
    }
    report.phase='production-dependencies';run(['ci','--omit=dev','--ignore-scripts'],payload)
    const files=[],bins=[],deadline=Date.now()+120000;let count=0,total=0
    const walk=(dir,prefix='',depth=0)=>{
        if(depth>64||Date.now()>deadline)throw Error('Native staging traversal budget')
        const handle=opendirSync(dir)
        try{for(let e=handle.readSync();e;e=handle.readSync()){
            if(++count>100000)throw Error('Native staging entry budget')
            const path=prefix?prefix+'/'+e.name:e.name,full=join(payload,path);let s=lstatSync(full)
            if(s.isSymbolicLink()){bins.push(materializeNativeBin(payload,path));s=lstatSync(full)}
            if(s.isDirectory()){walk(full,path,depth+1);continue}
            if(!s.isFile()||s.nlink!==1)throw Error('Native staging special/hardlinked file')
            if(s.mode&0o6000)throw Error('Native staging privilege bits rejected')
            // Only the newly created payload copy is normalized, never source.
            chmodSync(full,s.mode&0o111?0o755:0o644)
            total+=s.size;if(total>2*1024**3)throw Error('Native staging byte budget')
            const fd=openSync(full,'r'),buffer=Buffer.alloc(65536),hash=createHash('sha256')
            try{while(true){if(Date.now()>deadline)throw Error('Native staging time budget');const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;hash.update(buffer.subarray(0,n))}}finally{closeSync(fd)}
            files.push({path,size:s.size,sha256:hash.digest('hex'),mode:s.mode&0o111?0o755:0o644})
        }}finally{handle.closeSync()}
    }
    report.phase='inventory';walk(payload);files.sort((a,b)=>a.path.localeCompare(b.path))
    writeFileSync(join(root,'inventory.json'),JSON.stringify({commit,version,arch,files,bins},null,2),{flag:'wx'})
    report.phase='qualified-package'
    report.archive=await buildQualifiedNativeArchive(payload,join(root,'payload.tar.gz'),files,{commit,version,arch})
    if(assertReleaseSource(source)!==commit)throw Error('Native source changed before receipt')
    report.passed=true;report.phase='packaged-not-daemon-accepted'
}catch(error){report.error=String(error.message);throw error}
finally{writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:join(root,'report.json'),passed:report.passed,phase:report.phase}))}
