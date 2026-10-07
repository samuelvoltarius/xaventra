import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, cardKeyboard, listApprovalCards, type ApprovalCard, type CardStoreOptions } from '../core/approval-cards.js'
import { getCommandMinimumRole } from '../core/slash-commands.js'
import * as command from './kubernetes-command.js'
import { handleClusterCommand, proposeChartUpdate, registerKubernetesCardExecutors, startClusterControl, type ClusterDeps } from './kubernetes-command.js'
import { KubernetesClient, parseControlPolicy, type KubernetesRuntime } from './kubernetes.js'
import { NS, RELEASE, controlPolicyRaw, createFakeKube } from '../../test/helpers/fake-kube.js'
import type { NodeProfile } from '../core/node-profile.js'

// P19/P21: /cluster and the Knopf-Karten against DaemonSet workers. Only a
// fake API server. No scaling, no autoscaler: adding or removing worker nodes
// is the owner's job (node labels), /cluster only explains it.

const OWNER = '111'
const NOW = Date.parse('2026-10-07T12:00:00Z')
let fake: ReturnType<typeof createFakeKube>
let opts: CardStoreOptions
let deps: ClusterDeps

function runtime(): KubernetesRuntime {
    const policy = parseControlPolicy(controlPolicyRaw())!
    return { ok: true, policy, server: 'https://192.0.2.1:6443', client: new KubernetesClient({ policy, transport: fake.transport, now: () => NOW }) }
}
const press = (card: ApprovalCard, answer: string) => answerApprovalCard(`ac:${card.buttons.find(b => b.answer === answer)!.token}`, { userId: OWNER, ownerIds: [OWNER] }, opts)

beforeEach(() => {
    fake = createFakeKube({ workerNodes: ['node-a', 'node-b'] })
    const dataDir = mkdtempSync(join(tmpdir(), 'k8s-cards-'))
    opts = { dataDir, now: () => NOW, ledger: null }
    deps = { runtime: async () => runtime(), cardOpts: opts, nodeOnly: false, now: () => NOW, fence: async () => ({ ok: true, reason: 'test' }) }
    registerKubernetesCardExecutors(deps, { force: true })
})

describe('/cluster lesen', () => {
    it('is owner-only and shows own DaemonSets per labelled node, pods with node and warnings', async () => {
        expect(getCommandMinimumRole('cluster')).toBe('owner')
        const text = await handleClusterCommand('', deps)
        expect(text).toContain(`Namespace ${NS}`)
        expect(text).toMatch(/worker-general\* \(DaemonSet\) — 2\/2 bereit, je Knoten mit xaventra\.ai\/worker=true/)
        expect(text).toMatch(/voice.*0\/0 bereit[\s\S]*noch kein Knoten freigegeben/)
        expect(text).toMatch(/Knoten node-b/)
        expect(text).toContain('BackOff')
        expect(text).not.toContain('fremd')
        expect(fake.writes()).toEqual([])
    })

    it('is off without cluster access and sends nothing', async () => {
        const off: ClusterDeps = { ...deps, runtime: async () => ({ ok: false, reason: 'nicht im Cluster und infra.kubernetes.server fehlt' }) }
        expect(await handleClusterCommand('', off)).toContain('Kubernetes-Steuerung ist aus')
        expect(fake.calls).toEqual([])
    })

    it('workers do nothing (only the Main talks to the owner and the cluster)', async () => {
        const worker = { ...deps, nodeOnly: true }
        expect(await handleClusterCommand('', worker)).toMatch(/nur am Main/)
        expect(await handleClusterCommand('neustart worker-general', worker)).toMatch(/nur am Main/)
        expect(await startClusterControl(worker)).toMatchObject({ started: false })
        expect(fake.calls).toEqual([])
    })

    it('logs only of own pods; foreign pod refused before any log request', async () => {
        expect(await handleClusterCommand(`logs ${RELEASE}-worker-general-nodea 20`, deps)).toContain('Zeile 3')
        const before = fake.calls.length
        expect(await handleClusterCommand('logs fremd-agent-nodea', deps)).toMatch(/nicht aus diesem Release/)
        expect(fake.calls.slice(before).every(call => !call.path.includes('/log'))).toBe(true)
    })

    it('never words: exec, secrets, kubectl, labels setzen, foreign namespaces, delete — no request', async () => {
        for (const args of ['exec xv-main-0 sh', 'secrets', 'secret xv-env', 'kubectl get pods', 'namespace fremd', 'loeschen worker-general', 'delete pvc', 'label node-a xaventra.ai/worker=true', 'cordon node-a']) {
            expect(await handleClusterCommand(args, deps), args).toMatch(/macht Xaventra im Cluster nie/)
        }
        expect(fake.calls).toEqual([])
    })
})

