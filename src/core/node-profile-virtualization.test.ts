import { describe, expect, it } from 'vitest'
import { detectVirtualization, formatNodeOverview, privilegedOnOwnMachine, sanitizeNodeProfile, type NodeProfile } from './node-profile.js'

// Phase 6c "Wo laufe ich?": fixtures as a KVM guest on Proxmox, an LXC/Docker
// container and bare metal (Spark-like arm64) would present them.

const QEMU_CPUINFO = 'processor\t: 0\nvendor_id\t: AuthenticAMD\nflags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep hypervisor lahf_lm\n'
const METAL_CPUINFO = 'processor\t: 0\nvendor_id\t: GenuineIntel\nflags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep vmx lahf_lm\n'
const ARM_METAL_CPUINFO = 'processor\t: 0\nBogoMIPS\t: 2000.00\nFeatures\t: fp asimd evtstrm aes pmull sha1 sha2 crc32\nCPU implementer\t: 0x41\n'

const base = { platform: 'linux', runtime: 'native' as const, sysVendor: '', productName: '', hypervisorType: '', cpuinfo: '', containerHint: '' }

function profile(overrides: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'xaventra-lab', hostname: 'xaventra-lab', platform: 'linux', arch: 'x64', version: '2.81.0',
        role: 'worker', runtime: 'native', rootReadOnly: false, noNewPrivileges: false, cpus: 16, ramGB: 64,
        gpu: { name: null, backend: 'cpu', viaVllm: false }, installPath: 'package-manager', tools: [],
        selfCheck: { status: 'ok', checkedAt: '2026-10-01T10:00:00.000Z', items: [] }, collectedAt: '2026-10-01T10:00:00.000Z', ...overrides,
    }
}

describe('Virtualisierung erkennen (ohne Kindprozess, aus /sys und /proc)', () => {
    it('QEMU/KVM guest (Proxmox VM)', () => {
        expect(detectVirtualization({ ...base, sysVendor: 'QEMU\n', productName: 'Standard PC (Q35 + ICH9, 2009)\n', cpuinfo: QEMU_CPUINFO })).toBe('kvm')
        expect(detectVirtualization({ ...base, productName: 'KVM', cpuinfo: QEMU_CPUINFO })).toBe('kvm')
    })

    it('container (Docker runtime or LXC hint) wins over the hypervisor flag', () => {
        expect(detectVirtualization({ ...base, runtime: 'container', sysVendor: 'QEMU', cpuinfo: QEMU_CPUINFO })).toBe('container')
        expect(detectVirtualization({ ...base, containerHint: 'lxc\n', cpuinfo: METAL_CPUINFO })).toBe('container')
    })

    it('bare metal (x86 and arm64)', () => {
        expect(detectVirtualization({ ...base, sysVendor: 'Micro-Star International Co., Ltd.', productName: 'MS-7D75', cpuinfo: METAL_CPUINFO })).toBe('none')
        expect(detectVirtualization({ ...base, sysVendor: 'NVIDIA', productName: 'DGX Spark', cpuinfo: ARM_METAL_CPUINFO })).toBe('none')
    })

    it('another hypervisor or nothing readable is unknown, never guessed', () => {
        expect(detectVirtualization({ ...base, sysVendor: 'VMware, Inc.', cpuinfo: QEMU_CPUINFO })).toBe('unknown')
        expect(detectVirtualization({ ...base, hypervisorType: 'xen', cpuinfo: METAL_CPUINFO })).toBe('unknown')
        expect(detectVirtualization({ ...base })).toBe('unknown')
        expect(detectVirtualization({ ...base, platform: 'win32', sysVendor: 'QEMU' })).toBe('unknown')
    })
})

describe('Empfangsseite begrenzt das Feld', () => {
    it('keeps a plausible Proxmox location and drops anything else', () => {
        const ok = sanitizeNodeProfile({ ...profile(), virtualization: { kind: 'kvm', platform: 'proxmox', vmid: 110, pveNode: 'pve1', ownMachine: true, extra: 'x' } })!
        expect(ok.virtualization).toEqual({ kind: 'kvm', platform: 'proxmox', vmid: 110, pveNode: 'pve1', ownMachine: true })
        expect(sanitizeNodeProfile({ ...profile(), virtualization: { kind: 'hyperv', platform: 'vmware', vmid: 5 } })!.virtualization).toEqual({ kind: 'unknown' })
        expect(sanitizeNodeProfile({ ...profile(), virtualization: { kind: 'kvm', platform: 'proxmox', vmid: 110, pveNode: 'bad node; rm' } })!.virtualization).toEqual({ kind: 'kvm' })
        expect(sanitizeNodeProfile({ ...profile(), virtualization: { kind: 'kvm', platform: 'proxmox', vmid: 110, pveNode: 'pve1', ownMachine: 'yes' } })!.virtualization).toEqual({ kind: 'kvm', platform: 'proxmox', vmid: 110, pveNode: 'pve1', ownMachine: false })
        // older peers without the field
        expect(sanitizeNodeProfile(profile())!.virtualization).toEqual({ kind: 'unknown' })
    })

    it('shows where a node runs in the overview', () => {
        const text = formatNodeOverview([{ nodeId: 'xaventra-lab', profile: profile({ virtualization: { kind: 'kvm', platform: 'proxmox', vmid: 110, pveNode: 'pve1', ownMachine: true } }), local: true }])
        expect(text).toContain('Proxmox-VM 110 auf pve1 (eigene Maschine)')
    })
})

describe('root/sudo nur auf eigenen Maschinen', () => {
    it('only a Proxmox guest in the pool with tag xaventra-created/-lab counts; Spark, ns1, ns2, NAS stay hardened', () => {
        expect(privilegedOnOwnMachine(profile({ virtualization: { kind: 'kvm', platform: 'proxmox', vmid: 110, pveNode: 'pve1', ownMachine: true } }))).toBe(true)
        expect(privilegedOnOwnMachine(profile({ virtualization: { kind: 'kvm', platform: 'proxmox', vmid: 104, pveNode: 'pve1', ownMachine: false } }))).toBe(false)
        expect(privilegedOnOwnMachine(profile({ nodeId: 'xaventra-spark', virtualization: { kind: 'none' } }))).toBe(false)
        expect(privilegedOnOwnMachine(profile({ nodeId: 'xaventra-ns2', runtime: 'container', virtualization: { kind: 'container' } }))).toBe(false)
        expect(privilegedOnOwnMachine(profile({ nodeId: 'xaventra-nas' }))).toBe(false)
        // a forged claim without a Proxmox location does not count
        expect(privilegedOnOwnMachine(profile({ virtualization: { kind: 'none', ownMachine: true } as any }))).toBe(false)
        expect(privilegedOnOwnMachine(profile({ virtualization: { kind: 'kvm', ownMachine: true } as any }))).toBe(false)
    })
})
