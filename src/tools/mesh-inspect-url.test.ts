import { describe, expect, it, vi } from 'vitest'
import { bindMeshLandingPage, meshInspectUrlTool, tailscaleStatusCommand } from './mesh-inspect-url.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { getRelevantTools } from './tool-router.js'
import { selectContextPolicy } from '../core/context-policy.js'

const now = Date.now()
const url = 'https://voice.tail12345.ts.net/'
const peer = { DNSName: 'voice.tail12345.ts.net.', Online: true, TailscaleIPs: ['100.64.7.2'] }
const status = { BackendState: 'Running', Peer: { peer } }
const node = { node_id: 'worker-1', hostname: 'node-one', ip: '100.64.7.2', status: 'online' as const, last_heartbeat: new Date(now).toISOString() }
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), status: vi.fn(), nodes: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: (_file: string, _args: string[], _options: unknown, cb: Function) => cb(null, { stdout: JSON.stringify(mocks.status()) }) }))
vi.mock('../startup/environment-scanner.js', () => ({ locateProgram: () => '/usr/bin/tailscale' }))
vi.mock('../mesh/mesh-registry.js', () => ({ getOnlineNodes: () => mocks.nodes() }))
vi.mock('../resilience/ssrf-guard.js', async original => ({ ...await original<typeof import('../resilience/ssrf-guard.js')>(), fetchWithSsrfGuard: (...args: unknown[]) => mocks.fetch(...args) }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: (id: string) => id === 'owner-fixture' ? 'owner' : 'guest' }))

describe('mesh landing page inspection boundary', () => {
    it('runs the owner handler with exact pinned HTTPS, no redirects and bounded response', async () => {
        mocks.status.mockReturnValue(status)
        mocks.nodes.mockResolvedValue([node])
        mocks.fetch.mockResolvedValue(new Response('<title>Voice demo</title><script>doBadThings()</script>' + 'a'.repeat(40000), { status: 200 }))
        const result: any = await withExecutionPolicyContext({ authUserId: 'owner-fixture', channel: 'telegram' }, () => meshInspectUrlTool.handler({ url }))
        expect(result).toMatchObject({ success: true, status: 200, node: { id: node.node_id } })
        expect(result.content.length).toBeLessThanOrEqual(8000)
        expect(result.content).not.toContain('doBadThings')
        const [target, request, guard] = mocks.fetch.mock.calls.at(-1)!
        expect(target).toBe(url)
        expect(request).toMatchObject({ method: 'GET', redirect: 'manual' })
        expect(request.signal).toBeInstanceOf(AbortSignal)
        expect(guard.allowedAddresses).toEqual([node.ip])
        expect(await guard.lookup('ignored')).toEqual([{ address: node.ip, family: 4 }])
        mocks.fetch.mockClear()
        mocks.status.mockReturnValue({ ...status, BackendState: 'Stopped' })
        expect(await withExecutionPolicyContext({ authUserId: 'owner-fixture', channel: 'telegram' }, () => meshInspectUrlTool.handler({ url }))).toMatchObject({ success: false, kind: 'mapping' })
        expect(mocks.fetch).not.toHaveBeenCalled()
    })
    it('handles a snap installation without sudo or changing the service user', () => {
        expect(tailscaleStatusCommand('/snap/bin/tailscale', () => true)).toEqual({ binary: '/snap/tailscale/current/bin/tailscale', args: ['--socket=/var/snap/tailscale/common/socket/tailscaled.sock', 'status', '--json'] })
        expect(tailscaleStatusCommand('/usr/bin/tailscale', () => true)).toEqual({ binary: '/usr/bin/tailscale', args: ['status', '--json'] })
    })
    it('maps local Tailscale DNS evidence to a current mesh IP, not hostname guesses', () => {
        expect(bindMeshLandingPage(url, status, [node], now)).toMatchObject({ address: node.ip, node })
        expect(bindMeshLandingPage(url, status, [{ ...node, status: 'busy' }], now).node.status).toBe('busy')
    })
    it.each(['http://voice.tail12345.ts.net/', 'https://voice.tail12345.ts.net:8443/', 'https://voice.tail12345.ts.net/admin', 'https://voice.tail12345.ts.net/?action=delete', 'https://voice.tail12345.ts.net/#x', 'https://owner:secret@voice.tail12345.ts.net/', 'https://100.64.7.2/', 'https://voice.tail12345.ts.net.evil.test/'])('rejects an unscoped target %s', target => {
        expect(() => bindMeshLandingPage(target, status, [node], now)).toThrow()
    })
    it('fails closed on stopped tailscale, offline or ambiguous peers and stale mesh evidence', () => {
        for (const bad of [{ ...status, BackendState: 'Stopped' }, { ...status, Peer: {} }, { ...status, Peer: { peer: { ...peer, Online: false } } }, { ...status, Peer: { peer, duplicate: peer } }]) {
            expect(() => bindMeshLandingPage(url, bad, [node], now)).toThrow()
        }
        for (const nodes of [[], [node, node], [{ ...node, ip: '127.0.0.1' }], [{ ...node, last_heartbeat: new Date(now - 300001).toISOString() }], [{ ...node, last_heartbeat: 'invalid' }], [{ ...node, status: 'offline' as const }]]) {
            expect(() => bindMeshLandingPage(url, status, nodes, now)).toThrow()
        }
    })
    it('denies non-owner and missing principal before discovery or network', async () => {
        expect(await meshInspectUrlTool.handler({ url })).toMatchObject({ success: false, kind: 'authorization' })
        expect(await withExecutionPolicyContext({ authUserId: 'owner-fixture' }, () => meshInspectUrlTool.handler({ url }))).toMatchObject({ success: false, kind: 'authorization' })
        expect(await withExecutionPolicyContext({ authUserId: 'guest', channel: 'telegram' }, () => meshInspectUrlTool.handler({ url }))).toMatchObject({ success: false, kind: 'authorization' })
    })
    it('retains mesh context and selects the scoped tool for a lone tailnet link', () => {
        expect(selectContextPolicy(url).mesh).toBe(true)
        const names = getRelevantTools(url).map(t => t.name)
        expect(names).toContain('mesh_inspect_url')
        expect(names).toContain('mesh_services')
        expect(names).not.toContain('ssh_command')
        expect(names).not.toContain('fetch_url')
    })
})
