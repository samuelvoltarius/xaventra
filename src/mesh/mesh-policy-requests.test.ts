import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MeshIdentity } from './mesh-identity.js'
import { isSafeRemotePath, MeshPolicy } from './mesh-policy.js'
import type { MeshEnvelopeKind, MeshPeer, MeshRole } from './transport-contracts.js'

// MI-6: remote file tools need a path boundary, and request kinds need a
// minimum principal role. A compromised worker must not read Main's mesh key.

const worker = new MeshIdentity('pi5', mkdtempSync(join(tmpdir(), 'nova-mi6-')))
const peer = (roles: MeshRole[]): MeshPeer => ({ nodeId: 'pi5', transport: 'direct', status: 'unknown', publicKey: worker.publicKey, roles })
let n = 0
const request = (kind: MeshEnvelopeKind, role: MeshRole, payload: unknown) => worker.create({
    kind, targetNode: 'main', principal: { id: 'node:pi5', role }, payload,
    fence: { service: 'mission:x', epoch: 1, token: 'fence-token', authority: 'static' },
})
const tool = (tool: string, args: Record<string, unknown>) => ({ tool, arguments: args, idempotencyKey: `tool-key-${++n}` })

describe('MI-6 mesh request policy', () => {
    const policy = new MeshPolicy({ mode: 'direct', peers: [peer(['system', 'worker', 'observer'])] }, 'main')

    it('limits exchange requests to configured privileged roles and flat exchange names', () => {
        expect(policy.verify(request('exchange.request', 'worker', { operation: 'list' }))).toMatchObject({ accepted: false, reason: 'request_role_not_allowed' })
        expect(policy.verify(request('exchange.request', 'system', { operation: 'list' }))).toMatchObject({ accepted: true })
        expect(policy.verify(request('exchange.request', 'system', { operation: 'read', name: '../auth.json' }))).toMatchObject({ accepted: false, reason: 'invalid_exchange_request' })
    })

    it.each([
        '.nova-data/mesh-identity/main.json',
        '/etc/passwd',
        '../outside.txt',
        'src/../../.ssh/id_ed25519',
        'xaventra.config.json',
        'deploy/.env.production',
        'C:\\Users\\nova\\secret.txt',
        '~/.bashrc',
        '.git/config',
    ])('rejects read_file %s', path => {
        expect(policy.verify(request('tool.request', 'worker', tool('read_file', { path })))).toMatchObject({ accepted: false, reason: 'remote_path_not_allowed' })
    })

    it('rejects code_search/list_directory rooted in the data directory', () => {
        expect(policy.verify(request('tool.request', 'worker', tool('code_search', { path: '.nova-data', query: 'privateKey' }))).accepted).toBe(false)
        expect(policy.verify(request('tool.request', 'worker', tool('list_directory', { path: '.nova-data/mesh-identity' }))).accepted).toBe(false)
    })

    it('rejects injected identity fields in tool arguments', () => {
        expect(policy.verify(request('tool.request', 'worker', tool('read_file', { path: 'README.md', authorizationUserId: '4242', channel: 'telegram' }))))
            .toMatchObject({ accepted: false, reason: 'reserved_identity_argument' })
    })

    it('still allows workspace-relative reads for a worker', () => {
        expect(policy.verify(request('tool.request', 'worker', tool('read_file', { path: 'src/index.ts' })))).toMatchObject({ accepted: true })
        expect(policy.verify(request('tool.request', 'worker', tool('list_directory', { path: '.' })))).toMatchObject({ accepted: true })
    })

    it('denies tool and agent requests from an observer principal', () => {
        expect(policy.verify(request('tool.request', 'observer', tool('health_status', {})))).toMatchObject({ accepted: false, reason: 'request_role_not_allowed' })
        expect(policy.verify(request('agent.request', 'observer', { prompt: 'hi', idempotencyKey: 'agent-key-1' }))).toMatchObject({ accepted: false, reason: 'request_role_not_allowed' })
    })

    it('requires a privileged principal for mission handoff and Codex access', () => {
        const mission = { missionId: 'm1', checkpoint: '{"id":"m1","steps":[]}', phase: 'active', pendingActions: [], idempotencyKey: 'mission:m1' }
        expect(policy.verify(request('mission.request', 'worker', mission))).toMatchObject({ accepted: false, reason: 'request_role_not_allowed' })
        expect(policy.verify(request('codex.status.request', 'worker', { idempotencyKey: 'codex-status:1' }))).toMatchObject({ accepted: false, reason: 'request_role_not_allowed' })
        expect(policy.verify(request('mission.request', 'system', { ...mission, idempotencyKey: 'mission:m1:b' }))).toMatchObject({ accepted: true })
    })

    it('isSafeRemotePath accepts plain relative paths only', () => {
        expect(isSafeRemotePath('src/mesh/mesh-policy.ts')).toBe(true)
        expect(isSafeRemotePath('docs')).toBe(true)
        expect(isSafeRemotePath('')).toBe(false)
        expect(isSafeRemotePath(42)).toBe(false)
    })
})
