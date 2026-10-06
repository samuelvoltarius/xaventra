import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    KUBERNETES_NEVER, KubernetesClient, checkKubeRequest, createKubeTransport, loadKubernetesRuntime, parseChartChanges, parseControlPolicy,
} from './kubernetes.js'
import { IMAGE, NS, RELEASE, controlPolicyRaw, createFakeKube } from '../../test/helpers/fake-kube.js'
import { selfSignedCert } from '../../test/helpers/fake-pve.js'
import { neverListViolation } from '../install/never-list.js'

// P19: Kubernetes adapter. A narrow, fixed set of actions against the API of
// the OWN namespace — never raw kubectl, never secrets, never exec. Only a
// fake API server; no cluster, no real address, no real token.

const policy = () => parseControlPolicy(controlPolicyRaw())!
function client(fake = createFakeKube()) {
    return { fake, client: new KubernetesClient({ policy: policy(), transport: fake.transport, now: () => Date.parse('2026-10-07T12:00:00Z') }) }
}

describe('Steuerdatei aus dem Chart', () => {
    it('parses the chart-rendered control policy and bounds every number', () => {
        const parsed = policy()
        expect(parsed).toMatchObject({ namespace: NS, release: RELEASE, controlConfigMap: `${RELEASE}-control` })
        expect(parsed.workloads['worker-general']).toMatchObject({ kind: 'Deployment', object: `${RELEASE}-worker-general`, min: 1, max: 4, autoscale: true, role: 'worker' })
        expect(parseControlPolicy({ ...controlPolicyRaw(), namespace: 'Bad NS' })).toBeNull()
        expect(parseControlPolicy({ ...controlPolicyRaw(), schema: 2 })).toBeNull()
        const weird = parseControlPolicy(controlPolicyRaw({ workloads: { w: { kind: 'DaemonSet', object: 'x', min: 0, max: 1 }, v: { kind: 'Deployment', object: 'xv-v', min: 5, max: 2 }, z: { kind: 'Deployment', object: 'xv-z', min: -1, max: 999 } } }))!
        expect(Object.keys(weird.workloads)).toEqual(['z'])
        expect(weird.workloads.z).toMatchObject({ min: 0, max: 20 })
    })
})

describe('Anfrage-Wächter (vor jedem Request)', () => {
    const p = () => policy()
    it('allows only the fixed read/patch routes in the own namespace', () => {
        expect(checkKubeRequest({ method: 'GET', path: `/api/v1/namespaces/${NS}/pods?labelSelector=app.kubernetes.io%2Finstance%3Dxv` }, p())).toBeNull()
        expect(checkKubeRequest({ method: 'GET', path: `/api/v1/namespaces/${NS}/pods/xv-main-0/log?tailLines=100&container=xaventra` }, p())).toBeNull()
        expect(checkKubeRequest({ method: 'PATCH', path: `/apis/apps/v1/namespaces/${NS}/deployments/xv-worker-general/scale`, body: {} }, p())).toBeNull()
    })

    it.each([
        ['fremder Namespace', 'GET', '/api/v1/namespaces/fremd/pods'],
        ['fremder Namespace (apps)', 'PATCH', '/apis/apps/v1/namespaces/kube-system/deployments/coredns/scale'],
        ['Secrets lesen', 'GET', `/api/v1/namespaces/${NS}/secrets`],
        ['Secret einzeln', 'GET', `/api/v1/namespaces/${NS}/secrets/xv-env`],
        ['exec', 'GET', `/api/v1/namespaces/${NS}/pods/xv-main-0/exec?command=sh`],
        ['attach', 'GET', `/api/v1/namespaces/${NS}/pods/xv-main-0/attach`],
        ['portforward', 'GET', `/api/v1/namespaces/${NS}/pods/xv-main-0/portforward`],
        ['proxy', 'GET', `/api/v1/namespaces/${NS}/pods/xv-main-0/proxy/`],
        ['Cluster-weit', 'GET', '/api/v1/nodes'],
        ['Namespace anlegen', 'POST', '/api/v1/namespaces'],
        ['Löschen', 'DELETE', `/apis/apps/v1/namespaces/${NS}/deployments/xv-worker-general`],
        ['Pod löschen', 'DELETE', `/api/v1/namespaces/${NS}/pods/xv-main-0`],
        ['PVC', 'GET', `/api/v1/namespaces/${NS}/persistentvolumeclaims`],
        ['RBAC', 'PATCH', `/apis/rbac.authorization.k8s.io/v1/namespaces/${NS}/roles/xv`],
        ['fremde ConfigMap', 'PATCH', `/api/v1/namespaces/${NS}/configmaps/kube-root-ca.crt`],
        ['Pfad-Trick', 'GET', `/api/v1/namespaces/${NS}/pods/../../fremd/pods`],
        ['kodierter Pfad-Trick', 'GET', `/api/v1/namespaces/${NS}/pods/%2e%2e/secrets`],
        ['fremdes Objekt patchen', 'PATCH', `/apis/apps/v1/namespaces/${NS}/deployments/fremd-app`],
        ['Token anfordern', 'POST', `/api/v1/namespaces/${NS}/serviceaccounts/xv/token`],
    ])('refuses %s', (_label, method, path) => {
        expect(checkKubeRequest({ method: method as any, path, body: {} }, p())).toMatch(/.+/)
    })

    it('a refused request never reaches the API server', async () => {
        const { fake, client: c } = client()
        await expect(c.request({ method: 'GET', path: `/api/v1/namespaces/${NS}/secrets` })).rejects.toThrow(/Secret/)
        await expect(c.request({ method: 'GET', path: `/api/v1/namespaces/${NS}/pods/xv-main-0/exec?command=sh` })).rejects.toThrow(/exec/)
        await expect(c.request({ method: 'GET', path: '/api/v1/namespaces/fremd/pods' })).rejects.toThrow(/Namespace/)
        expect(fake.calls).toEqual([])
    })

    it('kubectl stays on the Nie-Liste; the adapter documents its own never list', () => {
        expect(neverListViolation(['kubectl', 'get', 'pods'])?.ruleId).toBe('containers-database')
        expect(KUBERNETES_NEVER.join(' ')).toMatch(/Secret/)
        expect(KUBERNETES_NEVER.join(' ')).toMatch(/exec/)
        expect(KUBERNETES_NEVER.join(' ')).toMatch(/fremde Namespaces/)
    })
})

