import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    CREATED_TAG, PROXMOX_ACTIONS, ProxmoxClient, ProxmoxPinError, buildInventory, capViolation, createPinnedTransport, decodeActionRef,
    diskSizeGB, encodeActionRef, isOwnMachine, loadProxmoxRuntime, macsFromGuestConfig, matchGuestByMac, normalizeFingerprint,
    parseProxmoxConfig, parseProxmoxToken, renderOwnVmCloudInit, type ProxmoxConfig,
} from './proxmox.js'
import { FAKE_URL, createFakePve, fakeToken, selfSignedCert } from '../../test/helpers/fake-pve.js'
import { redactSecrets } from '../security/secret-redaction.js'

// Phase 6c: Proxmox adapter. Only fakes — no real host, no real address, no real key.

const PIN = normalizeFingerprint('ab'.repeat(32))!
const RAW = { enabled: true, url: FAKE_URL, fingerprint: PIN, pool: 'xaventra', create: { sshKeys: `ssh-ed25519 ${'A'.repeat(68)} owner@example.com` } }

function client(fake = createFakePve(), overrides: Partial<ProxmoxConfig> = {}, log: string[] = []) {
    const token = parseProxmoxToken(fakeToken())!
    return { fake, log, token, client: new ProxmoxClient({ config: { ...parseProxmoxConfig(RAW), ...overrides }, token, transport: fake.transport, log: line => log.push(line), sleep: async () => {}, taskPollMs: 1 }) }
}

describe('Standard AUS und Zugangsdaten', () => {
    it('is off unless enabled, https URL and pinned fingerprint are all set', () => {
        expect(parseProxmoxConfig(undefined).enabled).toBe(false)
        expect(parseProxmoxConfig({ url: FAKE_URL, fingerprint: PIN }).enabled).toBe(false)
        expect(parseProxmoxConfig({ ...RAW, url: 'http://192.0.2.10:8006' }).enabled).toBe(false)
        expect(parseProxmoxConfig({ ...RAW, fingerprint: 'abc' }).enabled).toBe(false)
        expect(parseProxmoxConfig({ ...RAW, url: 'https://user:pw@192.0.2.10:8006' }).enabled).toBe(false)
        const on = parseProxmoxConfig({ ...RAW, url: 'https://192.0.2.10' })
        expect(on).toMatchObject({ enabled: true, url: 'https://192.0.2.10:8006', pool: 'xaventra', limits: { ramGB: 64, cores: 16, diskGB: 1024 } })
    })

    it('needs the env token in USER@REALM!TOKENID=SECRET form and never echoes it', async () => {
        expect((await loadProxmoxRuntime({ rawConfig: undefined, env: {} })).ok).toBe(false)
        expect(await loadProxmoxRuntime({ rawConfig: RAW, env: {} })).toEqual({ ok: false, reason: 'XAVENTRA_PVE_TOKEN ist nicht gesetzt' })
        const bad = `kaputt-${fakeToken().split('=')[1]}`
        const refused = await loadProxmoxRuntime({ rawConfig: RAW, env: { XAVENTRA_PVE_TOKEN: bad } })
        expect(refused.ok).toBe(false)
        expect(JSON.stringify(refused)).not.toContain(bad.slice(8))
        expect((await loadProxmoxRuntime({ rawConfig: RAW, env: { XAVENTRA_PVE_TOKEN: fakeToken() } })).ok).toBe(true)
        expect(parseProxmoxToken('root@pam!x=not-a-uuid')).toBeNull()
    })
})

describe('gepinnter TLS-Fingerprint (echter lokaler TLS-Server)', () => {
    let server: Server | null = null
    afterEach(async () => { await new Promise(resolve => server ? server.close(resolve) : resolve(null)); server = null })

    async function start() {
        const cert = selfSignedCert()
        const seen: Array<{ url?: string; auth?: string }> = []
        server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
            seen.push({ url: req.url, auth: String(req.headers.authorization || '') })
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ data: { version: '9.2' } }))
        })
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
        return { cert, seen, url: `https://127.0.0.1:${(server!.address() as AddressInfo).port}` }
    }

    it('refuses the connection on a wrong fingerprint and sends nothing (no request, no token)', async () => {
        const { seen, url } = await start()
        const token = parseProxmoxToken(fakeToken())!
        const transport = createPinnedTransport({ url, fingerprint: PIN, authHeader: token.header, timeoutMs: 5000 })
        await expect(transport({ method: 'GET', path: '/version' })).rejects.toBeInstanceOf(ProxmoxPinError)
        expect(seen).toEqual([])
    })

    it('talks to the host only with the exact pinned fingerprint', async () => {
        const { cert, seen, url } = await start()
        const token = parseProxmoxToken(fakeToken())!
        const transport = createPinnedTransport({ url, fingerprint: cert.fingerprint.replace(/:/g, '').toLowerCase(), authHeader: token.header, timeoutMs: 5000 })
        await expect(transport({ method: 'GET', path: '/version' })).resolves.toEqual({ status: 200, data: { version: '9.2' } })
        expect(seen).toEqual([{ url: '/api2/json/version', auth: token.header }])
    })

    it('does not switch TLS verification off globally', () => {
        expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe('0')
    })
})

