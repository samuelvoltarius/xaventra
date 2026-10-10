import { describe, expect, it } from 'vitest'
import {
    detectRuntimeKind, formatNodeOverview, installPathFor, isLoopbackOrLocal, noNewPrivilegesFrom, rootIsReadOnly,
    runLocalSelfCheck, sanitizeNodeProfile, suggestionsFor, usageStatus, worstStatus, type NodeProfile,
} from './node-profile.js'

// Mountinfo lines as read live on 30.09.2026: Spark native service
// (ProtectSystem=strict → "/" ro) and a Docker worker with read_only: true.
const SPARK_MOUNTINFO = '25 1 259:2 / / ro,nosuid,nodev,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n26 25 0:23 / /proc rw - proc proc rw'
const WORKER_MOUNTINFO = '600 500 0:55 / / ro,relatime master:1 - overlay overlay rw,lowerdir=/x\n601 600 0:56 / /tmp rw - tmpfs tmpfs rw'
const WRITABLE_MOUNTINFO = '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw'

function profile(overrides: Partial<NodeProfile> = {}): NodeProfile {
    return {
        schema: 1, nodeId: 'xaventra-spark', hostname: 'node-a', platform: 'linux', arch: 'arm64', version: '2.79.3',
        role: 'main', runtime: 'native', rootReadOnly: true, noNewPrivileges: true, cpus: 20, ramGB: 120,
        gpu: { name: 'NVIDIA GB10', backend: 'cpu', viaVllm: true }, installPath: 'host-agent', tools: ['apt', 'ffmpeg'],
        selfCheck: { status: 'ok', checkedAt: '2026-09-30T21:00:00.000Z', items: [{ id: 'disk-root', label: 'Systemplatte', status: 'ok', detail: '56 % belegt' }] },
        collectedAt: '2026-09-30T21:00:00.000Z', ...overrides,
    }
}

describe('Knotenprofil detection', () => {
    it('tells native, container and unknown apart', () => {
        expect(detectRuntimeKind({ platform: 'linux', dockerenv: false, cgroup: '0::/system.slice/xaventra-native.service', systemdInvocation: true })).toBe('native')
        expect(detectRuntimeKind({ platform: 'linux', dockerenv: true, cgroup: '', systemdInvocation: false })).toBe('container')
        expect(detectRuntimeKind({ platform: 'linux', dockerenv: false, cgroup: '0::/docker/1f2e', systemdInvocation: false })).toBe('container')
        expect(detectRuntimeKind({ platform: 'linux', dockerenv: false, cgroup: '0::/user.slice', systemdInvocation: false })).toBe('unknown')
        expect(detectRuntimeKind({ platform: 'win32', dockerenv: false, cgroup: '', systemdInvocation: false })).toBe('native')
    })

    it('reads the per-mount options of / only', () => {
        expect(rootIsReadOnly(SPARK_MOUNTINFO)).toBe(true)
        expect(rootIsReadOnly(WORKER_MOUNTINFO)).toBe(true)
        expect(rootIsReadOnly(WRITABLE_MOUNTINFO)).toBe(false)
        expect(rootIsReadOnly('')).toBeNull()
        expect(noNewPrivilegesFrom('Name:\tnode\nNoNewPrivs:\t1\n')).toBe(true)
        expect(noNewPrivilegesFrom('NoNewPrivs:\t0')).toBe(false)
    })

    it('names the only honest install path per node (never installs)', () => {
        expect(installPathFor({ runtime: 'container', rootReadOnly: true, noNewPrivileges: true, hasApt: true, isRoot: true })).toBe('image')
        expect(installPathFor({ runtime: 'native', rootReadOnly: true, noNewPrivileges: true, hasApt: true, isRoot: false })).toBe('host-agent')
        expect(installPathFor({ runtime: 'native', rootReadOnly: false, noNewPrivileges: false, hasApt: true, isRoot: true })).toBe('package-manager')
        expect(installPathFor({ runtime: 'native', rootReadOnly: false, noNewPrivileges: false, hasApt: true, isRoot: false })).toBe('none')
    })

    it('counts vLLM as local GPU use only on own addresses (live: ns2 claimed the Spark vLLM)', () => {
        expect(isLoopbackOrLocal('http://127.0.0.1:8000', [])).toBe(true)
        expect(isLoopbackOrLocal('http://0.0.0.0:8000/v1', [])).toBe(true)
        expect(isLoopbackOrLocal('http://100.64.0.10:8000', ['100.64.0.10'])).toBe(true)
        expect(isLoopbackOrLocal('http://100.64.0.10:8000', ['100.64.0.15'])).toBe(false)
        expect(isLoopbackOrLocal('not a url', [])).toBe(false)
    })

    it('grades usage and keeps the worst status', () => {
        expect(usageStatus(56, 85, 95)).toBe('ok')
        expect(usageStatus(90, 85, 95)).toBe('warn')
        expect(usageStatus(96, 85, 95)).toBe('crit')
        expect(worstStatus([{ status: 'ok' }, { status: 'warn' }])).toBe('warn')
        expect(worstStatus([{ status: 'warn' }, { status: 'crit' }])).toBe('crit')
    })

    it('runs a real local self-check without network or child processes', () => {
        const check = runLocalSelfCheck(process.cwd(), new Date('2026-09-30T21:00:00Z'))
        expect(check.items.map(item => item.id)).toContain('disk-root')
        expect(check.items.map(item => item.id)).toContain('memory')
        expect(['ok', 'warn', 'crit']).toContain(check.status)
        expect(check.checkedAt).toBe('2026-09-30T21:00:00.000Z')
    })
})

