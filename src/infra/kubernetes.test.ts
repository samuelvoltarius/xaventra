import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    KUBERNETES_NEVER, KubernetesClient, checkKubeRequest, createKubeTransport, kubernetesControlConfigured, loadKubernetesRuntime, parseChartChanges, parseControlPolicy,
} from './kubernetes.js'
import { IMAGE, NS, RELEASE, controlPolicyRaw, createFakeKube } from '../../test/helpers/fake-kube.js'
import { selfSignedCert } from '../../test/helpers/fake-pve.js'
import { neverListViolation } from '../install/never-list.js'

// P19/P21: Kubernetes adapter. A narrow, fixed set of actions against the API
// of the OWN namespace — never raw kubectl, never secrets, never exec, never
// scaling (workers are DaemonSets). Only a fake API server; no cluster, no real
// address, no real token.

const policy = () => parseControlPolicy(controlPolicyRaw())!
function client(fake = createFakeKube()) {
    return { fake, client: new KubernetesClient({ policy: policy(), transport: fake.transport, now: () => Date.parse('2026-10-07T12:00:00Z') }) }
}

describe('Steuerdatei aus dem Chart', () => {
    it('parses the chart-rendered control policy: workers are DaemonSets, a Main only a StatefulSet', () => {
        const parsed = policy()
        expect(parsed).toMatchObject({ namespace: NS, release: RELEASE, controlConfigMap: `${RELEASE}-control`, workerNodeLabel: 'xaventra.ai/worker' })
        expect(parsed.workloads['worker-general']).toEqual({ name: 'worker-general', kind: 'DaemonSet', object: `${RELEASE}-worker-general`, container: 'xaventra', role: 'worker' })
        expect(parseControlPolicy({ ...controlPolicyRaw(), namespace: 'Bad NS' })).toBeNull()
        expect(parseControlPolicy({ ...controlPolicyRaw(), schema: 1 })).toBeNull()
        const weird = parseControlPolicy(controlPolicyRaw({ workloads: {
            a: { kind: 'Deployment', object: 'xv-a', role: 'worker' },          // Deployments are gone
            b: { kind: 'DaemonSet', object: 'xv-b', role: 'main' },             // a Main is never a DaemonSet
            c: { kind: 'StatefulSet', object: 'xv-c', role: 'worker' },         // a worker is never a StatefulSet
            d: { kind: 'DaemonSet', object: 'Bad Name', role: 'worker' },
            e: { kind: 'DaemonSet', object: 'xv-e', role: 'optional' },
        } }))!
        expect(Object.keys(weird.workloads)).toEqual(['e'])
    })
})

