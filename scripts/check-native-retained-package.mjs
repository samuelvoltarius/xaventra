// Requalify a retained disposable build; never alter its old negative report.
import { mkdtempSync,readFileSync,writeFileSync,realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,dirname,basename } from 'node:path'
import { assertReleaseSource } from './release-source-provenance.mjs'
import { buildQualifiedNativeArchive } from '../src/core/native-build-qualification.ts'
const [source,approvedParent='/tmp',cleanSource]=process.argv.slice(2)
if(process.platform!=='linux'||!source||realpathSync(source)!==source||realpathSync(approvedParent)!==approvedParent||
    dirname(source)!==approvedParent||!/^xaventra-native-build-[A-Za-z0-9]+$/.test(basename(source)))throw Error('Explicit canonical disposable Linux build required')
const inventory=JSON.parse(readFileSync(join(source,'inventory.json'),'utf8'))
const verifySource=()=>{if(cleanSource&&assertReleaseSource(cleanSource)!==inventory.commit)throw Error('Retained source revision mismatch')}
verifySource()
const root=mkdtempSync(join(tmpdir(),'native-requalified-')),output=join(root,'payload.tar.gz')
const report={source,root,commit:inventory.commit,version:inventory.version,arch:inventory.arch,sourceDirty:cleanSource?false:null,passed:false,productionChanged:false}
try{
    report.archive=await buildQualifiedNativeArchive(join(source,'payload'),output,inventory.files,
        {commit:inventory.commit,version:inventory.version,arch:inventory.arch})
    verifySource();report.passed=true
}catch(e){report.error=String(e);process.exitCode=1}
finally{writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report))}