describe('Knotenprofil from a peer', () => {
    it('accepts a well-formed profile and bounds every field', () => {
        const clean = sanitizeNodeProfile({ ...profile(), tools: Array.from({ length: 100 }, (_, i) => `t${i}`), nodeId: 'x'.repeat(500), extra: 'dropped' })!
        expect(clean.tools).toHaveLength(60)
        expect(clean.nodeId).toHaveLength(80)
        expect((clean as any).extra).toBeUndefined()
    })

    it('rejects foreign shapes and coerces unknown enums conservatively', () => {
        expect(sanitizeNodeProfile(null)).toBeNull()
        expect(sanitizeNodeProfile({ schema: 2 })).toBeNull()
        const odd = sanitizeNodeProfile({ ...profile(), role: 'root', runtime: 'vm', installPath: 'curl|sh', selfCheck: { status: 'fine', items: [{ status: 'great' }] } })!
        expect(odd.role).toBe('worker')
        expect(odd.runtime).toBe('unknown')
        expect(odd.installPath).toBe('none')
        expect(odd.selfCheck.status).toBe('warn')
        expect(odd.selfCheck.items[0].status).toBe('warn')
    })
})

describe('Knoten-Übersicht', () => {
    it('shows every node with fixed-rule suggestions and flags stale or missing data', () => {
        const now = Date.parse('2026-09-30T21:10:00Z')
        const worker = profile({ nodeId: 'xaventra-ns2', role: 'worker', runtime: 'container', installPath: 'image', gpu: { name: null, backend: 'cpu', viaVllm: false },
            selfCheck: { status: 'warn', checkedAt: '', items: [{ id: 'disk-root', label: 'Systemplatte', status: 'warn', detail: '90 % belegt, 5 GB frei' }] } })
        const text = formatNodeOverview([
            { nodeId: 'xaventra-spark', profile: profile(), local: true },
            { nodeId: 'xaventra-ns2', profile: worker, lastSeen: now - 60_000 },
            { nodeId: 'xaventra-ns1', profile: profile({ nodeId: 'xaventra-ns1' }), lastSeen: now - 30 * 60_000 },
            { nodeId: 'xaventra-nas', profile: null, lastSeen: now - 60_000 },
        ], now)
        expect(text).toContain('*xaventra-spark* — Main, nativ, System schreibgeschützt, v2.79.3 (lokal)')
        expect(text).toContain('NVIDIA GB10 (via vLLM)')
        expect(text).toContain('→ GPU wird über vLLM genutzt')
        expect(text).toContain('→ Gehärteter Dienst: Installation nur über den Host-Agenten')
        expect(text).toContain('⚠️ *xaventra-ns2* — Worker, Container')
        expect(text).toContain('→ Systemplatte: 90 % belegt, 5 GB frei')
        expect(text).toContain('→ Container: Pakete nur über ein neues Image')
        expect(text).toContain('❔ *xaventra-ns1*')
        expect(text).toContain('veraltet')
        expect(text).toContain('*xaventra-nas* — kein Profil')
    })

    it('suggests nothing for a healthy writable node without GPU', () => {
        expect(suggestionsFor(profile({ gpu: { name: null, backend: 'cpu', viaVllm: false }, installPath: 'package-manager' }))).toEqual([])
    })
})

describe('Knotenprofil publishing (start + change, Alfred 30.09.2026)', () => {
    it('publishes on start, on a real change and as a 6 h safety copy only', async () => {
        const { profileFingerprint, shouldPublishProfile, PROFILE_SAFETY_RESEND_MS } = await import('./node-profile.js')
        const base = profile()
        const fp = profileFingerprint(base)
        expect(shouldPublishProfile(fp, null, 0)).toBe(true)
        const last = { fingerprint: fp, sentAt: 0 }
        // Drifting numbers and timestamps are no change.
        const drift = profile({ collectedAt: 'later', selfCheck: { ...base.selfCheck, checkedAt: 'later', items: [{ ...base.selfCheck.items[0], detail: '57 % belegt' }] } })
        expect(shouldPublishProfile(profileFingerprint(drift), last, 30_000)).toBe(false)
        // A status flip or a new version is.
        const warn = profile({ selfCheck: { ...base.selfCheck, status: 'warn', items: [{ ...base.selfCheck.items[0], status: 'warn' }] } })
        expect(shouldPublishProfile(profileFingerprint(warn), last, 30_000)).toBe(true)
        expect(shouldPublishProfile(profileFingerprint(profile({ version: '2.79.4' })), last, 30_000)).toBe(true)
        expect(shouldPublishProfile(fp, last, PROFILE_SAFETY_RESEND_MS)).toBe(true)
    })
})
