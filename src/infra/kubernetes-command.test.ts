import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, cardKeyboard, listApprovalCards, type ApprovalCard, type CardStoreOptions } from '../core/approval-cards.js'
import { getCommandMinimumRole } from '../core/slash-commands.js'
import {
    ClusterAutoscaler, decideWorkerScale, handleClusterCommand, proposeChartUpdate, registerKubernetesCardExecutors, type ClusterDeps,
} from './kubernetes-command.js'
import { KubernetesClient, parseControlPolicy, type KubernetesRuntime } from './kubernetes.js'
import { NS, RELEASE, controlPolicyRaw, createFakeKube } from '../../test/helpers/fake-kube.js'
import type { NodeProfile } from '../core/node-profile.js'

// P19: /cluster, Knopf-Karten and the worker autoscaler. Only a fake API server.

const OWNER = '111'
const NOW = Date.parse('2026-10-07T12:00:00Z')
let fake: ReturnType<typeof createFakeKube>
let opts: CardStoreOptions
let deps: ClusterDeps

function runtime(): KubernetesRuntime {
    const policy = parseControlPolicy(controlPolicyRaw())!
    return { ok: true, policy, server: 'https://192.0.2.1:443', client: new KubernetesClient({ policy, transport: fake.transport, now: () => NOW }) }
}
const press = (card: ApprovalCard, answer: string) => answerApprovalCard(`ac:${card.buttons.find(b => b.answer === answer)!.token}`, { userId: OWNER, ownerIds: [OWNER] }, opts)

beforeEach(() => {
    fake = createFakeKube()
    const dataDir = mkdtempSync(join(tmpdir(), 'k8s-cards-'))
    opts = { dataDir, now: () => NOW, ledger: null }
    deps = { runtime: async () => runtime(), cardOpts: opts, nodeOnly: false, now: () => NOW, fence: async () => ({ ok: true, reason: 'test' }) }
    registerKubernetesCardExecutors(deps, { force: true })
})

describe('/cluster lesen', () => {
    it('is owner-only and shows own workloads, pods and warnings', async () => {
        expect(getCommandMinimumRole('cluster')).toBe('owner')
        const text = await handleClusterCommand('', deps)
        expect(text).toContain(`Namespace ${NS}`)
        expect(text).toMatch(/worker-general.*1\/1 bereit.*1–4/)
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
        expect(await handleClusterCommand('skalieren worker-general 2', worker)).toMatch(/nur am Main/)
        expect(fake.calls).toEqual([])
    })

    it('logs only of own pods; foreign pod refused before any log request', async () => {
        expect(await handleClusterCommand(`logs ${RELEASE}-main-0 20`, deps)).toContain('Zeile 3')
        const before = fake.calls.length
        expect(await handleClusterCommand('logs fremd-app-1', deps)).toMatch(/nicht aus diesem Release/)
        expect(fake.calls.slice(before).every(call => !call.path.includes('/log'))).toBe(true)
    })

    it('never words: exec, secrets, kubectl, foreign namespaces, delete — no request', async () => {
        for (const args of ['exec xv-main-0 sh', 'secrets', 'secret xv-env', 'kubectl get pods', 'namespace fremd', 'loeschen worker-general', 'delete pvc']) {
            expect(await handleClusterCommand(args, deps), args).toMatch(/macht Xaventra im Cluster nie/)
        }
        expect(fake.calls).toEqual([])
    })
})

describe('Skalieren und Neustart', () => {
    it('scales own workers within min/max without a card', async () => {
        expect(await handleClusterCommand('skalieren worker-general 3', deps)).toContain('auf 3 Replikas')
        expect(fake.workload(`${RELEASE}-worker-general`).replicas).toBe(3)
        expect(listApprovalCards(opts)).toEqual([])
        expect(await handleClusterCommand('skalieren worker-general 9', deps)).toMatch(/1–4/)
        expect(await handleClusterCommand('skalieren main 2', deps)).toMatch(/nie über Kubernetes skaliert/)
    })

    it('needs the Main lease (fence) for every write', async () => {
        const unfenced = { ...deps, fence: async () => ({ ok: false, reason: 'no lease' }) }
        expect(await handleClusterCommand('skalieren worker-general 2', unfenced)).toMatch(/Main-Lease/)
        expect(fake.writes()).toEqual([])
    })

    it('restarts an own worker directly; the Main only via card and Ja', async () => {
        expect(await handleClusterCommand('neustart worker-general', deps)).toContain('Neustart angestoßen')
        expect(listApprovalCards(opts)).toEqual([])
        const reply = await handleClusterCommand('neustart main', deps)
        expect(reply).toContain('Karte erstellt')
        const writes = fake.writes().length
        const [card] = listApprovalCards({ ...opts, status: 'offen' })
        expect(card).toMatchObject({ art: 'kubernetes', wirkung: 'infra', aktion: { kind: 'k8s-neustart', ref: 'main' } })
        expect(cardKeyboard(card).flat().map(b => b.text)).not.toContain('♾️ Immer erlauben')
        expect(fake.writes().length).toBe(writes)
        const result = await press(card, 'ja')
        expect(result.ok).toBe(true)
        expect(fake.workload(`${RELEASE}-main`).restartedAt).toBeTruthy()
    })
})

