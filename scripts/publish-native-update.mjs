// Bundle from the reviewed signing-job revision, never from downloaded build
// artifacts. Run only after independent build-plan approval and secret scans.
// Archive creation runs separately WITHOUT publisher credentials.
import { createHash,createPrivateKey,createPublicKey,sign } from 'node:crypto'
import { readFileSync,createReadStream,mkdirSync,mkdtempSync,writeFileSync,copyFileSync,readdirSync,renameSync,rmdirSync,existsSync,constants } from 'node:fs'
import { join,dirname,basename,resolve } from 'node:path'
import { verifyNativeArchive } from '../src/core/native-archive.ts'
import { encodeNativeUpdatePackage } from '../src/core/update-package.ts'
import { verifyNativeReleaseEvidence,verifyNativePublication } from '../src/core/native-release-evidence.ts'
import { NATIVE_ARCHES,NATIVE_CHECKSUM_ASSET,NATIVE_MANIFEST_ASSET,formatNativeChecksums,nativeDescriptorAsset,nativeProgramAsset,nativeReleaseInventory } from '../src/core/native-release-assets.ts'

const [version,commit,planPath,approvedPlanHash,directory]=process.argv.slice(2)
const hash=b=>createHash('sha256').update(b).digest('hex')
if(process.argv.length!==7||!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version||'')||!/^[a-f0-9]{40}$/.test(commit||'')||!/^[a-f0-9]{64}$/.test(approvedPlanHash||''))throw Error('Exact version, commit and approved plan SHA256 required')
const planBytes=readFileSync(planPath)
if(planBytes.length>65536||hash(planBytes)!==approvedPlanHash)throw Error('Native build plan approval mismatch')
const plan=JSON.parse(planBytes.toString('utf8'))
if(plan.schema!==1||plan.version!==version||plan.commit!==commit||!Array.isArray(plan.builds)||plan.builds.length!==NATIVE_ARCHES.length
    ||Object.keys(plan).sort().join(',')!=='builds,commit,schema,version')throw Error('Native build plan identity mismatch')
// The output directory is the publication boundary and is created only after
// every check passed. Archives are copied into a sibling staging directory on the
// same filesystem, stream-verified THERE, and later renamed unchanged, so the
// published bytes are exactly the verified bytes. Failed staging is retained.
const output=resolve(directory)
if(existsSync(output))throw Error('Native publication output already exists')
const staging=mkdtempSync(join(dirname(output),basename(output)+'.staging-'))
const prepared=[]
for(const arch of NATIVE_ARCHES){
    const entries=plan.builds.filter(b=>b&&b.arch===arch)
    if(entries.length!==1)throw Error('Exactly one native build per architecture required')
    const b=entries[0]
    if(Object.keys(b).sort().join(',')!=='arch,archive,sha256,size,treeHash'||typeof b.archive!=='string'||!b.archive)throw Error('Native build plan entry invalid')
    // Publish exactly the verified bytes: copy first, then stream-verify the copy.
    const program=join(staging,nativeProgramAsset(version,arch))
    copyFileSync(b.archive,program,constants.COPYFILE_EXCL)
    await verifyNativeArchive(createReadStream(program),b)
    const bytes=encodeNativeUpdatePackage({schema:1,kind:'native',repository:'samuelvoltarius/xaventra',version,commit,platform:'linux',arch,treeHash:b.treeHash,archive:{sha256:b.sha256,size:b.size},entrypoint:'dist/daemon.js'})
    const name=nativeDescriptorAsset(version,arch)
    prepared.push({arch,treeHash:b.treeHash,program:{name:nativeProgramAsset(version,arch),sha256:b.sha256},bytes,artifact:{name,platform:'linux',arch,size:bytes.length,sha256:hash(bytes)}})
}
if(new Set(prepared.map(p=>p.program.sha256)).size!==prepared.length)throw Error('Native architectures share one program archive')
// No package loading, lifecycle scripts, npm, extraction, network or child
// processes are allowed in this credential-bearing phase.
const keyId=process.env.XAVENTRA_UPDATE_PUBLISHER_ID
if(!/^[a-zA-Z0-9._-]{1,80}$/.test(keyId||''))throw Error('Enrolled publisher ID required')
const key=createPrivateKey(process.env.XAVENTRA_UPDATE_PUBLISHER_KEY||'')
if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 publisher required')
const payload={schema:1,repository:'samuelvoltarius/xaventra',version,commit,minUpdater:'2.78.56',artifacts:prepared.map(p=>p.artifact)}
const signed={keyId,payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),key).toString('base64')}
const policy={publisherKeys:{[keyId]:createPublicKey(key).export({type:'spki',format:'pem'}).toString()}}
for(const p of prepared)verifyNativeReleaseEvidence(signed,policy,{version,commit,updater:'2.78.56',arch:p.arch,treeHash:p.treeHash,descriptorHash:p.artifact.sha256},p.bytes)
const sums=new Map(prepared.flatMap(p=>[[p.program.name,p.program.sha256],[p.artifact.name,p.artifact.sha256]]))
mkdirSync(output)
for(const p of prepared)renameSync(join(staging,p.program.name),join(output,p.program.name))
rmdirSync(staging)
for(const p of prepared)writeFileSync(join(output,p.artifact.name),p.bytes,{flag:'wx',mode:0o600})
writeFileSync(join(output,NATIVE_CHECKSUM_ASSET),formatNativeChecksums(version,n=>sums.get(n)),{flag:'wx',mode:0o600})
// Manifest last: without it no reader treats the directory as a release.
writeFileSync(join(output,NATIVE_MANIFEST_ASSET),JSON.stringify(signed,null,2),{flag:'wx',mode:0o600})
// Re-read everything from disk; the directory must be exactly one publication.
const names=readdirSync(output).sort()
if(names.join('\n')!==[...nativeReleaseInventory(version)].sort().join('\n'))throw Error('Native publication directory inventory mismatch')
verifyNativePublication({names,signed:JSON.parse(readFileSync(join(output,NATIVE_MANIFEST_ASSET),'utf8')),policy,
    expected:{version,commit,updater:'2.78.56'},checksums:readFileSync(join(output,NATIVE_CHECKSUM_ASSET),'utf8'),
    descriptors:Object.fromEntries(prepared.map(p=>[p.arch,readFileSync(join(output,p.artifact.name))]))})
// Renamed program bytes must still be the checksummed, verified bytes.
for(const p of prepared)if(createHash('sha256').update(readFileSync(join(output,p.program.name))).digest('hex')!==p.program.sha256)throw Error('Native program bytes changed after verification')
console.log(JSON.stringify({version,commit,publisher:keyId,assets:nativeReleaseInventory(version)}))
