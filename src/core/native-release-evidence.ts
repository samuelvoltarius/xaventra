import { createHash } from 'node:crypto'
import { verifyUpstreamManifest, type GitHubUpdatePolicy, type SignedUpstreamManifest } from './github-update.js'
import { decodeNativeUpdatePackage, upstreamReleaseId, type NativeUpdatePackage } from './update-package.js'
import { NATIVE_ARCHES, nativeDescriptorAsset, nativeProgramAsset, parseNativeChecksums, verifyNativeReleaseInventory, type NativeArch } from './native-release-assets.js'

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

export interface NativePublicationTarget {
    arch: NativeArch; descriptorAsset: string; programAsset: string
    descriptor: NativeUpdatePackage; descriptorHash: string
}
/** Cross-binds one complete native publication WITHOUT reading program archives:
 * exact asset inventory, signed manifest, both descriptors and SHA256SUMS.native.
 * Returned program SHA256/size come from signed descriptors; callers must still
 * stream-verify the archive bytes (verifyNativeArchive) before any use. */
export function verifyNativePublication(input: {
    names: readonly string[]; signed: SignedUpstreamManifest; policy: GitHubUpdatePolicy
    expected: { version: string; commit: string; updater: string }
    descriptors: Readonly<Record<string, Buffer>>; checksums: string
}): { releaseId: string; targets: NativePublicationTarget[] } {
    const { version, commit, updater } = input.expected
    verifyNativeReleaseInventory(input.names, version)
    const manifest = verifyUpstreamManifest(input.signed, input.policy, version, updater)
    if (manifest.commit !== commit) throw Error('Native publication commit mismatch')
    const listed = manifest.artifacts.map(a => a.name).sort().join('\n')
    if (manifest.artifacts.length !== NATIVE_ARCHES.length
        || listed !== NATIVE_ARCHES.map(arch => nativeDescriptorAsset(version, arch)).sort().join('\n')) throw Error('Native manifest inventory mismatch')
    const sums = parseNativeChecksums(input.checksums, version), trees = new Set<string>(), archives = new Set<string>()
    const targets = NATIVE_ARCHES.map(arch => {
        const descriptorAsset = nativeDescriptorAsset(version, arch), programAsset = nativeProgramAsset(version, arch)
        const artifact = manifest.artifacts.find(a => a.name === descriptorAsset)
        const bytes = input.descriptors[arch]
        if (!artifact || artifact.platform !== 'linux' || artifact.arch !== arch || !Buffer.isBuffer(bytes)) throw Error('Native descriptor missing for architecture')
        const descriptorHash = createHash('sha256').update(bytes).digest('hex')
        if (artifact.size !== bytes.length || artifact.sha256 !== descriptorHash || sums.get(descriptorAsset) !== descriptorHash) throw Error('Native descriptor bytes mismatch')
        const descriptor = decodeNativeUpdatePackage(bytes, manifest, arch)
        if (sums.get(programAsset) !== descriptor.archive.sha256) throw Error('Native program checksum does not match signed descriptor')
        // Distinct architectures must not share one archive or program tree.
        if (archives.has(descriptor.archive.sha256) || trees.has(descriptor.treeHash)) throw Error('Native architectures share one program')
        archives.add(descriptor.archive.sha256); trees.add(descriptor.treeHash)
        return { arch, descriptorAsset, programAsset, descriptor, descriptorHash }
    })
    return { releaseId: upstreamReleaseId(manifest), targets }
}