describe('lesend', () => {
    it('lists guests with pool, tags, status and resources', async () => {
        const { client: pve } = client()
        const inv = await pve.inventory(110)
        expect(inv.guests.map(g => g.vmid)).toEqual([104, 110, 150, 151, 152, 153, 200, 9000])
        expect([...inv.members].sort()).toEqual([110, 150, 151, 152, 153, 9000])
        expect(inv.mine.map(g => g.vmid)).toEqual([150, 151, 153])
        expect(inv.self?.name).toBe('xaventra-lab')
        expect(inv.usage).toEqual({ ramGB: 10, cores: 5, diskGB: 80, count: 3 })
        expect(inv.free).toMatchObject({ ramGB: 54, cores: 11, diskGB: 944 })
    })

    it('finds its own guest by MAC (VM net0 and CT hwaddr), ambiguity = not found', async () => {
        expect(macsFromGuestConfig({ net0: 'virtio=02:00:00:00:01:50,bridge=vmbr0', net1: 'name=eth0,hwaddr=02:00:00:00:02:00,bridge=vmbr1', scsi0: 'x' })).toEqual(['02:00:00:00:01:50', '02:00:00:00:02:00'])
        expect(matchGuestByMac(['02:00:00:00:01:50'], [{ vmid: 150, node: 'pve1', macs: ['02:00:00:00:01:50'] }, { vmid: 151, node: 'pve1', macs: ['02:00:00:00:01:51'] }])).toEqual({ vmid: 150, node: 'pve1' })
        expect(matchGuestByMac(['02:00:00:00:01:50'], [{ vmid: 150, node: 'pve1', macs: ['02:00:00:00:01:50'] }, { vmid: 151, node: 'pve1', macs: ['02:00:00:00:01:50'] }])).toBeNull()
        const { client: pve, fake } = client()
        await expect(pve.locateSelf(['02:00:00:00:01:10'])).resolves.toEqual({ vmid: 110, node: 'pve1', ownMachine: true })
        await expect(pve.locateSelf(['02:00:00:00:01:04'])).resolves.toEqual({ vmid: 104, node: 'pve1', ownMachine: false })
        await expect(pve.locateSelf(['02:00:00:00:99:99'])).resolves.toBeNull()
        expect(fake.writes()).toEqual([])
    })
})

describe('schreibend nur im Pool', () => {
    it('refuses a guest outside the pool without any write request', async () => {
        const { client: pve, fake } = client()
        for (const vmid of [104, 200]) {
            const result = await pve.executeAction({ action: 'start', vmid })
            expect(result).toMatchObject({ ok: false, requested: false })
            expect(result.message).toContain('nicht im Pool')
        }
        expect(fake.writes()).toEqual([])
    })

    it('refuses unknown actions and invalid input before any request at all', async () => {
        const { client: pve, fake } = client()
        for (const input of [{ action: 'reset', vmid: 150 }, { action: 'migrate', vmid: 150 }, { action: 'delete-snapshot', vmid: 150 }, { action: 'start', vmid: 7 }]) {
            expect(await pve.executeAction(input as any)).toMatchObject({ ok: false, requested: false })
        }
        expect(fake.calls).toEqual([])
        expect(await pve.executeAction({ action: 'snapshot', vmid: 150, snapname: 'x y' })).toMatchObject({ ok: false, requested: false })
        expect(fake.writes()).toEqual([])
    })

    it('Ja-path: exactly one write with the exact vmid, then the task is polled until OK', async () => {
        const { client: pve, fake } = client(createFakePve({ taskPolls: 3 }))
        const result = await pve.executeAction({ action: 'snapshot', vmid: 152, snapname: 'vor-test' })
        expect(result).toMatchObject({ ok: true, requested: true })
        expect(fake.writes()).toEqual([{ method: 'POST', path: '/nodes/pve1/qemu/152/snapshot', form: { snapname: 'vor-test', description: 'Xaventra, Owner-Freigabe' } }])
        expect(fake.taskPolls()).toBe(3)
        expect(result.upid).toMatch(/^UPID:pve1:.*:152:/)
    })

    it('a task that ends with an error is reported as failed', async () => {
        const { client: pve } = client(createFakePve({ exitstatus: 'command failed' }))
        const result = await pve.executeAction({ action: 'shutdown', vmid: 151 })
        expect(result.ok).toBe(false)
        expect(result.message).toContain('command failed')
    })

    it('shutdown is the clean one (no forceStop), start/rollback hit the exact paths', async () => {
        const { client: pve, fake } = client()
        await pve.executeAction({ action: 'shutdown', vmid: 152 })
        await pve.executeAction({ action: 'start', vmid: 152 })
        expect(fake.writes()).toEqual([
            { method: 'POST', path: '/nodes/pve1/qemu/152/status/shutdown', form: { timeout: '180' } },
            { method: 'POST', path: '/nodes/pve1/qemu/152/status/start' },
        ])
    })
})

