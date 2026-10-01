import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SensingBus } from './event-bus.js'
import type { SensingThought } from './ports.js'
import { createProxmoxAdapter, proxmoxEvents } from './adapters/proxmox.js'
import { buildSensingBus, setSensingConfig, startSensing, stopSensing } from './runtime.js'
import { ProxmoxClient, normalizeFingerprint, parseProxmoxConfig, parseProxmoxToken, type ProxmoxGuest } from '../infra/proxmox.js'
import { FAKE_URL, createFakePve, fakeToken } from '../../test/helpers/fake-pve.js'

// Phase 6c: Proxmox events become thoughts through the sensing port only.

const G = 1024 ** 3
const guest = (vmid: number, status: string, extra: Partial<ProxmoxGuest> = {}): ProxmoxGuest => ({
    vmid, status, name: `g${vmid}`, type: 'qemu', node: 'pve1', cpu: 0, maxcpu: 2, mem: 0, maxmem: 4 * G, disk: 0, maxdisk: 32 * G, tags: [], template: false, uptime: 0, ...extra,
})
const node = (mem: number) => ({ node: 'pve1', status: 'online', cpu: 0.1, maxcpu: 24, mem: mem * G, maxmem: 100 * G, uptime: 1 })
const NOW = Date.parse('2026-10-01T12:00:00Z')

describe('Proxmox-Ereignisse', () => {
    it('first run only remembers the baseline; later stop/start become events', () => {
        const first = proxmoxEvents(undefined, [guest(104, 'running'), guest(150, 'stopped')], [node(50)], { ramWarnPercent: 90, now: NOW })
        expect(first.events).toEqual([])
        const second = proxmoxEvents(first.statuses, [guest(104, 'stopped'), guest(150, 'running')], [node(50)], { ramWarnPercent: 90, now: NOW, poolMembers: new Set([150]) })
        expect(second.events.map(e => [e.kind, e.subject, e.severity])).toEqual([
            ['proxmox.guest-stopped', 'pve:104', 'warning'],
            ['proxmox.guest-started', 'pve:150', 'info'],
        ])
        expect(second.events[0].summary).toContain('VM 104 g104 wurde gestoppt')
    })

    it('host RAM above the threshold is reported (urgent from 97 %)', () => {
        expect(proxmoxEvents({}, [], [node(80)], { ramWarnPercent: 90, now: NOW }).events).toEqual([])
        const warn = proxmoxEvents({}, [], [node(92)], { ramWarnPercent: 90, now: NOW }).events
        expect(warn.map(e => [e.kind, e.severity, e.hint?.title])).toEqual([['proxmox.host-ram', 'warning', 'Proxmox-Host pve1: RAM knapp']])
        expect(proxmoxEvents({}, [], [node(98)], { ramWarnPercent: 90, now: NOW }).events[0].severity).toBe('urgent')
    })

    it('self-recognition: own VMs close to the cap become a thought with a proposal', () => {
        const mine = [guest(150, 'running', { tags: ['xaventra-created'], maxmem: 30 * G }), guest(151, 'stopped', { tags: ['xaventra-created'], maxmem: 30 * G })]
        const events = proxmoxEvents({}, mine, [], { ramWarnPercent: 90, now: NOW, poolMembers: new Set([150, 151]), limits: { ramGB: 64, cores: 16, diskGB: 1024, hostRamReserveGB: 16 } }).events
        expect(events.map(e => e.kind)).toEqual(['proxmox.cap'])
        expect(events[0].hint?.proposal).toContain('/vms entfernen')
    })

    it('adapter → bus → thought sink (the thought hub), no direct channel', async () => {
        const fake = createFakePve()
        const config = parseProxmoxConfig({ enabled: true, url: FAKE_URL, fingerprint: normalizeFingerprint('ef'.repeat(32)), pool: 'xaventra' })
        const client = new ProxmoxClient({ config, token: parseProxmoxToken(fakeToken())!, transport: fake.transport, log: () => {} })
        const thoughts: SensingThought[] = []
        const bus = new SensingBus({ dataDir: mkdtempSync(join(tmpdir(), 'pve-sense-')), eventSink: { writeEvent() {} }, thoughtSink: { writeThought: t => { thoughts.push(t) } }, now: () => NOW } as any)
        bus.register(createProxmoxAdapter({ client: async () => client, ramWarnPercent: 90 }))
        await bus.runAllOnce()
        expect(thoughts).toEqual([])
        fake.guests.find(g => g.vmid === 104)!.status = 'stopped'
        await bus.runAllOnce()
        expect(thoughts.map(t => [t.source, t.title])).toEqual([['proxmox', 'VM 104 fremd-vm gestoppt']])
        expect(fake.writes()).toEqual([])
    })
})

describe('nur am Main, Standard aus', () => {
    it('registers the adapter only with infra.proxmox enabled, and a worker never starts sensing', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'pve-rt-'))
        setSensingConfig({ enabled: true, adapters: {} }, {}, dataDir)
        expect(buildSensingBus().getStatus().map(s => s.id)).not.toContain('proxmox')
        setSensingConfig({ enabled: true, adapters: {} }, { infra: { proxmox: { enabled: true, url: FAKE_URL, fingerprint: 'ab'.repeat(32) } } }, dataDir)
        expect(buildSensingBus().getStatus().map(s => s.id)).toContain('proxmox')
        setSensingConfig({ enabled: true, adapters: {} }, { infra: { proxmox: { enabled: true, url: FAKE_URL, fingerprint: 'ab'.repeat(32), watch: false } } }, dataDir)
        expect(buildSensingBus().getStatus().map(s => s.id)).not.toContain('proxmox')
        expect(startSensing({ nodeOnly: true })).toEqual({ started: false, reason: 'Mesh-Worker: Wahrnehmen läuft nur am Main' })
        stopSensing()
    })
})
