import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MeshIdentity } from '../mesh/mesh-identity.js'
import type { MeshEnvelope } from '../mesh/transport-contracts.js'
import { releaseTreeHash, type ReleaseFileEvidence } from './release-tree.js'
export { releaseTreeHash, type ReleaseFileEvidence } from './release-tree.js'

export interface NovaReleaseManifest {
    schemaVersion: 1
    releaseId: string
    version: string
    createdAt: string
    sourceNode: string
    files: ReleaseFileEvidence[]
    treeHash: string
    /** CL-07: lease epoch of the signing Main (absent on pre-fencing releases). */
    mainLeaseEpoch?: number
    fenceService?: string
}

export type SignedReleaseManifest = MeshEnvelope<NovaReleaseManifest>

function safeRelativePath(value: string): boolean {
    return Boolean(value) && !value.includes('..') && !value.startsWith('/') && !value.startsWith('\\') && !value.includes('\0')
}

export function hashFile(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function listReleaseFiles(root: string): ReleaseFileEvidence[] {
    const absoluteRoot = resolve(root)
    const files: ReleaseFileEvidence[] = []
    const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const fullPath = resolve(directory, entry.name)
            const rel = relative(absoluteRoot, fullPath).split(sep).join('/')
            if (entry.isDirectory()) visit(fullPath)
            else if (entry.isFile() && rel !== '.nova-release.json') {
                const stats = statSync(fullPath)
                files.push({ path: rel, sha256: hashFile(fullPath), size: stats.size })
            }
        }
    }
    visit(absoluteRoot)
    return files.sort((a, b) => a.path.localeCompare(b.path))
}

export function verifyReleaseDirectory(
    envelope: SignedReleaseManifest,
    root: string,
    trustedPublicKeys: string[],
    minimumEpoch = 0,
): { valid: boolean; reason?: string } {
    if (envelope.kind !== 'update.release' || !MeshIdentity.verify(envelope)) {
        return { valid: false, reason: 'invalid release signature' }
    }
    if (!trustedPublicKeys.some(key => MeshIdentity.fingerprint(key) === MeshIdentity.fingerprint(envelope.publicKey))) {
        return { valid: false, reason: 'release signer is not trusted' }
    }
    const manifest = envelope.payload
    if (!manifest || manifest.schemaVersion !== 1 || manifest.sourceNode !== envelope.sourceNode || !manifest.releaseId) {
        return { valid: false, reason: 'invalid release manifest schema' }
    }
    if (manifest.treeHash !== releaseTreeHash(manifest.files)) {
        return { valid: false, reason: 'manifest tree hash mismatch' }
    }
    // CL-07: a node that already accepted a newer Main epoch refuses an
    // older Main's release before anything is activated.
    if (minimumEpoch > 0 && !(Number(manifest.mainLeaseEpoch) >= minimumEpoch)) {
        return { valid: false, reason: `release epoch ${manifest.mainLeaseEpoch ?? 'none'} is older than accepted epoch ${minimumEpoch}` }
    }
    const absoluteRoot = resolve(root)
    for (const file of manifest.files) {
        if (!safeRelativePath(file.path)) return { valid: false, reason: `unsafe release path: ${file.path}` }
        const fullPath = resolve(absoluteRoot, file.path)
        if (!fullPath.startsWith(`${absoluteRoot}${sep}`) || !existsSync(fullPath)) {
            return { valid: false, reason: `release file missing: ${file.path}` }
        }
        const stats = statSync(fullPath)
        if (!stats.isFile() || stats.size !== file.size || hashFile(fullPath) !== file.sha256) {
            return { valid: false, reason: `release file hash mismatch: ${file.path}` }
        }
    }
    return { valid: true }
}

export function trustedKeysFromConfig(configPath: string, sourceNode: string): string[] {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as any
    const peers = Array.isArray(config.mesh?.direct?.peers) ? config.mesh.direct.peers : []
    const releaseKeys = Array.isArray(config.mesh?.update?.trustedReleaseKeys)
        ? config.mesh.update.trustedReleaseKeys
        : []
    return [...new Set([...peers, ...releaseKeys]
        .filter((entry: any) => entry.nodeId === sourceNode && typeof entry.publicKey === 'string')
        .map((entry: any) => entry.publicKey))]
}

async function cli(): Promise<void> {
    const [manifestPath, root, configPath, fenceEpochPath] = process.argv.slice(2)
    if (!manifestPath || !root || !configPath) throw new Error('usage: release-verifier <manifest> <root> <xaventra.config.json> [fence-epoch-file]')
    const envelope = JSON.parse(readFileSync(manifestPath, 'utf8')) as SignedReleaseManifest
    const minimumEpoch = fenceEpochPath && existsSync(fenceEpochPath) ? Number(readFileSync(fenceEpochPath, 'utf8').trim()) || 0 : 0
    const result = verifyReleaseDirectory(envelope, root, trustedKeysFromConfig(configPath, envelope.sourceNode), minimumEpoch)
    if (!result.valid) throw new Error(result.reason)
    process.stdout.write(`verified:${envelope.payload.releaseId}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    cli().catch(error => { console.error(String(error)); process.exitCode = 1 })
}