describe('anlegen: Pool + Tag + vmbr0, Deckel', () => {
    it('create sets pool, tag xaventra-created and bridge vmbr0, then grows the disk', async () => {
        const { client: pve, fake } = client()
        const result = await pve.executeAction({ action: 'create', vmid: 160, spec: { name: 'wegwerf-test', cores: 2, memoryMB: 4096, diskGB: 40 } })
        expect(result).toMatchObject({ ok: true, requested: true })
        const [create, resize] = fake.writes()
        expect(create).toMatchObject({ method: 'POST', path: '/nodes/pve1/qemu' })
        expect(create.form).toMatchObject({ vmid: '160', name: 'wegwerf-test', pool: 'xaventra', tags: CREATED_TAG, net0: 'virtio,bridge=vmbr0', cores: '2', memory: '4096', ciuser: 'nova' })
        expect(create.form!.scsi0).toBe('local-lvm:0,import-from=local:iso/noble-server-cloudimg-amd64.img')
        expect(resize).toEqual({ method: 'PUT', path: '/nodes/pve1/qemu/160/resize', form: { disk: 'scsi0', size: '40G' } })
        expect(fake.writes()).toHaveLength(2)
    })

    it('with a cicustom snippet the user nova gets passwordless sudo (snippet content rendered)', async () => {
        const { client: pve, fake } = client(createFakePve(), { create: { ...parseProxmoxConfig(RAW).create, cicustom: 'user=local:snippets/xaventra-nova.yaml' } })
        await pve.executeAction({ action: 'create', vmid: 160, spec: { name: 'mit-snippet', cores: 1, memoryMB: 2048, diskGB: 16 } })
        expect(fake.writes()[0].form).toMatchObject({ cicustom: 'user=local:snippets/xaventra-nova.yaml', tags: CREATED_TAG, pool: 'xaventra' })
        expect(fake.writes()[0].form!.ciuser).toBeUndefined()
        const yaml = renderOwnVmCloudInit(parseProxmoxConfig(RAW).create.sshKeys)
        expect(yaml).toContain('  - name: nova')
        expect(yaml).toContain('sudo: "ALL=(ALL) NOPASSWD:ALL"')
        expect(yaml).toContain('groups: [sudo, docker]')
        expect(yaml).toContain('timezone: Europe/Vienna')
    })

    it('clone only from a VM template inside the pool, then tags and pins vmbr0', async () => {
        const { client: pve, fake } = client()
        expect(await pve.executeAction({ action: 'create', vmid: 160, spec: { name: 'klon', cores: 2, memoryMB: 2048, diskGB: 32, template: 104 } })).toMatchObject({ ok: false, requested: false })
        expect(fake.writes()).toEqual([])
        expect(await pve.executeAction({ action: 'create', vmid: 160, spec: { name: 'klon', cores: 2, memoryMB: 2048, diskGB: 32, template: 9000 } })).toMatchObject({ ok: true })
        const [clone, config] = fake.writes()
        expect(clone).toMatchObject({ method: 'POST', path: '/nodes/pve1/qemu/9000/clone', form: { newid: '160', pool: 'xaventra', full: '1' } })
        expect(config).toMatchObject({ method: 'POST', path: '/nodes/pve1/qemu/160/config', form: { tags: CREATED_TAG, net0: 'virtio,bridge=vmbr0' } })
    })

    it('refuses with a reason and without any write when the cap or the host reserve would be exceeded', async () => {
        const { client: pve, fake } = client(createFakePve(), { limits: { ramGB: 12, cores: 16, diskGB: 1024, hostRamReserveGB: 16 } })
        const ram = await pve.executeAction({ action: 'create', vmid: 160, spec: { name: 'zu-gross', cores: 2, memoryMB: 4096, diskGB: 32 } })
        expect(ram).toMatchObject({ ok: false, requested: false })
        expect(ram.message).toContain('Ressourcen-Deckel: RAM 10+4 > 12 GB')
        const { client: tight, fake: fake2 } = client(createFakePve({ nodeMem: [150 * 1024 ** 3, 157 * 1024 ** 3] }))
        const host = await tight.executeAction({ action: 'create', vmid: 160, spec: { name: 'host-voll', cores: 1, memoryMB: 2048, diskGB: 16 } })
        expect(host.message).toContain('Reserve 16 GB')
        expect([...fake.writes(), ...fake2.writes()]).toEqual([])
        expect(capViolation({ ramGB: 0, cores: 15, diskGB: 0, count: 0 }, { ramGB: 1, cores: 2, diskGB: 1 }, { ramGB: 64, cores: 16, diskGB: 1024, hostRamReserveGB: 0 })).toContain('Kerne 15+2 > 16')
    })
})