describe('Anfrage-Wächter (vor jedem Request)', () => {
    const p = () => policy()
    it('allows only the fixed read/patch routes in the own namespace', () => {
        expect(checkKubeRequest({ method: 'GET', path: `/api/v1/namespaces/${NS}/pods?labelSelector=app.kubernetes.io%2Finstance%3Dxv` }, p())).toBeNull()
        expect(checkKubeRequest({ method: 'GET', path: `/api/v1/namespaces/${NS}/pods/xv-main-0/log?tailLines=100&container=xaventra` }, p())).toBeNull()
        expect(checkKubeRequest({ method: 'GET', path: `/apis/apps/v1/namespaces/${NS}/daemonsets` }, p())).toBeNull()
        expect(checkKubeRequest({ method: 'PATCH', path: `/apis/apps/v1/namespaces/${NS}/daemonsets/xv-worker-general`, body: {} }, p())).toBeNull()
        expect(checkKubeRequest({ method: 'PATCH', path: `/apis/apps/v1/namespaces/${NS}/statefulsets/xv-main`, body: {} }, p())).toBeNull()
        expect(checkKubeRequest({ method: 'GET', path: `/api/v1/namespaces/${NS}/configmaps/xv-control` }, p())).toBeNull()
    })

    it.each([
        ['fremder Namespace', 'GET', '/api/v1/namespaces/fremd/pods'],
        ['fremder Namespace (apps)', 'PATCH', '/apis/apps/v1/namespaces/kube-system/daemonsets/coredns'],
        ['Secrets lesen', 'GET', `/api/v1/namespaces/${NS}/secrets`],
        ['Secret einzeln', 'GET', `/api/v1/namespaces/${NS}/secrets/xv-env`],
        ['exec', 'GET', `/api/v1/namespaces/${NS}/pods/xv-main-0/exec?command=sh`],
        ['exec per POST', 'POST', `/api/v1/namespaces/${NS}/pods/xv-worker-general-nodea/exec`],
        ['attach', 'GET', `/api/v1/namespaces/${NS}/pods/xv-main-0/attach`],
        ['portforward', 'GET', `/api/v1/namespaces/${NS}/pods/xv-main-0/portforward`],
        ['proxy', 'GET', `/api/v1/namespaces/${NS}/pods/xv-main-0/proxy/`],
        ['Cluster-weit: Nodes', 'GET', '/api/v1/nodes'],
        ['Node-Label setzen', 'PATCH', '/api/v1/nodes/node-a'],
        ['Namespace anlegen', 'POST', '/api/v1/namespaces'],
        ['DaemonSet löschen', 'DELETE', `/apis/apps/v1/namespaces/${NS}/daemonsets/xv-worker-general`],
        ['DaemonSet anlegen', 'POST', `/apis/apps/v1/namespaces/${NS}/daemonsets`],
        ['Pod löschen', 'DELETE', `/api/v1/namespaces/${NS}/pods/xv-main-0`],
        ['Skalieren (scale)', 'PATCH', `/apis/apps/v1/namespaces/${NS}/statefulsets/xv-main/scale`],
        ['Deployment (gibt es nicht mehr)', 'GET', `/apis/apps/v1/namespaces/${NS}/deployments`],
        ['Leases', 'GET', `/apis/coordination.k8s.io/v1/namespaces/${NS}/leases`],
        ['PVC', 'GET', `/api/v1/namespaces/${NS}/persistentvolumeclaims`],
        ['RBAC', 'PATCH', `/apis/rbac.authorization.k8s.io/v1/namespaces/${NS}/roles/xv`],
        ['Steuer-ConfigMap ändern', 'PATCH', `/api/v1/namespaces/${NS}/configmaps/xv-control`],
        ['fremde ConfigMap', 'GET', `/api/v1/namespaces/${NS}/configmaps/kube-root-ca.crt`],
        ['Pfad-Trick', 'GET', `/api/v1/namespaces/${NS}/pods/../../fremd/pods`],
        ['kodierter Pfad-Trick', 'GET', `/api/v1/namespaces/${NS}/pods/%2e%2e/secrets`],
        ['fremdes DaemonSet patchen', 'PATCH', `/apis/apps/v1/namespaces/${NS}/daemonsets/fremd-agent`],
        ['Art vertauscht', 'PATCH', `/apis/apps/v1/namespaces/${NS}/statefulsets/xv-worker-general`],
        ['Token anfordern', 'POST', `/api/v1/namespaces/${NS}/serviceaccounts/xv/token`],
    ])('refuses %s', (_label, method, path) => {
        expect(checkKubeRequest({ method: method as any, path, body: {} }, p())).toMatch(/.+/)
    })

    it('a refused request never reaches the API server', async () => {
        const { fake, client: c } = client()
        await expect(c.request({ method: 'GET', path: `/api/v1/namespaces/${NS}/secrets` })).rejects.toThrow(/Secret/)
        await expect(c.request({ method: 'GET', path: `/api/v1/namespaces/${NS}/pods/xv-main-0/exec?command=sh` })).rejects.toThrow(/exec/)
        await expect(c.request({ method: 'GET', path: '/api/v1/namespaces/fremd/pods' })).rejects.toThrow(/Namespace/)
        await expect(c.request({ method: 'PATCH', path: '/api/v1/nodes/node-a', body: {} })).rejects.toThrow(/cluster-weit/)
        expect(fake.calls).toEqual([])
    })

    it('kubectl stays on the Nie-Liste; the adapter documents its own never list', () => {
        expect(neverListViolation(['kubectl', 'get', 'pods'])?.ruleId).toBe('containers-database')
        const never = KUBERNETES_NEVER.join(' ')
        for (const word of [/Secret/, /exec/, /fremde Namespaces/, /skalieren/, /Labels/]) expect(never).toMatch(word)
    })
})

