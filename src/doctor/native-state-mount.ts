import { lstat, open, readlink } from 'node:fs/promises'
import { posix } from 'node:path'

export interface NativeStateMountProfile {
    path: string; namespace: string; device: string; inode: string; fsType: string
}
export interface NativeStateMountReader {
    namespace(): Promise<string>
    mountinfo(): Promise<string>
    identity(path: string): Promise<{ inode: string }>
}
const LIMIT = 2 * 1024 * 1024
const linuxReader: NativeStateMountReader = {
    namespace: () => readlink('/proc/self/ns/mnt'),
    mountinfo: async () => {
        const fd = await open('/proc/self/mountinfo', 'r'), bytes = Buffer.alloc(LIMIT + 1)
        try {
            let size = 0
            while (size < bytes.length) { const r = await fd.read(bytes, size, bytes.length - size, null); if (!r.bytesRead) break; size += r.bytesRead }
            if (size > LIMIT) throw Error('Mount evidence budget exceeded')
            return bytes.subarray(0, size).toString('utf8')
        } finally { await fd.close() }
    },
    identity: async path => {
        // No link may redirect the protected enrollment path.
        for (let p = path; ; p = posix.dirname(p)) {
            const s = await lstat(p, { bigint: true })
            if (!s.isDirectory() || s.isSymbolicLink()) throw Error('Unsafe state mount path')
            if (p === '/') break
        }
        return { inode: (await lstat(path, { bigint: true })).ino.toString() }
    },
}
function decode(value: string): string {
    if (/\\(?!040|011|012|134)/.test(value)) throw Error('Invalid mount escape')
    return value.replace(/\\(040|011|012|134)/g, (_, n) => String.fromCharCode(parseInt(n, 8)))
}
function observation(raw: string, p: NativeStateMountProfile) {
    if (!raw || Buffer.byteLength(raw) > LIMIT || !raw.endsWith('\n')) throw Error('Invalid mount evidence')
    const mounts = raw.trimEnd().split('\n').map(line => {
        const f = line.split(' '), separator = f.indexOf('-')
        if (separator < 6 || f.length !== separator + 4 || !/^\d+$/.test(f[0]) || !/^\d+:\d+$/.test(f[2])) throw Error('Invalid mount entry')
        return { id: f[0], device: f[2], root: decode(f[3]), path: decode(f[4]), options: f[5].split(','),
            fsType: f[separator + 1], superOptions: f[separator + 3].split(',') }
    })
    const exact = mounts.filter(m => m.path === p.path)
    if (exact.length !== 1 || mounts.some(m => m.path.startsWith(`${p.path}/`))) throw Error('Exact unstacked state mount required')
    const m = exact[0]
    if (m.device !== p.device || m.fsType !== p.fsType || m.root !== '/' || !m.options.includes('ro') || m.options.includes('rw')
        || !m.superOptions.includes('ro') || m.superOptions.includes('rw')) throw Error('Enrolled filesystem is not read-only')
    return { mountId: m.id, device: m.device, path: m.path, namespace: p.namespace, inode: p.inode, fileSystemReadOnly: true as const }
}
/** Read-only observation, never mounts/remounts. Profile comes from protected
 * enrollment. A ro bind over an rw superblock is insufficient: alternate paths
 * or existing descriptors can still write. Require the whole local filesystem
 * read-only with no submounts. This is NOT external/Mesh quiescence, a snapshot
 * receipt, or a fence against a privileged actor remounting it later. Revalidate
 * around copying/rollback while the controller retains authority and its lock. */
export async function verifyNativeReadOnlyMount(p: NativeStateMountProfile, reader: NativeStateMountReader = linuxReader) {
    if (reader === linuxReader && process.platform !== 'linux') throw Error('Linux mount verification required')
    if (!p.path.startsWith('/') || p.path === '/' || posix.normalize(p.path) !== p.path || p.path.endsWith('/') || /[\x00-\x1f\x7f]/.test(p.path)
        || !/^mnt:\[\d+\]$/.test(p.namespace) || !/^\d+:\d+$/.test(p.device) || !/^\d+$/.test(p.inode)
        || !['ext4', 'xfs', 'tmpfs'].includes(p.fsType)) throw Error('Invalid state mount enrollment')
    let previous: ReturnType<typeof observation>
    for (let pass = 0; pass < 2; pass++) {
        if (await reader.namespace() !== p.namespace || (await reader.identity(p.path)).inode !== p.inode) throw Error('State mount identity mismatch')
        const current = observation(await reader.mountinfo(), p)
        if (previous && JSON.stringify(previous) !== JSON.stringify(current)) throw Error('State mount changed')
        previous = current
    }
    if (await reader.namespace() !== p.namespace || (await reader.identity(p.path)).inode !== p.inode) throw Error('State mount identity changed')
    return previous!
}