describe('verwalten und entfernen', () => {
    it('configure only grows, respects the cap and snapshots an own VM first', async () => {
        const { client: pve, fake } = client()
        expect(await pve.executeAction({ action: 'configure', vmid: 150, spec: { memoryMB: 2048 } })).toMatchObject({ ok: false, requested: false })
        expect(await pve.executeAction({ action: 'configure', vmid: 150, spec: { diskGB: 16 } })).toMatchObject({ ok: false, requested: false })
        expect(fake.writes()).toEqual([])
        const ok = await pve.executeAction({ action: 'configure', vmid: 150, spec: { cores: 4, memoryMB: 8192, diskGB: 64 } })
        expect(ok).toMatchObject({ ok: true, requested: true })
        const [snap, config, resize] = fake.writes()
        expect(snap).toMatchObject({ method: 'POST', path: '/nodes/pve1/qemu/150/snapshot' })
        expect(snap.form!.snapname).toMatch(/^xv-auto-\d{8}-\d{6}$/)
        expect(config).toEqual({ method: 'POST', path: '/nodes/pve1/qemu/150/config', form: { cores: '4', memory: '8192' } })
        expect(resize).toEqual({ method: 'PUT', path: '/nodes/pve1/qemu/150/resize', form: { disk: 'scsi0', size: '64G' } })
    })

    it('rollback on an own VM keeps the current state as auto-snapshot first', async () => {
        const { client: pve, fake } = client()
        expect(await pve.executeAction({ action: 'rollback', vmid: 150, snapname: 'gibtsnicht' })).toMatchObject({ ok: false, requested: false })
        expect(fake.writes()).toEqual([])
        await pve.executeAction({ action: 'rollback', vmid: 150, snapname: 'vorher' })
        expect(fake.writes().map(w => w.path)).toEqual(['/nodes/pve1/qemu/150/snapshot', '/nodes/pve1/qemu/150/snapshot/vorher/rollback'])
    })

    it('destroy: refused for foreign, untagged, protected, running and this VM — without any write', async () => {
        const { client: pve, fake } = client()
        const cases: Array<[number, string]> = [[104, 'nicht im Pool'], [200, 'nicht im Pool'], [152, 'Tag xaventra-created'], [110, 'Tag xaventra-created'], [153, 'protection=1'], [150, 'läuft noch']]
        for (const [vmid, reason] of cases) {
            const result = await pve.executeAction({ action: 'destroy', vmid })
            expect(result.ok, String(vmid)).toBe(false)
            expect(result.message).toContain(reason)
        }
        expect((await pve.executeAction({ action: 'destroy', vmid: 151 }, { selfVmid: 151 })).message).toContain('Xaventra läuft')
        expect(fake.writes()).toEqual([])
    })

    it('destroy of an own, stopped, unprotected xaventra-created VM is one DELETE + task check', async () => {
        const { client: pve, fake } = client()
        const result = await pve.executeAction({ action: 'destroy', vmid: 151 }, { selfVmid: 110 })
        expect(result).toMatchObject({ ok: true, requested: true })
        expect(fake.writes()).toEqual([{ method: 'DELETE', path: '/nodes/pve1/qemu/151?purge=1&destroy-unreferenced-disks=1' }])
    })
})