describe('Lesen: Status, Events, Logs', () => {
    it('shows own DaemonSets (one pod per labelled node) and pods, never the foreign namespace', async () => {
        const { fake, client: c } = client(createFakeKube({ workerNodes: ['node-a', 'node-b'] }))
        const status = await c.status()
        expect(status.workloads.map(w => w.name)).toEqual(['main', 'worker-general', 'voice'])
        expect(status.workloads.find(w => w.name === 'worker-general')).toMatchObject({ kind: 'DaemonSet', desired: 2, ready: 2, updated: 2, image: IMAGE, found: true })
        expect(status.workloads.find(w => w.name === 'voice')).toMatchObject({ desired: 0, ready: 0 })
        expect(status.pods.filter(p => p.workload === 'worker-general').map(p => p.node)).toEqual(['node-a', 'node-b'])
        expect(JSON.stringify(status)).not.toContain('fremd')
        expect(fake.calls.every(call => call.method === 'GET' && call.path.includes(`/namespaces/${NS}/`))).toBe(true)
    })

    it('without a Main in the policy, no StatefulSet request is made', async () => {
        const fake = createFakeKube()
        const raw = controlPolicyRaw()
        delete (raw.workloads as any).main
        const c = new KubernetesClient({ policy: parseControlPolicy(raw)!, transport: fake.transport })
        expect((await c.status()).workloads.map(w => w.name)).toEqual(['worker-general', 'voice'])
        expect(fake.calls.some(call => call.path.includes('statefulsets'))).toBe(false)
    })

    it('lists warning events first and bounded', async () => {
        const { client: c } = client()
        const events = await c.events(5)
        expect(events[0]).toMatchObject({ type: 'Warning', reason: 'BackOff', object: `Pod/${RELEASE}-worker-general-nodea` })
    })

    it('reads logs only of own pods, bounded and redacted', async () => {
        const { fake, client: c } = client()
        const text = await c.logs(`${RELEASE}-worker-general-nodea`, 5000)
        expect(text).not.toMatch(/sk-test-x{20}/)
        expect(text).toContain('Zeile 3')
        expect(fake.calls.at(-1)!.path).toMatch(/tailLines=500/)
        await expect(c.logs('fremd-agent-nodea')).rejects.toThrow(/nicht aus diesem Release/)
    })
})

