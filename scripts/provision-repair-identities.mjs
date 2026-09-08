// Explicit local root operation. Never invoked by Doctor/model output. Writes
// only a NEW protected directory, no service starts or existing identity changes.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { protectControllerDirectory } from '../dist/doctor/repair-controller-files.js'

if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Run explicitly as the local administrator')
if(!process.argv[2])throw Error('Usage: node scripts/provision-repair-identities.mjs /protected/new-directory')
const root=resolve(process.argv[2]);protectControllerDirectory(dirname(root))
if(existsSync(root))throw Error('Destination already exists; identities are never overwritten or silently rotated')
mkdirSync(root,{mode:0o700});mkdirSync(join(root,'grants'),{mode:0o700});mkdirSync(join(root,'state'),{mode:0o700})
const fingerprints={}
for(const purpose of ['approval','receipt','release','authority']){
 const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'})
 writeFileSync(join(root,`${purpose}-private.pem`),pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600})
 writeFileSync(join(root,`${purpose}-public.pem`),publicKey,{flag:'wx',mode:0o644})
 fingerprints[purpose]=createHash('sha256').update(publicKey).digest('hex')
}
writeFileSync(join(root,'public-fingerprints.json'),JSON.stringify(fingerprints,null,2),{flag:'wx',mode:0o644})
console.log('Four separate node-local identities created. No service, grant, runtime mount or production activation enabled.')
console.log(JSON.stringify(fingerprints,null,2))
