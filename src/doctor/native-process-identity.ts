import { open, readlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
export interface NativeProcessIdentity {
    pid: number; startTicks: string; executable: string; executableHash: string
    argv: string[]; cwd: string; cgroup: string
    runtimeAccount?: { uid:number; gid:number }
}
export interface ProcessIdentityReader {
    read(path: string, limit: number): Promise<Buffer>
    link(path: string): Promise<string>
    hash(path: string): Promise<string>
}
async function boundedRead(path: string, limit: number): Promise<Buffer> {
    const fd = await open(path, 'r'), bytes = Buffer.alloc(limit + 1)
    try {
        let size = 0
        while (size < bytes.length) { const r = await fd.read(bytes, size, bytes.length - size, null); if (!r.bytesRead) break; size += r.bytesRead }
        if (size > limit) throw Error('Process identity budget exceeded')
        return bytes.subarray(0, size)
    } finally { await fd.close() }
}
export const linuxProcessIdentityReader: ProcessIdentityReader = {
    read: boundedRead, link: readlink,
    hash: async path => {
        const fd = await open(path, 'r'), hash = createHash('sha256'), bytes = Buffer.alloc(1024 * 1024)
        try {
            let total = 0
            for (;;) { const r = await fd.read(bytes, 0, bytes.length, null); if (!r.bytesRead) break; total += r.bytesRead
                if (total > 256 * 1024 * 1024) throw Error('Executable identity budget exceeded')
                hash.update(bytes.subarray(0, r.bytesRead)) }
            return hash.digest('hex')
        } finally { await fd.close() }
    },
}
function startTicks(raw: Buffer, pid: number): string {
    const text = raw.toString('utf8'), end = text.lastIndexOf(')')
    if (!text.startsWith(`${pid} (`) || end < 0) throw Error('Invalid process stat')
    const fields = text.slice(end + 2).trim().split(/\s+/)
    if (!/^[0-9]+$/.test(fields[19] || '') || ['Z', 'X', 'x'].includes(fields[0])) throw Error('Process exited or stat invalid')
    return fields[19] // /proc stat field22, after pid and parenthesized comm.
}
export type NativeProcessProfile = Omit<NativeProcessIdentity, 'pid' | 'startTicks'>
/** PID is obtained from the service manager; immutable attributes come from
 * protected enrollment. Start ticks are an observed incarnation anchor, not a
 * release identity. Keep checking them throughout the verification. */
export async function verifyNativeServiceProcess(pid: number, profile: NativeProcessProfile, reader: ProcessIdentityReader = linuxProcessIdentityReader): Promise<void> {
    profile = structuredClone(profile)
    if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Invalid service PID')
    const ticks = startTicks(await reader.read(`/proc/${pid}/stat`, 8192), pid)
    await verifyNativeProcess({ ...profile, pid, startTicks: ticks }, reader)
}
/** Enrollment supplies ALL expected fields from protected release/unit metadata.
 * Callers must not populate expected identity from the process being verified.
 * This proves executable identity, not JS module contents or HTTP readiness. */
export async function verifyNativeProcess(expected: NativeProcessIdentity, reader: ProcessIdentityReader = linuxProcessIdentityReader): Promise<void> {
    expected=structuredClone(expected)
    const account=expected.runtimeAccount
    if(account&&![account.uid,account.gid].every(n=>Number.isSafeInteger(n)&&n>0&&n<0xffffffff))throw Error('Invalid enrolled process account')
    if (reader === linuxProcessIdentityReader && process.platform !== 'linux') throw Error('Linux process identity required')
    if (!Number.isSafeInteger(expected.pid) || expected.pid < 1 || !/^[0-9]+$/.test(expected.startTicks)
        || !/^[a-f0-9]{64}$/.test(expected.executableHash) || !expected.executable.startsWith('/') || !expected.cwd.startsWith('/')
        || !expected.cgroup || !expected.argv.length || expected.argv.some(a => typeof a !== 'string' || a.includes('\0'))) throw Error('Invalid enrolled process identity')
    const root = `/proc/${expected.pid}`
    for (let pass = 0; pass < 2; pass++) {
        if (startTicks(await reader.read(`${root}/stat`, 8192), expected.pid) !== expected.startTicks) throw Error('Process incarnation changed')
        if (await reader.link(`${root}/exe`) !== expected.executable || await reader.link(`${root}/cwd`) !== expected.cwd) throw Error('Process path identity mismatch')
        const raw = await reader.read(`${root}/cmdline`, 64 * 1024)
        if (!raw.length || raw[raw.length - 1] !== 0) throw Error('Invalid process arguments')
        if (JSON.stringify(raw.subarray(0, -1).toString('utf8').split('\0')) !== JSON.stringify(expected.argv)
            || (await reader.read(`${root}/cgroup`, 16 * 1024)).toString('utf8') !== expected.cgroup) throw Error('Process invocation identity mismatch')
        if (await reader.hash(`${root}/exe`) !== expected.executableHash) throw Error('Process executable hash mismatch')
        if(account){
            const status=(await reader.read(`${root}/status`,64*1024)).toString('utf8')
            for(const [key,value] of [['Uid',account.uid],['Gid',account.gid]] as const){
                const lines=status.split('\n').filter(line=>line.startsWith(key+':'))
                if(lines.length!==1)throw Error('Process account observation missing or ambiguous')
                const ids=lines[0].slice(4).trim().split(/\s+/)
                if(ids.length!==4||ids.some(id=>!/^\d+$/.test(id)||Number(id)!==value))throw Error('Process account identity mismatch')
            }
        }
    }
    if (startTicks(await reader.read(`${root}/stat`, 8192), expected.pid) !== expected.startTicks) throw Error('Process incarnation changed')
}