describe('Schreiben: nur Rollout-Neustart, kein Skalieren', () => {
    it('restarts an own worker DaemonSet via rollout annotation without a card', async () => {
        const { fake, client: c } = client()
        expect(await c.restartWorkload('worker-general')).toMatchObject({ ok: true, requested: true })
        expect(fake.workload(`${RELEASE}-worker-general`).restartedAt).toBe('2026-10-07T12:00:00.000Z')
        expect(fake.writes()).toEqual([{
            method: 'PATCH', path: `/apis/apps/v1/namespaces/${NS}/daemonsets/${RELEASE}-worker-general`, contentType: 'application/strategic-merge-patch+json',
            body: { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': '2026-10-07T12:00:00.000Z' } } } } },
        }])
    })

    it('main and optional workloads only with an approved card; unknown names refused before any request', async () => {
        const { fake, client: c } = client()
        expect(await c.restartWorkload('main')).toMatchObject({ ok: false, requested: false, needsCard: true })
        expect(await c.restartWorkload('voice')).toMatchObject({ ok: false, requested: false, needsCard: true })
        expect(await c.restartWorkload('fremd-agent')).toMatchObject({ ok: false, requested: false })
        expect(fake.calls).toEqual([])
        expect(await c.restartWorkload('main', { approved: true })).toMatchObject({ ok: true, requested: true })
        expect(fake.writes().at(-1)!.path).toBe(`/apis/apps/v1/namespaces/${NS}/statefulsets/${RELEASE}-main`)
    })

    it('the client has no scaling method at all', () => {
        const { client: c } = client()
        expect((c as any).scaleWorker).toBeUndefined()
    })
})

describe('Chart-Update: Diff-Vorschau, dann Karte', () => {
    it('parses only image tag and resources; replicas/min/max/enabled explained, not accepted', () => {
        expect(parseChartChanges('image.tag=2.88.1 worker-general.resources.limits.memory=6Gi')).toEqual([
            { path: 'image.tag', value: '2.88.1' },
            { path: 'worker-general.resources.limits.memory', value: '6Gi' },
        ])
        for (const bad of ['worker-general.max=6', 'worker-general.min=0', 'voice.enabled=false', 'worker-general.replicas=3']) {
            expect(parseChartChanges(bad), bad).toMatch(/DaemonSets/)
        }
        for (const bad of ['secrets.existingSecret=x', 'rbac.create=false', 'main.securityContext.runAsUser=0', 'image.repository=evil/img', 'worker-general.resources.limits.memory=4G; rm', 'image.tag=../x', 'networkPolicy.enabled=false', 'workerNodes.label=x']) {
            expect(typeof parseChartChanges(bad), bad).toBe('string')
        }
    })

    it('previews old → new from the live cluster; nothing is written', async () => {
        const { fake, client: c } = client()
        const plan = await c.planChartUpdate(parseChartChanges('image.tag=2.88.1 worker-general.resources.limits.memory=6Gi') as any)
        if (!('lines' in plan)) throw new Error(plan.message)
        expect(plan.lines).toEqual(expect.arrayContaining([
            `worker-general: Image ${IMAGE} → ghcr.io/example/xaventra:2.88.1`,
            'worker-general: resources.limits.memory 4Gi → 6Gi',
        ]))
        expect(fake.writes()).toEqual([])
        expect(await c.planChartUpdate(parseChartChanges('worker-general.resources.limits.memory=4Gi') as any)).toMatchObject({ ok: false })
    })

    it('applies a fresh plan to the DaemonSet template; refuses when the cluster changed since the preview', async () => {
        const { fake, client: c } = client()
        const plan = await c.planChartUpdate(parseChartChanges('worker-general.resources.limits.memory=6Gi') as any)
        if (!('lines' in plan)) throw new Error(plan.message)
        expect(await c.applyChartUpdate(plan)).toMatchObject({ ok: true })
        expect(fake.workload(`${RELEASE}-worker-general`).resources.limits.memory).toBe('6Gi')
        expect(fake.writes().map(w => w.path)).toEqual([`/apis/apps/v1/namespaces/${NS}/daemonsets/${RELEASE}-worker-general`])
        const writes = fake.writes().length
        expect(await c.applyChartUpdate(plan)).toMatchObject({ ok: false, requested: false })
        expect(fake.writes().length).toBe(writes)
    })

    it('never disables or scales the Main through a chart update', async () => {
        const { client: c } = client()
        expect(typeof parseChartChanges('main.enabled=false')).toBe('string')
        expect(typeof parseChartChanges('main.max=3')).toBe('string')
        expect(await c.planChartUpdate([{ path: 'unknown.resources.limits.cpu', value: '2' }])).toMatchObject({ ok: false })
    })
})

describe('Zugang: In-Cluster-ServiceAccount oder Konto der externen Main', () => {
    const servers: Server[] = []
    afterEach(() => { for (const s of servers.splice(0)) s.close() })

    it('is off outside a pod without explicit server, and in a pod without control file', async () => {
        expect(await loadKubernetesRuntime({ env: {}, readFile: () => { throw new Error('none') } })).toMatchObject({ ok: false })
        const env = { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' }
        expect(await loadKubernetesRuntime({ env, readFile: () => { throw new Error('none') } })).toMatchObject({ ok: false, reason: expect.stringMatching(/Steuerdatei/) })
        expect(kubernetesControlConfigured({}, {})).toBe(false)
        expect(kubernetesControlConfigured(env, {})).toBe(true)
        expect(kubernetesControlConfigured({}, { infra: { kubernetes: { server: 'https://192.0.2.1:6443' } } })).toBe(true)
        expect(kubernetesControlConfigured({}, { infra: { kubernetes: { server: 'https://192.0.2.1:6443', enabled: false } } })).toBe(false)
    })

    it('uses the mounted service-account token and the control file in-cluster', async () => {
        const files: Record<string, string> = {
            '/var/run/secrets/kubernetes.io/serviceaccount/token': 'fake-token-' + Math.random().toString(36).slice(2),
            '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt': selfSignedCert('kubernetes.default.svc').cert,
            '/var/run/secrets/kubernetes.io/serviceaccount/namespace': NS,
            '/etc/xaventra/cluster/control.json': JSON.stringify(controlPolicyRaw()),
        }
        const runtime = await loadKubernetesRuntime({
            env: { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' },
            readFile: path => { if (path in files) return files[path]; throw new Error('missing') },
            transport: createFakeKube().transport,
        })
        expect(runtime).toMatchObject({ ok: true, server: 'https://10.96.0.1:443' })
        files['/etc/xaventra/cluster/control.json'] = JSON.stringify(controlPolicyRaw({ namespace: 'fremd' }))
        expect(await loadKubernetesRuntime({ env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' }, readFile: path => { if (path in files) return files[path]; throw new Error('missing') }, transport: createFakeKube().transport }))
            .toMatchObject({ ok: false, reason: expect.stringMatching(/Namespace/) })
    })

    it('external Main: reads the control ConfigMap through the guard — exactly one GET, nothing else', async () => {
        const fake = createFakeKube()
        const rawConfig = { infra: { kubernetes: { server: 'https://192.0.2.1:6443', caFile: '/x/ca.crt', namespace: NS, release: RELEASE } } }
        const runtime = await loadKubernetesRuntime({ env: { XAVENTRA_K8S_TOKEN_FILE: '/x/token' }, rawConfig, readFile: () => { throw new Error('no file') }, transport: fake.transport })
        expect(runtime).toMatchObject({ ok: true, server: 'https://192.0.2.1:6443' })
        if (!runtime.ok) return
        expect(Object.keys(runtime.policy.workloads)).toEqual(['main', 'worker-general', 'voice'])
        expect(fake.calls).toEqual([{ method: 'GET', path: `/api/v1/namespaces/${NS}/configmaps/${RELEASE}-control` }])
        // Missing namespace or token path: off, no request.
        const before = fake.calls.length
        expect(await loadKubernetesRuntime({ env: { XAVENTRA_K8S_TOKEN_FILE: '/x/token' }, rawConfig: { infra: { kubernetes: { server: 'https://192.0.2.1:6443', caFile: '/x/ca.crt', release: RELEASE } } }, transport: fake.transport }))
            .toMatchObject({ ok: false, reason: expect.stringMatching(/namespace/) })
        expect(await loadKubernetesRuntime({ env: {}, rawConfig, transport: fake.transport })).toMatchObject({ ok: false, reason: expect.stringMatching(/TOKEN_FILE/) })
        expect(fake.calls.length).toBe(before)
        // A ConfigMap naming another namespace is refused.
        const foreign = await loadKubernetesRuntime({ env: { XAVENTRA_K8S_TOKEN_FILE: '/x/token' }, rawConfig, transport: async () => ({ status: 200, data: { data: { 'control.json': JSON.stringify(controlPolicyRaw({ namespace: 'fremd' })) } } }) })
        expect(foreign).toMatchObject({ ok: false, reason: expect.stringMatching(/Namespace/) })
    })

    it('real transport: TLS against the given CA, bearer token from file, token never in errors', async () => {
        const { cert, key } = selfSignedCert('localhost')
        const seen: string[] = []
        const server = createServer({ cert, key }, (req, res) => {
            seen.push(String(req.headers.authorization || ''))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ items: [] }))
        })
        servers.push(server)
        await new Promise<void>(resolve => server.listen(0, 'localhost', () => resolve()))
        const port = (server.address() as AddressInfo).port
        const dir = mkdtempSync(join(tmpdir(), 'xv-kube-'))
        const token = 'fake-token-' + Math.random().toString(36).slice(2)
        writeFileSync(join(dir, 'token'), token)
        const transport = createKubeTransport({ server: `https://localhost:${port}`, caPem: cert, tokenFile: join(dir, 'token') })
        expect(await transport({ method: 'GET', path: `/api/v1/namespaces/${NS}/pods` })).toEqual({ status: 200, data: { items: [] } })
        expect(seen).toEqual([`Bearer ${token}`])
        const other = createKubeTransport({ server: `https://localhost:${port}`, caPem: selfSignedCert('localhost').cert, tokenFile: join(dir, 'token') })
        const error = await other({ method: 'GET', path: `/api/v1/namespaces/${NS}/pods` }).then(() => null, (e: Error) => e)
        expect(error).toBeInstanceOf(Error)
        expect(String(error?.message)).not.toContain(token)
        expect(seen.length).toBe(1)
    })
})
