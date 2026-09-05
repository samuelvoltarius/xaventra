import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MeshIdentity } from '../mesh/mesh-identity.js'
import type { MeshEnvelope } from '../mesh/transport-contracts.js'

export interface ReleaseFileEvidence {
    path: string
    sha256: string
    size: number
}

export interface NovaReleaseManifest {
    schemaVersion: 1
    releaseId: string
    version: string
    createdAt: string
    sourceNode: string
    files: ReleaseFileEvidence[]
    treeHash: string
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

export function releaseTreeHash(files: ReleaseFileEvidence[]): string {
    const canonical = files.map(file => `${file.path}\0${file.sha256}\0${file.size}`).join('\n')
    return createHash('sha256').update(canonical).digest('hex')
}

export function verifyReleaseDirectory(
    envelope: SignedReleaseManifest,
    root: string,
    trustedPublicKeys: string[],
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
    const [manifestPath, root, configPath] = process.argv.slice(2)
    if (!manifestPath || !root || !configPath) throw new Error('usage: release-verifier <manifest> <root> <nova.config.json>')
    const envelope = JSON.parse(readFileSync(manifestPath, 'utf8')) as SignedReleaseManifest
    const result = verifyReleaseDirectory(envelope, root, trustedKeysFromConfig(configPath, envelope.sourceNode))
    if (!result.valid) throw new Error(result.reason)
    process.stdout.write(`verified:${envelope.payload.releaseId}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    cli().catch(error => { console.error(String(error)); process.exitCode = 1 })
}