describe('Token nie im Log', () => {
    it('keeps the token out of logs, errors and console output', async () => {
        const spies = (['log', 'warn', 'error', 'debug', 'info'] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}))
        const fake = createFakePve()
        const token = fakeToken()
        const secret = token.split('=')[1]
        const leaky = async (request: any) => { if (request.method !== 'GET') throw new Error(`boom ${token} PVEAPIToken=${token}`); return fake.transport(request) }
        const log: string[] = []
        const pve = new ProxmoxClient({ config: parseProxmoxConfig(RAW), token: parseProxmoxToken(token)!, transport: leaky, log: line => log.push(line), sleep: async () => {} })
        const result = await pve.executeAction({ action: 'start', vmid: 152 })
        expect(result.ok).toBe(false)
        const runtime = await loadProxmoxRuntime({ rawConfig: RAW, env: { XAVENTRA_PVE_TOKEN: token }, transport: fake.transport, log: line => log.push(line), sleep: async () => {} })
        expect(runtime.ok).toBe(true)
        const everything = JSON.stringify([result, log, runtime.ok ? runtime.config : null, ...spies.map(spy => spy.mock.calls)])
        expect(everything).not.toContain(secret)
        for (const spy of spies) spy.mockRestore()
    })

    it('the shared redaction also masks Proxmox tokens', () => {
        const token = fakeToken()
        const out = redactSecrets(`Authorization: PVEAPIToken=${token} und ${token}`)
        expect(out).not.toContain(token.split('=')[1])
        expect(out).toContain('xaventra@pve!xv=[REDACTED]')
    })
})

describe('Klassifizierung und Referenzen', () => {
    it('every write is a classified card kind with impact infra; snapshot L1, everything else L2', () => {
        expect(Object.fromEntries(Object.entries(PROXMOX_ACTIONS).map(([action, cls]) => [action, [cls.kind, cls.level]]))).toEqual({
            snapshot: ['pve-snapshot', 'L1'], start: ['pve-start', 'L2'], shutdown: ['pve-herunterfahren', 'L2'], rollback: ['pve-rollback', 'L2'],
            create: ['pve-anlegen', 'L2'], configure: ['pve-anpassen', 'L2'], destroy: ['pve-entfernen', 'L2'],
        })
    })

    it('card refs round-trip and reject anything malformed', () => {
        const inputs = [
            { action: 'create', vmid: 160, spec: { name: 'wegwerf-x', cores: 2, memoryMB: 4096, diskGB: 32, template: 9000 } },
            { action: 'configure', vmid: 150, spec: { cores: 4, diskGB: 64 } },
            { action: 'rollback', vmid: 150, snapname: 'vorher' },
            { action: 'destroy', vmid: 151 },
        ] as const
        for (const input of inputs) expect(decodeActionRef(input.action, encodeActionRef(input as any))).toEqual(input)
        expect(decodeActionRef('destroy', '151:x')).toBeNull()
        expect(decodeActionRef('create', '160:Name:c2:m4096:d32')).toBeNull()
        expect(decodeActionRef('configure', '150:c2:c4')).toBeNull()
        expect(decodeActionRef('start', '42')).toBeNull()
    })

    it('helpers: disk size, own machine, inventory', () => {
        expect(diskSizeGB('local-lvm:vm-1-disk-0,size=200G')).toBe(200)
        expect(diskSizeGB('local-lvm:vm-1-disk-0,size=1T')).toBe(1024)
        const members = new Set([110, 150])
        expect(isOwnMachine({ vmid: 110, tags: ['xaventra-lab'] }, members)).toBe(true)
        expect(isOwnMachine({ vmid: 150, tags: ['xaventra-created'] }, members)).toBe(true)
        expect(isOwnMachine({ vmid: 104, tags: ['xaventra-created'] }, members)).toBe(false)
        expect(isOwnMachine({ vmid: 150, tags: [] }, members)).toBe(false)
        expect(buildInventory([], members, parseProxmoxConfig(RAW).limits, null).free.ramGB).toBe(64)
    })
})