describe('Lesen: Status, Events, Logs', () => {
    it('shows own workloads and pods, never the foreign namespace', async () => {
        const { fake, client: c } = client()
        const status = await c.status()
        expect(status.workloads.map(w => w.name)).toEqual(['main', 'worker-general', 'voice'])
        expect(status.workloads.find(w => w.name === 'worker-general')).toMatchObject({ desired: 1, ready: 1, min: 1, max: 4, image: IMAGE })
        expect(status.pods.length).toBe(3)
        expect(JSON.stringify(status)).not.toContain('fremd')
        expect(fake.calls.every(call => call.method === 'GET' && call.path.includes(`/namespaces/${NS}/`))).toBe(true)
    })

    it('lists warning events first and bounded', async () => {
        const { client: c } = client()
        const events = await c.events(5)
        expect(events[0]).toMatchObject({ type: 'Warning', reason: 'BackOff', object: `Pod/${RELEASE}-voice-5d8f7-abcd0` })
    })

    it('reads logs only of own pods, bounded and redacted', async () => {
        const { fake, client: c } = client()
        const text = await c.logs(`${RELEASE}-main-0`, 5000)
        expect(text).not.toMatch(/sk-test-x{20}/)
        expect(text).toContain('Zeile 3')
        expect(fake.calls.at(-1)!.path).toMatch(/tailLines=500/)
        await expect(c.logs('fremd-app-1')).rejects.toThrow(/nicht aus diesem Release/)
    })
})

describe('Schreiben: Skalieren und Neustart', () => {
    it('scales an own worker Deployment within min/max without a card', async () => {
        const { fake, client: c } = client()
        expect(await c.scaleWorker('worker-general', 3)).toMatchObject({ ok: true, requested: true })
        expect(fake.workload(`${RELEASE}-worker-general`).replicas).toBe(3)
        expect(fake.writes().at(-1)).toMatchObject({ method: 'PATCH', path: `/apis/apps/v1/namespaces/${NS}/deployments/${RELEASE}-worker-general/scale`, body: { spec: { replicas: 3 } } })
    })

    it('refuses out-of-bounds, main and unknown workloads before any request', async () => {
        const { fake, client: c } = client()
        expect(await c.scaleWorker('worker-general', 5)).toMatchObject({ ok: false, requested: false })
        expect(await c.scaleWorker('worker-general', 0)).toMatchObject({ ok: false, requested: false })
        expect(await c.scaleWorker('main', 2)).toMatchObject({ ok: false, requested: false })
        expect(await c.scaleWorker('fremd-app', 1)).toMatchObject({ ok: false, requested: false })
        expect(await c.scaleWorker('worker-general', 1.5)).toMatchObject({ ok: false, requested: false })
        expect(fake.calls).toEqual([])
    })

    it('restarts an own worker via rollout annotation; main only with an approved card', async () => {
        const { fake, client: c } = client()
        expect(await c.restartWorkload('worker-general')).toMatchObject({ ok: true, requested: true })
        expect(fake.workload(`${RELEASE}-worker-general`).restartedAt).toBe('2026-10-07T12:00:00.000Z')
        const before = fake.calls.length
        expect(await c.restartWorkload('main')).toMatchObject({ ok: false, requested: false, needsCard: true })
        expect(fake.calls.length).toBe(before)
        expect(await c.restartWorkload('main', { approved: true })).toMatchObject({ ok: true, requested: true })
        expect(fake.writes().at(-1)!.path).toBe(`/apis/apps/v1/namespaces/${NS}/statefulsets/${RELEASE}-main`)
    })
})

