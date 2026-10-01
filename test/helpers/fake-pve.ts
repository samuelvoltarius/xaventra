/**
 * Fake Proxmox VE for tests (no real host, no real address, no real key).
 * - `createFakePve()` is an in-memory transport that records every request.
 * - `selfSignedCert()` builds a throw-away EC certificate at runtime, so the
 *   pinned-TLS path can be tested against a real local TLS server.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import type { ProxmoxRequest, ProxmoxResponse, ProxmoxTransport } from '../../src/infra/proxmox.js'

export const FAKE_URL = 'https://192.0.2.10:8006'
export const FAKE_NODE = 'pve1'
/** Runtime-generated token, never a literal. */
export function fakeToken(): string { return `xaventra@pve!xv=${randomUUID()}` }

export interface FakeGuest {
    vmid: number; name: string; type: 'qemu' | 'lxc'; status: string; mac: string
    maxmem?: number; mem?: number; maxcpu?: number; maxdisk?: number; template?: number; tags?: string; protection?: number; cores?: number; memory?: number; diskGB?: number
}

const G = 1024 ** 3

export function createFakePve(options: { guests?: FakeGuest[]; pool?: number[]; snapshots?: Record<number, string[]>; nodeMem?: [number, number]; taskPolls?: number; exitstatus?: string; nextid?: number } = {}) {
    const guests: FakeGuest[] = options.guests || [
        { vmid: 104, name: 'fremd-vm', type: 'qemu', status: 'running', mac: '02:00:00:00:01:04' },
        { vmid: 110, name: 'xaventra-lab', type: 'qemu', status: 'running', mac: '02:00:00:00:01:10', tags: 'xaventra-lab', protection: 1 },
        { vmid: 150, name: 'xv-test', type: 'qemu', status: 'running', mac: '02:00:00:00:01:50', tags: 'xaventra-created', maxcpu: 2, maxmem: 4 * G, maxdisk: 32 * G, cores: 2, memory: 4096, diskGB: 32 },
        { vmid: 151, name: 'xv-alt', type: 'qemu', status: 'stopped', mac: '02:00:00:00:01:51', tags: 'xaventra-created', maxcpu: 2, maxmem: 4 * G, maxdisk: 32 * G },
        { vmid: 152, name: 'pool-ohne-tag', type: 'qemu', status: 'stopped', mac: '02:00:00:00:01:52' },
        { vmid: 153, name: 'xv-geschuetzt', type: 'qemu', status: 'stopped', mac: '02:00:00:00:01:53', tags: 'xaventra-created', protection: 1, maxcpu: 1, maxmem: 2 * G, maxdisk: 16 * G },
        { vmid: 200, name: 'fremd-ct', type: 'lxc', status: 'stopped', mac: '02:00:00:00:02:00', tags: 'xaventra-created' },
        { vmid: 9000, name: 'vorlage', type: 'qemu', status: 'stopped', mac: '02:00:00:00:90:00', template: 1 },
    ]
    const pool = new Set(options.pool || [110, 150, 151, 152, 153, 9000])
    const snapshots = options.snapshots || { 150: ['vorher'] }
    const calls: ProxmoxRequest[] = []
    let polls = 0
    const upidFor = (type: string, vmid: number | string) => `UPID:${FAKE_NODE}:0000ABCD:0001E240:6720F000:${type}:${vmid}:xaventra@pve!xv:`
    const respond = (data: unknown, status = 200): ProxmoxResponse => ({ status, data })
    const transport: ProxmoxTransport = async (request) => {
        calls.push(JSON.parse(JSON.stringify(request)))
        const { method, path } = request
        if (method === 'GET' && path === '/cluster/resources?type=vm') {
            return respond(guests.map(g => ({ vmid: g.vmid, name: g.name, type: g.type, node: FAKE_NODE, status: g.status, cpu: 0.05, maxcpu: g.maxcpu ?? 4,
                mem: g.mem ?? 2 * G, maxmem: g.maxmem ?? 8 * G, disk: 0, maxdisk: g.maxdisk ?? 32 * G, template: g.template || 0, tags: g.tags || '',
                ...(pool.has(g.vmid) ? { pool: 'xaventra' } : {}) })))
        }
        if (method === 'GET' && path === '/nodes') {
            const [mem, maxmem] = options.nodeMem || [60 * G, 157 * G]
            return respond([{ node: FAKE_NODE, status: 'online', cpu: 0.1, maxcpu: 24, mem, maxmem, uptime: 1000 }])
        }
        if (method === 'GET' && path === '/cluster/nextid') return respond(String(options.nextid ?? 160))
        if (method === 'GET' && path === '/pools?poolid=xaventra') {
            return respond([{ poolid: 'xaventra', members: guests.filter(g => pool.has(g.vmid)).map(g => ({ vmid: g.vmid, type: g.type, node: FAKE_NODE, id: `${g.type}/${g.vmid}` })) }])
        }
        let match = /^\/nodes\/pve1\/(qemu|lxc)\/(\d+)\/config$/.exec(path)
        if (method === 'GET' && match) {
            const g = guests.find(item => item.vmid === Number(match![2]))
            if (!g) return respond(null, 500)
            const common = { tags: g.tags || undefined, protection: g.protection ? 1 : undefined, cores: g.cores ?? 2, memory: g.memory ?? 4096 }
            return respond(g.type === 'qemu'
                ? { name: g.name, ...common, scsi0: `local-lvm:vm-${g.vmid}-disk-0,size=${g.diskGB ?? 32}G`, ide2: `local-lvm:vm-${g.vmid}-cloudinit,media=cdrom`, net0: `virtio=${g.mac},bridge=vmbr0,firewall=1` }
                : { hostname: g.name, ...common, net0: `name=eth0,bridge=vmbr1,hwaddr=${g.mac},ip=dhcp,type=veth` })
        }
        match = /^\/nodes\/pve1\/(qemu|lxc)\/(\d+)\/snapshot$/.exec(path)
        if (method === 'GET' && match) {
            return respond([...(snapshots[Number(match[2])] || []).map(name => ({ name, description: 'test', snaptime: 1727700000 })), { name: 'current', description: 'You are here!' }])
        }
        match = /^\/nodes\/pve1\/(qemu|lxc)\/(\d+)\/(status\/start|status\/shutdown|snapshot|snapshot\/[^/]+\/rollback|config|clone)$/.exec(path)
        if (method === 'POST' && match) return respond(upidFor(`${match[1]}${match[3].split('/').pop()}`, match[2]))
        if (method === 'POST' && path === '/nodes/pve1/qemu') return respond(upidFor('qmcreate', request.form?.vmid || 0))
        match = /^\/nodes\/pve1\/qemu\/(\d+)\/resize$/.exec(path)
        if (method === 'PUT' && match) return respond(upidFor('resize', match[1]))
        match = /^\/nodes\/pve1\/(qemu|lxc)\/(\d+)\?purge=1&destroy-unreferenced-disks=1$/.exec(path)
        if (method === 'DELETE' && match) return respond(upidFor(`${match[1]}destroy`, match[2]))
        match = /^\/nodes\/pve1\/tasks\/([^/]+)\/status$/.exec(path)
        if (method === 'GET' && match) {
            polls++
            const done = polls >= (options.taskPolls ?? 2)
            if (done) polls = 0
            return respond(done ? { status: 'stopped', exitstatus: options.exitstatus ?? 'OK', upid: decodeURIComponent(match[1]) } : { status: 'running', upid: decodeURIComponent(match[1]) })
        }
        return respond(null, 501)
    }
    return {
        transport, calls, guests,
        writes: () => calls.filter(call => call.method !== 'GET'),
        taskPolls: () => calls.filter(call => /\/tasks\//.test(call.path)).length,
    }
}

// ---------------------------------------------------------------------------
// Minimal DER/X.509 builder (EC P-256, self-signed), runtime only
// ---------------------------------------------------------------------------

function der(tag: number, content: Buffer): Buffer {
    const length = content.length
    if (length < 0x80) return Buffer.concat([Buffer.from([tag, length]), content])
    const bytes: number[] = []
    for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff)
    return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), content])
}
const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts))
function oid(dotted: string): Buffer {
    const parts = dotted.split('.').map(Number)
    const out = [40 * parts[0] + parts[1]]
    for (const value of parts.slice(2)) {
        const bytes = [value & 0x7f]
        for (let n = value >> 7; n > 0; n >>= 7) bytes.unshift((n & 0x7f) | 0x80)
        out.push(...bytes)
    }
    return der(0x06, Buffer.from(out))
}
const utcTime = (date: Date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`))
const x500Name = (cn: string) => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))))

export function selfSignedCert(commonName = 'pve.example.com'): { cert: string; key: string; fingerprint: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const algorithm = seq(oid('1.2.840.10045.4.3.2'))
    const serial = randomBytes(8)
    serial[0] = (serial[0] & 0x7f) | 0x01
    const now = Date.now()
    const tbs = seq(
        der(0xa0, der(0x02, Buffer.from([2]))),
        der(0x02, serial),
        algorithm,
        x500Name(commonName),
        seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
        x500Name(commonName),
        publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    )
    const signature = sign('sha256', tbs, privateKey)
    const certificate = seq(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])))
    const body = certificate.toString('base64').match(/.{1,64}/g)!.join('\n')
    return {
        cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        fingerprint: createHash('sha256').update(certificate).digest('hex').toUpperCase().match(/../g)!.join(':'),
    }
}
