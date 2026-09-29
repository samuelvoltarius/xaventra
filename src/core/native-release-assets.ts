/** Fixed release asset contract shared by the native publisher and downloader.
 * Pure names and inventory checks only: no I/O, network, extraction or crypto.
 * Deliberately dependency-free so github-update.ts can import it without a cycle.
 *
 * The signed manifest lists only the small descriptors (its artifact names must
 * stay `xaventra-*.tar.gz`, one per target). Each descriptor commits to the
 * program archive by SHA256/size; the archive name is derived here, never read
 * from a release, URL or descriptor field. */

export const NATIVE_MANIFEST_ASSET = 'xaventra-native-update.json'
export const NATIVE_CHECKSUM_ASSET = 'SHA256SUMS.native'
export const NATIVE_ARCHES = ['x64', 'arm64'] as const
export type NativeArch = typeof NATIVE_ARCHES[number]

const VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/
const DESCRIPTOR = /^xaventra-native-(\d+\.\d+\.\d+(?:-rc\.\d+)?)-linux-(x64|arm64)\.tar\.gz$/
const PROGRAM = /^xaventra-native-program-(\d+\.\d+\.\d+(?:-rc\.\d+)?)-linux-(x64|arm64)\.tar\.gz$/

function exactVersion(version: string): string {
    if (typeof version !== 'string' || !VERSION.test(version)) throw Error('Exact native release version required')
    return version
}
function exactArch(arch: string): NativeArch {
    if (!(NATIVE_ARCHES as readonly string[]).includes(arch)) throw Error('Unsupported native architecture')
    return arch as NativeArch
}

/** Signed-manifest artifact name of the descriptor for one target. */
export function nativeDescriptorAsset(version: string, arch: string): string {
    return `xaventra-native-${exactVersion(version)}-linux-${exactArch(arch)}.tar.gz`
}
/** Program archive asset name; bytes are bound by the descriptor, not the manifest. */
export function nativeProgramAsset(version: string, arch: string): string {
    return `xaventra-native-program-${exactVersion(version)}-linux-${exactArch(arch)}.tar.gz`
}

export type NativeAssetRole = 'manifest' | 'checksums' | 'descriptor' | 'program'
/** Strict classification. Returns undefined for names outside the native namespace
 * (e.g. Docker assets in the same release); throws for malformed native names. */
export function classifyNativeAsset(name: string): { role: NativeAssetRole; version?: string; arch?: NativeArch } | undefined {
    if (name === NATIVE_MANIFEST_ASSET) return { role: 'manifest' }
    if (name === NATIVE_CHECKSUM_ASSET) return { role: 'checksums' }
    if (!name.startsWith('xaventra-native')) return undefined
    const program = PROGRAM.exec(name)
    if (program) return { role: 'program', version: program[1], arch: program[2] as NativeArch }
    const descriptor = DESCRIPTOR.exec(name)
    if (descriptor) return { role: 'descriptor', version: descriptor[1], arch: descriptor[2] as NativeArch }
    throw Error('Malformed native release asset name')
}

/** Every native asset one complete publication contains, manifest LAST: publishers
 * must upload in this order so a reader never sees a manifest before its files. */
export function nativeReleaseInventory(version: string): string[] {
    exactVersion(version)
    return [
        ...NATIVE_ARCHES.flatMap(arch => [nativeProgramAsset(version, arch), nativeDescriptorAsset(version, arch)]),
        NATIVE_CHECKSUM_ASSET,
        NATIVE_MANIFEST_ASSET,
    ]
}

/** Complete, unique, same-version native inventory. Non-native names (Docker
 * assets sharing the release) are ignored; any duplicate, missing, extra or
 * foreign-version native asset rejects the whole release. */
export function verifyNativeReleaseInventory(names: readonly string[], version: string): string[] {
    const expected = nativeReleaseInventory(version), seen = new Set<string>()
    for (const name of names) {
        if (typeof name !== 'string') throw Error('Invalid release asset name')
        const kind = classifyNativeAsset(name)
        if (!kind) continue
        if (seen.has(name)) throw Error('Duplicate native release asset')
        if (kind.version !== undefined && kind.version !== version) throw Error('Native release asset version mismatch')
        seen.add(name)
    }
    for (const name of expected) if (!seen.has(name)) throw Error('Incomplete native release publication')
    if (seen.size !== expected.length) throw Error('Unexpected native release asset')
    return expected
}

/** Parse `SHA256SUMS.native`: exactly one lowercase hash per inventory file except
 * itself and the manifest, in inventory order, LF line endings, no extras. */
export function parseNativeChecksums(text: string, version: string): Map<string, string> {
    const files = nativeReleaseInventory(version).filter(n => n !== NATIVE_CHECKSUM_ASSET && n !== NATIVE_MANIFEST_ASSET)
    if (typeof text !== 'string' || text.length > 4096 || !text.endsWith('\n') || text.includes('\r')) throw Error('Invalid native checksum file')
    const lines = text.slice(0, -1).split('\n')
    if (lines.length !== files.length) throw Error('Native checksum inventory mismatch')
    const sums = new Map<string, string>()
    lines.forEach((line, i) => {
        const m = /^([a-f0-9]{64})  (\S+)$/.exec(line)
        if (!m || m[2] !== files[i]) throw Error('Native checksum inventory mismatch')
        sums.set(m[2], m[1])
    })
    return sums
}
export function formatNativeChecksums(version: string, sha256: (name: string) => string): string {
    const files = nativeReleaseInventory(version).filter(n => n !== NATIVE_CHECKSUM_ASSET && n !== NATIVE_MANIFEST_ASSET)
    return files.map(name => {
        const hash = sha256(name)
        if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid native checksum')
        return `${hash}  ${name}`
    }).join('\n') + '\n'
}
