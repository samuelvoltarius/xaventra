// Bundle from the reviewed signing-job revision, never from downloaded build
// artifacts. Run only after independent build-plan approval and secret scans.
// Archive creation runs separately WITHOUT publisher credentials.
import { createHash,createPrivateKey,createPublicKey,sign } from 'node:crypto'
import { readFileSync,createReadStream,mkdirSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyNativeArchive } from '../src/core/native-archive.ts'
import { encodeNativeUpdatePackage } from '../src/core/update-package.ts'
import { verifyNativeReleaseEvidence } from '../src/core/native-release-evidence.ts'

const [version,commit,planPath,approvedPlanHash,directory]=process.argv.slice(2)
const hash=b=>createHash('sha256').update(b).digest('hex')
if(process.argv.length!==7||!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version||'')||!/^[a-f0-9]{40}$/.test(commit||'')||!/^[a-f0-9]{64}$/.test(approvedPlanHash||''))throw Error('Exact version, commit and approved plan SHA256 required')
const planBytes=readFileSync(planPath)
if(planBytes.length>65536||hash(planBytes)!==approvedPlanHash)throw Error('Native build plan approval mismatch')
const plan=JSON.parse(planBytes.toString('utf8'))
if(plan.schema!==1||plan.version!==version||plan.commit!==commit||!Array.isArray(plan.builds)||plan.builds.length!==2)throw Error('Native build plan identity mismatch')
const prepared=[]
for(const arch of ['x64','arm64']){
    const entries=plan.builds.filter(b=>b.arch===arch)
    if(entries.length!==1)throw Error('Exactly one native build per architecture required')
    const b=entries[0]
    if(typeof b.archive!=='string'||!b.archive)throw Error('Native build archive required')
    await verifyNativeArchive(createReadStream(b.archive),b)
    const bytes=encodeNativeUpdatePackage({schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version,commit,platform:'linux',arch,treeHash:b.treeHash,archive:{sha256:b.sha256,size:b.size},entrypoint:'dist/daemon.js'})
    const name=`xaventra-native-${version}-linux-${arch}.tar.gz`
    prepared.push({arch,treeHash:b.treeHash,bytes,artifact:{name,platform:'linux',arch,size:bytes.length,sha256:hash(bytes)}})
}
// No package loading, lifecycle scripts, npm, extraction, network or child
// processes are allowed in this credential-bearing phase.
const keyId=process.env.XAVENTRA_UPDATE_PUBLISHER_ID
if(!/^[a-zA-Z0-9._-]{1,80}$/.test(keyId||''))throw Error('Enrolled publisher ID required')
const key=createPrivateKey(process.env.XAVENTRA_UPDATE_PUBLISHER_KEY||'')
if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 publisher required')
const payload={schema:1,repository:'samuelvoltarius/xaventra',version,commit,minUpdater:'2.78.56',artifacts:prepared.map(p=>p.artifact)}
const signed={keyId,payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),key).toString('base64')}
const publicKey=createPublicKey(key).export({type:'spki',format:'pem'}).toString()
for(const p of prepared)verifyNativeReleaseEvidence(signed,{publisherKeys:{[keyId]:publicKey}},{version,commit,updater:'2.78.56',arch:p.arch,treeHash:p.treeHash,descriptorHash:p.artifact.sha256},p.bytes)
// Fresh output directory is a publication boundary. Partial output is retained
// after failure; only exit0 with the final manifest is publishable.
mkdirSync(directory)
for(const p of prepared)writeFileSync(join(directory,p.artifact.name),p.bytes,{flag:'wx',mode:0o600})
writeFileSync(join(directory,'SHA256SUMS.native'),prepared.map(p=>`${p.artifact.sha256}  ${p.artifact.name}`).join('\n')+'\n',{flag:'wx',mode:0o600})
writeFileSync(join(directory,'xaventra-native-update.json'),JSON.stringify(signed,null,2),{flag:'wx',mode:0o600})
console.log(JSON.stringify({version,commit,publisher:keyId,artifacts:prepared.map(p=>p.artifact.name)}))