describe('Kein Skalieren, keine Auto-Skalierung', () => {
    it('skalieren/abschalten only explain the node labels — no API call, no card', async () => {
        for (const args of ['skalieren worker-general 3', 'scale worker-general 1', 'abschalten voice']) {
            const reply = await handleClusterCommand(args, deps)
            expect(reply, args).toMatch(/DaemonSet.*xaventra\.ai\/worker=true/s)
            expect(reply, args).toMatch(/macht der Owner/)
        }
        expect(await handleClusterCommand('abschalten voice', deps)).toMatch(/workers\.<name>\.enabled=false/)
        expect(fake.writes()).toEqual([])
        expect(listApprovalCards(opts)).toEqual([])
    })

    it('the autoscaler is gone; the daemon hook only registers the card executors', async () => {
        expect((command as any).ClusterAutoscaler).toBeUndefined()
        expect((command as any).decideWorkerScale).toBeUndefined()
        const result = await startClusterControl(deps)
        expect(result).toMatchObject({ started: true })
        expect(result.reason).toMatch(/keine Auto-Skalierung/)
        expect(fake.writes()).toEqual([])
    })
})

describe('Neustart', () => {
    it('needs the Main lease (fence) for every write', async () => {
        const unfenced = { ...deps, fence: async () => ({ ok: false, reason: 'no lease' }) }
        expect(await handleClusterCommand('neustart worker-general', unfenced)).toMatch(/Main-Lease/)
        expect(fake.writes()).toEqual([])
    })

    it('restarts an own worker DaemonSet directly; Main and optional workloads only via card and Ja', async () => {
        expect(await handleClusterCommand('neustart worker-general', deps)).toContain('Neustart angestoßen')
        expect(fake.workload(`${RELEASE}-worker-general`).restartedAt).toBeTruthy()
        expect(listApprovalCards(opts)).toEqual([])
        const reply = await handleClusterCommand('neustart main', deps)
        expect(reply).toContain('Karte erstellt')
        const writes = fake.writes().length
        const [card] = listApprovalCards({ ...opts, status: 'offen' })
        expect(card).toMatchObject({ art: 'kubernetes', wirkung: 'infra', aktion: { kind: 'k8s-neustart', ref: 'main' } })
        expect(cardKeyboard(card).flat().map(b => b.text)).not.toContain('♾️ Immer erlauben')
        expect(fake.writes().length).toBe(writes)
        expect((await press(card, 'ja')).ok).toBe(true)
        expect(fake.workload(`${RELEASE}-main`).restartedAt).toBeTruthy()
    })
})

describe('Chart-Update per Karte', () => {
    it('creates a card with the diff preview; nothing is written before Ja', async () => {
        const reply = await handleClusterCommand('update worker-general.resources.limits.memory=6Gi', deps)
        expect(reply).toContain('Karte erstellt')
        expect(fake.writes()).toEqual([])
        const [card] = listApprovalCards({ ...opts, status: 'offen' })
        expect(card).toMatchObject({ art: 'kubernetes', wirkung: 'infra', aktion: { kind: 'k8s-chart-update' } })
        expect(card.beleg).toContain('worker-general: resources.limits.memory 4Gi → 6Gi')
        expect((await press(card, 'ja')).ok).toBe(true)
        expect(fake.workload(`${RELEASE}-worker-general`).resources.limits.memory).toBe('6Gi')
    })

    it('Nein sends nothing', async () => {
        await handleClusterCommand('update image.tag=2.88.1', deps)
        const [card] = listApprovalCards({ ...opts, status: 'offen' })
        const result = await press(card, 'nein')
        expect(result.message).toMatch(/nichts/)
        expect(fake.writes()).toEqual([])
    })

    it('refuses non-whitelisted values and replica fields without a card', async () => {
        for (const args of ['update secrets.existingSecret=x', 'update main.enabled=false', 'update rbac.create=true', 'update worker-general.max=6', 'update workerNodes.label=x']) {
            const reply = await handleClusterCommand(args, deps)
            expect(reply, args).toMatch(/❌/)
        }
        expect(listApprovalCards(opts)).toEqual([])
        expect(fake.writes()).toEqual([])
    })

    it('a card whose plan went stale changes nothing', async () => {
        const proposed = await proposeChartUpdate('worker-general.resources.limits.memory=6Gi', deps)
        fake.workload(`${RELEASE}-worker-general`).resources = { limits: { memory: '3Gi' } }
        const writes = fake.writes().length
        const result = await press(proposed.card!, 'ja')
        expect(result.message).toMatch(/geändert/)
        expect(fake.writes().length).toBe(writes)
    })
})

describe('/cluster labels (nur Vorschlag)', () => {
    it('suggests xaventra.ai labels from node profiles and never runs kubectl', async () => {
        const profile = { schema: 1, nodeId: 'gpu-box', hostname: 'h', platform: 'linux', arch: 'x64', version: '2.88.0', role: 'worker', runtime: 'native',
            rootReadOnly: false, noNewPrivileges: false, cpus: 16, ramGB: 64, gpu: { name: 'NVIDIA RTX 4090', backend: 'cuda', viaVllm: false },
            installPath: 'package-manager', tools: [], selfCheck: { status: 'ok', checkedAt: '', items: [] }, collectedAt: '' } as NodeProfile
        const text = await handleClusterCommand('labels', { ...deps, profiles: async () => [{ nodeId: 'gpu-box', profile }] })
        expect(text).toContain('xaventra.ai/gpu=true')
        expect(text).toContain('xaventra.ai/gpu-class=nvidia')
        expect(text).not.toMatch(/kubectl/)
        expect(fake.writes()).toEqual([])
    })
})
