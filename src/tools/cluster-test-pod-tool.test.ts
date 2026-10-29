import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_NS, controlPolicyRaw, createFakeKube } from '../../test/helpers/fake-kube.js'

// 2.89.15: cluster_test_pod — creating a pod in xaventra-test needs the owner's
// one-time code for exactly this pod; without it nothing reaches the cluster.
const refusal = vi.fn()
vi.mock('./owner-approval.js', async (original) => ({ ...(await original<any>()), ownerApprovalRefusal: (...args: unknown[]) => refusal(...args) }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => ({ authUserId: '111', channel: 'telegram' }) }))
const permission = vi.fn(() => 'owner')
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => permission() }))
vi.mock('../mesh/fence.js', () => ({ assertFenced: async () => ({ ok: true, reason: 'test' }) }))
let fake: ReturnType<typeof createFakeKube>
vi.mock('../infra/kubernetes.js', async (original) => {
    const mod = await original<any>()
    return {
        ...mod,
        readKubernetesRawConfig: () => ({}),
        loadKubernetesRuntime: async () => {
            const policy = mod.parseControlPolicy(controlPolicyRaw())
            return { ok: true, policy, server: 'https://192.0.2.1:6443', client: new mod.KubernetesClient({ policy, transport: fake.transport }) }
        },
    }
})

const tool = async () => (await import('./cluster-tools.js')).clusterTestPodTool
const create = { aktion: 'anlegen', name: 'xvt-probe', image: 'docker.io/library/busybox:1.36', kommando: '["sh","-c","echo ok"]' }

describe('cluster_test_pod', () => {
    beforeEach(() => { fake = createFakeKube(); refusal.mockReset(); permission.mockReturnValue('owner'); process.env.NOVA_NODE_ONLY = 'false' })

    it('offers confirm and asks the approval for exactly this pod; without it nothing is sent', async () => {
        refusal.mockResolvedValue('❌ cluster_test_pod braucht eine ausdrückliche Freigabe')
        const t = await tool()
        expect(t.parameters.map(p => p.name)).toContain('confirm')
        const result: any = await t.handler({ ...create })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/Freigabe/)
        expect(result.error).toContain('busybox:1.36')
        expect(refusal).toHaveBeenCalledWith(expect.any(Object), 'cluster_test_pod', expect.stringMatching(/^#[a-f0-9]{12}$/))
        expect(fake.writes()).toEqual([])
    })

    it('with the approval: the pod is created in xaventra-test with the JSON command', async () => {
        refusal.mockResolvedValue(null)
        const result: any = await (await tool()).handler({ ...create, confirm: '123456' })
        expect(result.success, result.error).toBe(true)
        expect(fake.writes()).toHaveLength(1)
        expect(fake.testPods.get('xvt-probe').spec.containers[0].command).toEqual(['sh', '-c', 'echo ok'])
        expect(fake.writes()[0].path).toBe(`/api/v1/namespaces/${TEST_NS}/pods`)
    })

    it('list and delete need no code, delete only own pods', async () => {
        refusal.mockResolvedValue(null)
        const t = await tool()
        await t.handler({ ...create })
        expect(((await t.handler({ aktion: 'liste' })) as any).message).toContain('xvt-probe')
        expect(((await t.handler({ aktion: 'loeschen', name: 'fremd-debug' })) as any).success).toBe(false)
        expect(((await t.handler({ aktion: 'loeschen', name: 'xvt-probe' })) as any).success).toBe(true)
        expect(refusal).toHaveBeenCalledTimes(1)
    })

    it('only the owner', async () => {
        permission.mockReturnValue('user')
        await expect((await tool()).handler({ aktion: 'liste' })).rejects.toThrow(/Owner/)
        expect(fake.calls).toEqual([])
    })
})