describe('Chart-Update per Karte', () => {
    it('creates a card with the diff preview; nothing is written before Ja', async () => {
        const reply = await handleClusterCommand('update worker-general.resources.limits.memory=4Gi worker-general.max=6', deps)
        expect(reply).toContain('Karte erstellt')
        expect(fake.writes()).toEqual([])
        const [card] = listApprovalCards({ ...opts, status: 'offen' })
        expect(card).toMatchObject({ art: 'kubernetes', wirkung: 'infra', aktion: { kind: 'k8s-chart-update' } })
        expect(card.beleg).toContain('worker-general: resources.limits.memory 2Gi → 4Gi')
        expect(card.beleg).toContain('worker-general: max 4 → 6')
        expect((await press(card, 'ja')).ok).toBe(true)
        expect(fake.workload(`${RELEASE}-worker-general`).resources.limits.memory).toBe('4Gi')
        expect(fake.control().workloads['worker-general'].max).toBe(6)
    })

    it('Nein sends nothing', async () => {
        await handleClusterCommand('update image.tag=2.88.1', deps)
        const [card] = listApprovalCards({ ...opts, status: 'offen' })
        const result = await press(card, 'nein')
        expect(result.message).toMatch(/nichts/)
        expect(fake.writes()).toEqual([])
    })

    it('switching a workload off is a removal card (ENTFERNT), never direct', async () => {
        const reply = await handleClusterCommand('abschalten voice', deps)
        expect(reply).toContain('Karte erstellt')
        const [card] = listApprovalCards({ ...opts, status: 'offen' })
        expect(card.titel).toMatch(/entfernt/i)
        expect(card.beleg).toContain('ENTFERNT')
        expect(fake.writes()).toEqual([])
        await press(card, 'ja')
        expect(fake.workload(`${RELEASE}-voice`).replicas).toBe(0)
    })

    it('refuses non-whitelisted values without a card', async () => {
        for (const args of ['update secrets.existingSecret=x', 'update main.enabled=false', 'update rbac.create=true', 'abschalten main']) {
            const reply = await handleClusterCommand(args, deps)
            expect(reply, args).toMatch(/❌/)
        }
        expect(listApprovalCards(opts)).toEqual([])
        expect(fake.writes()).toEqual([])
    })

    it('a card whose plan went stale changes nothing', async () => {
        const proposed = await proposeChartUpdate('worker-general.resources.limits.memory=4Gi', deps)
        fake.workload(`${RELEASE}-worker-general`).resources = { limits: { memory: '3Gi' } }
        const writes = fake.writes().length
        const result = await press(proposed.card!, 'ja')
        expect(result.message).toMatch(/geändert/)
        expect(fake.writes().length).toBe(writes)
    })
})

describe('Auto-Skalierung', () => {
    const base = { replicas: 1, min: 1, max: 4, tasksPerWorker: 4, now: NOW, lastChangeAt: 0, cooldownMs: 300_000, idleSince: null as number | null, idleMs: 900_000 }

    it('scales up with many open tasks, bounded by max', () => {
        expect(decideWorkerScale({ ...base, openTasks: 9 })).toMatchObject({ target: 3 })
        expect(decideWorkerScale({ ...base, openTasks: 100 })).toMatchObject({ target: 4 })
        expect(decideWorkerScale({ ...base, openTasks: 3 })).toBeNull()
    })

    it('waits for the cooldown and steps down by one only after idling', () => {
        expect(decideWorkerScale({ ...base, openTasks: 9, lastChangeAt: NOW - 60_000 })).toBeNull()
        expect(decideWorkerScale({ ...base, replicas: 3, openTasks: 0, idleSince: NOW - 600_000 })).toBeNull()
        expect(decideWorkerScale({ ...base, replicas: 3, openTasks: 0, idleSince: NOW - 1_000_000 })).toMatchObject({ target: 2 })
        expect(decideWorkerScale({ ...base, replicas: 1, openTasks: 0, idleSince: NOW - 9_000_000 })).toBeNull()
        // Outside the bounds (e.g. after a chart update) it returns into them at once.
        expect(decideWorkerScale({ ...base, replicas: 6, openTasks: 0, lastChangeAt: NOW })).toMatchObject({ target: 4 })
        expect(decideWorkerScale({ ...base, replicas: 0, openTasks: 0, lastChangeAt: NOW })).toMatchObject({ target: 1 })
    })

    it('ticks: up on load, nothing during cooldown, down after idle; only with the Main lease', async () => {
        let open = 10
        let clock = NOW
        const scaler = new ClusterAutoscaler({ ...deps, now: () => clock, openTasks: () => open })
        await scaler.tick()
        expect(fake.workload(`${RELEASE}-worker-general`).replicas).toBe(3)
        open = 30; clock += 60_000
        await scaler.tick()
        expect(fake.workload(`${RELEASE}-worker-general`).replicas).toBe(3)   // cooldown
        open = 0; clock += 600_000
        await scaler.tick()                                                     // idle starts
        clock += 16 * 60_000
        await scaler.tick()
        expect(fake.workload(`${RELEASE}-worker-general`).replicas).toBe(2)
        // voice has autoscale=false: never touched.
        expect(fake.writes().every(call => call.path.includes('worker-general'))).toBe(true)

        const blind = new ClusterAutoscaler({ ...deps, openTasks: () => 50, fence: async () => ({ ok: false, reason: 'no lease' }) })
        const writes = fake.writes().length
        await blind.tick()
        expect(fake.writes().length).toBe(writes)
        const onWorker = new ClusterAutoscaler({ ...deps, nodeOnly: true, openTasks: () => 50 })
        await onWorker.tick()
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
