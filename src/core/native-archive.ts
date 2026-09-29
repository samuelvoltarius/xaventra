import { createHash } from 'node:crypto'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { releaseTreeHash, type ReleaseFileEvidence } from './release-tree.js'

const MAX_BYTES = 2 * 1024 ** 3, MAX_FILES = 100_000
/** Canonical native v1 USTAR header. Only regular files, never links or
 * extension records. This format is deliberately narrower than general tar. */
export function nativeArchiveHeader(path: string, size: number, mode = 0o644): Buffer {
    if (!path || /[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')
        || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').length > 64
        || !Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || ![0o600, 0o644, 0o755].includes(mode)) throw Error('Native archive path/size/mode invalid')
    let name = path, prefix = ''
    if (Buffer.byteLength(name) > 100) {
        const split = path.lastIndexOf('/')
        prefix = path.slice(0, split); name = path.slice(split + 1)
        if (split < 1 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) throw Error('Native archive path too long')
    }
    const h = Buffer.alloc(512)
    h.write(name); h.write(mode.toString(8).padStart(7, '0') + '\0', 100)
    h.write('0000000\0', 108); h.write('0000000\0', 116)
    h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136)
    h.fill(32, 148, 156); h[156] = 48; h.write('ustar\0', 257); h.write('00', 263); h.write(prefix, 345)
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    return h
}

/** Bounded streaming archive inventory. Does not extract or execute anything.
 * Both compressed digest and decompressed tree must match signed commitments. */
export async function verifyNativeArchive(source: Readable, expected: { sha256: string; size: number; treeHash: string }): Promise<ReleaseFileEvidence[]> {
    if (!/^[a-f0-9]{64}$/.test(expected.sha256) || !/^[a-f0-9]{64}$/.test(expected.treeHash)
        || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > MAX_BYTES) throw Error('Native archive commitment invalid')
    const files: ReleaseFileEvidence[] = [], paths = new Set<string>(), directories = new Set<string>()
    let compressed = 0, expanded = 0, payload = 0, padding = 0, terminators = 0, total = 0
    let pending = Buffer.alloc(0), current: { path: string; size: number; hash: ReturnType<typeof createHash> } | undefined
    const digest = createHash('sha256'), abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 60_000)
    const strings = (h: Buffer, start: number, length: number) => h.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    try {
        await pipeline(source, async function* (input) {
            for await (const chunk of input) {
                compressed += chunk.length
                if (compressed > expected.size) throw Error('Native archive compressed budget exceeded')
                digest.update(chunk); yield chunk
            }
        }, createGunzip({ chunkSize: 64 * 1024 }), async function (input) {
            for await (const chunk of input) {
                expanded += chunk.length
                if (expanded > MAX_BYTES + MAX_FILES * 1024 + 1024) throw Error('Native archive expanded budget exceeded')
                pending = Buffer.concat([pending, chunk])
                while (pending.length) {
                    if (current) {
                        const n = Math.min(payload, pending.length)
                        current.hash.update(pending.subarray(0, n)); pending = pending.subarray(n); payload -= n
                        if (payload) break
                        files.push({ path: current.path, size: current.size, sha256: current.hash.digest('hex') }); current = undefined
                    }
                    if (padding) {
                        const n = Math.min(padding, pending.length)
                        if (pending.subarray(0, n).some(b => b !== 0)) throw Error('Native archive padding invalid')
                        pending = pending.subarray(n); padding -= n
                        if (padding) break
                    }
                    if (pending.length < 512) break
                    const h = pending.subarray(0, 512); pending = pending.subarray(512)
                    if (h.every(b => b === 0)) {
                        if (++terminators > 2) throw Error('Native archive trailing data')
                        continue
                    }
                    if (terminators) throw Error('Native archive trailing member')
                    const prefix = strings(h, 345, 155), name = strings(h, 0, 100), path = prefix ? `${prefix}/${name}` : name
                    const size = parseInt(strings(h, 124, 12), 8), mode = parseInt(strings(h, 100, 8), 8)
                    if (!h.equals(nativeArchiveHeader(path, size, mode))) throw Error('Native archive noncanonical header')
                    if (paths.has(path) || directories.has(path) || paths.size >= MAX_FILES) throw Error('Native archive duplicate/conflicting path or file budget')
                    const parts = path.split('/')
                    for (let i = 1; i < parts.length; i++) {
                        const parent = parts.slice(0, i).join('/')
                        if (paths.has(parent)) throw Error('Native archive file used as directory')
                        directories.add(parent)
                    }
                    paths.add(path); total += size
                    if(paths.size+directories.size>MAX_FILES)throw Error('Native archive inventory budget exceeded')
                    if (total > MAX_BYTES) throw Error('Native archive payload budget exceeded')
                    payload = size; padding = (512 - size % 512) % 512
                    current = { path, size, hash: createHash('sha256') }
                    if (!size) { files.push({path, size, sha256:current.hash.digest('hex')}); current = undefined }
                }
            }
        }, { signal: abort.signal })
        if (current || padding || pending.length || terminators !== 2 || !paths.has('dist/daemon.js')) throw Error('Native archive truncated or entrypoint missing')
        files.sort((a, b) => a.path.localeCompare(b.path))
        if (compressed !== expected.size || digest.digest('hex') !== expected.sha256 || releaseTreeHash(files) !== expected.treeHash) throw Error('Native archive commitment mismatch')
        return files
    } finally { clearTimeout(timer); source.destroy() }
}
