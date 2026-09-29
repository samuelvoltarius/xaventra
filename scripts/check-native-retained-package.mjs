// Requalify a retained disposable build; never alter its old negative report.
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQualifiedNativeArchive } from '../src/core/native-build-qualification.ts'
const source=process.argv[2]
if(process.platform!=='linux'||!/^\/tmp\/xaventra-native-build-[A-Za-z0-9]+$/.test(source||''))throw Error('Explicit disposable Linux build required')
const inventory=JSON.parse(readFileSync(join(source,'inventory.json'),'utf8'))
const root=mkdtempSync(join(tmpdir(),'native-requalified-')),output=join(root,'payload.tar.gz')
const report={source,root,passed:false,productionChanged:false}
try{
    report.archive=await buildQualifiedNativeArchive(join(source,'payload'),output,inventory.files,
        {commit:inventory.commit,version:inventory.version,arch:inventory.arch})
    report.passed=true
}catch(e){report.error=String(e);process.exitCode=1}
finally{writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report))}
