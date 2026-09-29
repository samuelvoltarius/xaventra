import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { UPDATE_REPOSITORY, type UpstreamManifest } from './github-update.js'

export interface ContainerUpdatePackage {
    schema: 1; kind: 'docker'; repository: string; version: string; commit: string
    platform: 'linux'; arch: 'x64' | 'arm64'; image: string
}
export interface NativeUpdatePackage {
    schema: 1; kind: 'native'; repository: string; version: string; commit: string
    platform: 'linux'; arch: 'x64' | 'arm64'
    treeHash: string
    archive: { sha256: string; size: number }
    entrypoint: 'dist/daemon.js'
}
/** One regular USTAR entry. No host extraction, links, extensions or scripts. */
export function encodeUpdatePackage(value: ContainerUpdatePackage): Buffer {
    return encodeDescriptor(value,'container.json')
}
export function encodeNativeUpdatePackage(value: NativeUpdatePackage): Buffer {
    return encodeDescriptor(value,'native.json')
}
function encodeDescriptor(value: ContainerUpdatePackage | NativeUpdatePackage, name: string): Buffer {
    const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(512)
    header.write(name); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263)
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512 + 1024)]), { level: 9 })
}
export function decodeUpdatePackage(bytes: Buffer, manifest: UpstreamManifest, arch: string): ContainerUpdatePackage {
    const value: ContainerUpdatePackage = decodeDescriptor(bytes,'container.json')
    if (value.schema !== 1 || value.kind !== 'docker' || value.repository !== UPDATE_REPOSITORY || value.version !== manifest.version
        || value.commit !== manifest.commit || value.platform !== 'linux' || value.arch !== arch
        || !/^ghcr\.io\/samuelvoltarius\/xaventra@sha256:[a-f0-9]{64}$/.test(value.image)) throw Error('Container identity mismatch')
    return value
}
function decodeDescriptor(bytes: Buffer, name: string): any {
    const raw = gunzipSync(bytes, { maxOutputLength: 16 * 1024 })
    if (raw.length < 1536 || raw.length % 512) throw Error('Invalid container package')
    const header = Buffer.from(raw.subarray(0, 512)), stored = header.subarray(148, 154).toString()
    header.fill(32, 148, 156)
    if (!/^[0-7]{6}$/.test(stored) || parseInt(stored, 8) !== [...header].reduce((a, b) => a + b, 0)
        || raw.subarray(0, 100).toString().replace(/\0+$/, '') !== name
        || raw[156] !== 48 || raw.subarray(257, 263).toString() !== 'ustar\0') throw Error('Unsupported container package entry')
    const length = raw.subarray(124, 135).toString()
    if (!/^[0-7]{11}$/.test(length)) throw Error('Invalid entry length')
    const size = parseInt(length, 8), end = 512 + size
    if (size > 8192 || raw.length !== 512 + Math.ceil(size / 512) * 512 + 1024 || raw.subarray(end).some(b => b !== 0)) throw Error('Extra or truncated package content')
    return JSON.parse(raw.subarray(512, end).toString('utf8'))
}
export function decodeNativeUpdatePackage(bytes: Buffer, manifest: UpstreamManifest, arch: string): NativeUpdatePackage {
    const value: NativeUpdatePackage = decodeDescriptor(bytes,'native.json')
    if (!value || value.schema !== 1 || value.kind !== 'native' || value.repository !== UPDATE_REPOSITORY
        || value.version !== manifest.version || value.commit !== manifest.commit || value.platform !== 'linux'
        || !['x64','arm64'].includes(arch) || value.arch !== arch || value.entrypoint !== 'dist/daemon.js'
        || !/^[a-f0-9]{64}$/.test(value.treeHash) || !value.archive || !/^[a-f0-9]{64}$/.test(value.archive.sha256)
        || !Number.isSafeInteger(value.archive.size) || value.archive.size <= 0 || value.archive.size > 2 * 1024 ** 3
        || Object.keys(value).sort().join(',') !== 'arch,archive,commit,entrypoint,kind,platform,repository,schema,treeHash,version'
        || Object.keys(value.archive).sort().join(',') !== 'sha256,size') throw Error('Native identity mismatch')
    return value
}
export function upstreamReleaseId(manifest: UpstreamManifest): string {
    return `${manifest.version}-${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`
}