describe('Chart-Update: Diff-Vorschau, dann Karte', () => {
    it('parses only whitelisted value paths', () => {
        expect(parseChartChanges('image.tag=2.88.1 worker-general.resources.limits.memory=4Gi worker-general.max=6')).toEqual([
            { path: 'image.tag', value: '2.88.1' },
            { path: 'worker-general.resources.limits.memory', value: '4Gi' },
            { path: 'worker-general.max', value: '6' },
        ])
        for (const bad of ['secrets.existingSecret=x', 'rbac.create=false', 'main.securityContext.runAsUser=0', 'image.repository=evil/img', 'worker-general.resources.limits.memory=4G; rm', 'image.tag=../x', 'networkPolicy.enabled=false']) {
            expect(typeof parseChartChanges(bad)).toBe('string')
        }
    })

    it('previews old → new from the live cluster and marks removals; nothing is written', async () => {
        const { fake, client: c } = client()
        const plan = await c.planChartUpdate(parseChartChanges('image.tag=2.88.1 worker-general.resources.limits.memory=4Gi voice.enabled=false') as any)
        if (!('lines' in plan)) throw new Error(plan.message)
        expect(plan.lines).toEqual(expect.arrayContaining([
            `main: Image ${IMAGE} → ghcr.io/example/xaventra:2.88.1`,
            'worker-general: resources.limits.memory 2Gi → 4Gi',
            'voice: abgeschaltet (Replikas 1 → 0) — ENTFERNT diese Workload',
        ]))
        expect(plan.removes).toEqual(['voice'])
        expect(fake.writes()).toEqual([])
    })

    it('applies a fresh plan; refuses when the cluster changed since the preview', async () => {
        const { fake, client: c } = client()
        const plan = await c.planChartUpdate(parseChartChanges('worker-general.max=6 worker-general.resources.limits.memory=4Gi') as any)
        if (!('lines' in plan)) throw new Error(plan.message)
        expect(await c.applyChartUpdate(plan)).toMatchObject({ ok: true })
        expect(fake.workload(`${RELEASE}-worker-general`).resources.limits.memory).toBe('4Gi')
        expect(fake.control().workloads['worker-general'].max).toBe(6)
        // Second apply of the same plan: before-state no longer matches.
        const writes = fake.writes().length
        expect(await c.applyChartUpdate(plan)).toMatchObject({ ok: false, requested: false })
        expect(fake.writes().length).toBe(writes)
    })

    it('never disables or scales the Main through a chart update', async () => {
        const { client: c } = client()
        expect(typeof parseChartChanges('main.enabled=false')).toBe('string')
        expect(typeof parseChartChanges('main.max=3')).toBe('string')
        const plan = await c.planChartUpdate([{ path: 'unknown.max', value: '2' }])
        expect(plan).toMatchObject({ ok: false })
    })
})

describe('Zugang: In-Cluster-ServiceAccount oder eigenes Konto', () => {
    const servers: Server[] = []
    afterEach(() => { for (const s of servers.splice(0)) s.close() })

    it('is off outside a pod without explicit server, and without control file', async () => {
        expect(await loadKubernetesRuntime({ env: {}, readFile: () => { throw new Error('none') } })).toMatchObject({ ok: false })
        const env = { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' }
        expect(await loadKubernetesRuntime({ env, readFile: () => { throw new Error('none') } })).toMatchObject({ ok: false, reason: expect.stringMatching(/Steuerdatei/) })
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
        // The control file must name the pod's own namespace.
        files['/etc/xaventra/cluster/control.json'] = JSON.stringify(controlPolicyRaw({ namespace: 'fremd' }))
        expect(await loadKubernetesRuntime({ env: { KUBERNETES_SERVICE_HOST: '10.96.0.1' }, readFile: path => { if (path in files) return files[path]; throw new Error('missing') } }))
            .toMatchObject({ ok: false, reason: expect.stringMatching(/Namespace/) })
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
        // Wrong CA: refused, and the token does not show up in the error.
        const other = createKubeTransport({ server: `https://localhost:${port}`, caPem: selfSignedCert('localhost').cert, tokenFile: join(dir, 'token') })
        const error = await other({ method: 'GET', path: `/api/v1/namespaces/${NS}/pods` }).then(() => null, (e: Error) => e)
        expect(error).toBeInstanceOf(Error)
        expect(String(error?.message)).not.toContain(token)
        expect(seen.length).toBe(1)
    })
})
