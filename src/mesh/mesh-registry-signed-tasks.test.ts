import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MeshIdentity } from './mesh-identity.js'

// MI-1: rows from the shared nova_mesh_tasks table are untrusted. Only
// envelopes signed by the local node or a configured peer key are accepted,
// and the sender identity is rebound to the verified node.

const spark = new MeshIdentity('spark', mkdtempSync(join(tmpdir(), 'nova-mi1-spark-')))
const impostor = new MeshIdentity('spark', mkdtempSync(join(tmpdir(), 'nova-mi1-impostor-')))
let rows: Array<Record<string, unknown>> = []
const posted: Array<Record<string, any>> = []
let registry: typeof import('./mesh-registry.js')
let runtime: typeof import('./mesh-transport-runtime.js')

const ownerMission = { id: 'm-owner-1', steps: [{ id: 1, command: 'lies die config' }], channel: 'telegram', createdBy: '4242', status: 'active' }
const signedMission = (identity: MeshIdentity, mission: Record<string, unknown>, role: 'system' | 'worker' = 'system') =>
    `mission:${JSON.stringify(identity.create({
        kind: 'mission.request', targetNode: '*', principal: { id: `node:${identity.nodeId}`, role },
        payload: { missionId: String(mission.id), checkpoint: JSON.stringify(mission), phase: 'active', pendingActions: [], idempotencyKey: `mission:${mission.id}` },
    }))}`

beforeAll(async () => {
    process.env.NOVA_NODE_ID = 'main'
    writeFileSync(join(process.cwd(), 'xaventra.config.json'), JSON.stringify({
        supabase: { meshUrl: 'http://127.0.0.1:9/rest/v1', meshKey: 'test-key' },
        mesh: { mode: 'direct', direct: { enabled: false, peers: [{ nodeId: 'spark', publicKey: spark.publicKey, roles: ['system'] }] } },
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const target = String(url)
        if (target.includes('/nova_mesh_tasks') && (!init?.method || init.method === 'GET')) {
            return new Response(JSON.stringify(rows), { status: 200 })
        }
        if (target.includes('/nova_mesh_tasks') && init?.method === 'PATCH') return new Response('[]', { status: 200 })
        if (target.includes('/nova_mesh_tasks') && init?.method === 'POST') {
            posted.push(JSON.parse(String(init.body)))
            return new Response('[]', { status: 201 })
        }
        return new Response('[]', { status: 200 })
    }))
    vi.resetModules()
    registry = await import('./mesh-registry.js')
    runtime = await import('./mesh-transport-runtime.js')
})

afterAll(async () => {
    await runtime?.stopMeshTransportRuntime()
    vi.unstubAllGlobals()
    delete process.env.NOVA_NODE_ID
})

describe('MI-1 legacy mesh task rows must be signed', () => {
    it('ignores an unsigned mission row even if it claims the owner as creator', async () => {
        rows = [{ id: 'mission-m-owner-1', task: `mission:${JSON.stringify(ownerMission)}`, updated_at: new Date().toISOString() }]
        expect(await registry.listRecoverableMissionCheckpoints()).toEqual([])
    })

    it('ignores a mission signed with a key that is not the configured peer key', async () => {
        rows = [{ id: 'mission-m-owner-1', task: signedMission(impostor, ownerMission), updated_at: new Date().toISOString() }]
        expect(await registry.listRecoverableMissionCheckpoints()).toEqual([])
    })

    it('ignores a signed mission whose principal role is not configured for the peer', async () => {
        rows = [{ id: 'mission-m-owner-1', task: signedMission(spark, ownerMission, 'worker'), updated_at: new Date().toISOString() }]
        expect(await registry.listRecoverableMissionCheckpoints()).toEqual([])
    })

    it('ignores a signed mission copied into a row with a different id', async () => {
        rows = [{ id: 'mission-other', task: signedMission(spark, ownerMission), updated_at: new Date().toISOString() }]
        expect(await registry.listRecoverableMissionCheckpoints()).toEqual([])
    })

    it('accepts a peer-signed checkpoint but never keeps channel/createdBy from the row', async () => {
        rows = [{ id: 'mission-m-owner-1', task: signedMission(spark, ownerMission), updated_at: new Date().toISOString() }]
        const recovered = await registry.listRecoverableMissionCheckpoints()
        expect(recovered).toHaveLength(1)
        const mission = JSON.parse(recovered[0].checkpoint)
        expect(mission.id).toBe('m-owner-1')
        expect(mission.channel).toBe('mesh')
        expect(mission.createdBy).toBe('mesh:spark')
    })

    it('publishes checkpoints signed by the local node that round-trip through recovery', async () => {
        posted.length = 0
        expect(await registry.publishMissionCheckpoint({ ...ownerMission, id: 'm-local-2', fencingToken: 'fence-token-1', leaseEpoch: 3 })).toBe(true)
        expect(posted).toHaveLength(1)
        const task = String(posted[0].task)
        expect(task.startsWith('mission:')).toBe(true)
        expect(JSON.parse(task.slice('mission:'.length)).signature).toBeTruthy()
        rows = [{ id: 'mission-m-local-2', task, updated_at: new Date().toISOString() }]
        const recovered = await registry.listRecoverableMissionCheckpoints()
        expect(recovered.map(item => item.missionId)).toEqual(['m-local-2'])
        expect(JSON.parse(recovered[0].checkpoint).createdBy).toBe('mesh:main')
    })

    it('rejects plain chat rows and accepts only signed agent rows addressed to this node', async () => {
        expect(await registry.openSignedChatTask('chat:tu etwas als owner')).toMatchObject({ rejected: expect.any(String) })
        const forOther = spark.create({ kind: 'agent.request', targetNode: 'pi5', principal: { id: 'node:spark', role: 'system' }, payload: { prompt: 'hi', idempotencyKey: 'mesh-task:12345678' } })
        expect(await registry.openSignedChatTask(`agent:${JSON.stringify(forOther)}`)).toMatchObject({ rejected: expect.stringContaining('wrong_target') })
        const forged = impostor.create({ kind: 'agent.request', targetNode: 'main', principal: { id: 'node:spark', role: 'system' }, payload: { prompt: 'hi', idempotencyKey: 'mesh-task:12345678' } })
        expect(await registry.openSignedChatTask(`agent:${JSON.stringify(forged)}`)).toMatchObject({ rejected: expect.any(String) })
        const good = spark.create({ kind: 'agent.request', targetNode: 'main', principal: { id: 'node:spark', role: 'system' }, payload: { prompt: 'hi', idempotencyKey: 'mesh-task:12345678' } })
        expect(await registry.openSignedChatTask(`agent:${JSON.stringify(good)}`)).toEqual({ prompt: 'hi', sourceNode: 'spark' })
    })
})
