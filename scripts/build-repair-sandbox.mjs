// Explicit operator action, never called by model-generated patches.
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { repairDependencyHash } from '../dist/synthesis/patch-sandbox.js'

const context = mkdtempSync(join(tmpdir(), 'xaventra-sandbox-image-'))
for (const name of ['package.json', 'package-lock.json']) copyFileSync(name, join(context, name))
copyFileSync('deploy/repair-sandbox/Dockerfile', join(context, 'Dockerfile'))
const lock = createHash('sha256').update(readFileSync('package-lock.json')).digest('hex')
const idFile = join(context, 'image-id')
execFileSync('docker', ['build', '--build-arg', `LOCK_SHA256=${lock}`, '--build-arg', `DEPENDENCIES_SHA256=${repairDependencyHash(readFileSync('package-lock.json'))}`, '--iidfile', idFile, context], { stdio: 'inherit', timeout: 900_000 })
console.log(`XAVENTRA_REPAIR_SANDBOX_IMAGE=${readFileSync(idFile, 'utf8').trim()}`)
// Manifests only; retain context for image provenance, never source/config/home.
