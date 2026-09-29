import { createHash } from 'node:crypto'
import { verifyUpstreamManifest, type GitHubUpdatePolicy, type SignedUpstreamManifest } from './github-update.js'
import { decodeNativeUpdatePackage, upstreamReleaseId } from './update-package.js'

/** Publisher-bound descriptor verification ONLY. Does not fetch, extract, run
 * code or elevate an on-disk application tree into verified state. Native host
 * enrollment must independently hash the archive and installed tree afterwards. */
export function verifyNativeReleaseEvidence(signed: SignedUpstreamManifest, policy: GitHubUpdatePolicy,
    expected: { version: string; updater: string; arch: 'x64' | 'arm64'; commit: string; descriptorHash: string; treeHash: string }, bytes: Buffer) {
    const manifest = verifyUpstreamManifest(signed,policy,expected.version,expected.updater)
    if (manifest.commit !== expected.commit || !/^[a-f0-9]{64}$/.test(expected.descriptorHash)
        || !/^[a-f0-9]{64}$/.test(expected.treeHash)) throw Error('Native enrolled release mismatch')
    const artifact = manifest.artifacts.find(a => a.platform === 'linux' && a.arch === expected.arch)
    if (!artifact || artifact.size !== bytes.length || artifact.sha256 !== expected.descriptorHash
        || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw Error('Native descriptor bytes mismatch')
    const descriptor = decodeNativeUpdatePackage(bytes,manifest,expected.arch)
    if (descriptor.treeHash !== expected.treeHash) throw Error('Native program tree enrollment mismatch')
    return {releaseId:upstreamReleaseId(manifest),descriptor,descriptorHash:artifact.sha256}
}
