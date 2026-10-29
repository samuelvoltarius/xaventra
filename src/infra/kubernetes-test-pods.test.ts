import { beforeEach, describe, expect, it } from 'vitest'
import { KubernetesClient, checkKubeRequest, parseControlPolicy, type KubernetesRuntime } from './kubernetes.js'
import { KUBE_TEST_NAMESPACE, TEST_POD_LABEL, buildTestPod, validateTestPod } from './kubernetes-test-pods.js'
import { runTestPodAction, type ClusterDeps } from './kubernetes-command.js'
import { NS, TEST_NS, controlPolicyRaw, createFakeKube } from '../../test/helpers/fake-kube.js'

// 2.89.15: Xaventra may create and delete pods — only in exactly
// `xaventra-test`, only from the fixed template (label managed-by=xaventra,
// resource limits, no host access, no service-account token), only own
// labelled pods are deleted, every create needs the owner's approval. Every
// other write stays refused by the guard. Only a fake API server.

const policy = () => parseControlPolicy(controlPolicyRaw())!
const pod = (overrides: Record<string, unknown> = {}) => {
    const built = buildTestPod({ name: 'xvt-probe', image: 'docker.io/library/busybox:1.36', command: ['sh', '-c', 'echo ok'], ...overrides })
    if (built.ok === false) throw new Error(built.reason)
    return built.pod
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const POD_PATH = `/api/v1/namespaces/${TEST_NS}/pods`

let fake: ReturnType<typeof createFakeKube>
let deps: ClusterDeps
function runtime(): KubernetesRuntime {
    const p = policy()
    return { ok: true, policy: p, server: 'https://192.0.2.1:6443', client: new KubernetesClient({ policy: p, transport: fake.transport }) }
}
beforeEach(() => {
    fake = createFakeKube()
    deps = { runtime: async () => runtime(), nodeOnly: false, fence: async () => ({ ok: true, reason: 'test' }) }
})

describe('Test-Pod-Vorlage', () => {
    it('is labelled, limited, without host access and without service-account token', () => {
        expect(KUBE_TEST_NAMESPACE).toBe('xaventra-test')
        const p = pod()
        expect(p.metadata).toEqual({ name: 'xvt-probe', namespace: TEST_NS, labels: { [TEST_POD_LABEL.key]: TEST_POD_LABEL.value } })
        expect(TEST_POD_LABEL).toEqual({ key: 'managed-by', value: 'xaventra' })
        expect(p.spec.automountServiceAccountToken).toBe(false)
        expect(p.spec.restartPolicy).toBe('Never')
        expect(p.spec.activeDeadlineSeconds).toBeGreaterThan(0)
        const container = p.spec.containers[0]
        expect(container.resources.limits).toEqual({ cpu: '250m', memory: '128Mi' })
        expect(container.securityContext).toMatchObject({ privileged: false, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } })
        expect(JSON.stringify(p)).not.toMatch(/hostNetwork|hostPath|hostPID|hostIPC|volumes|serviceAccountName|nodeName/)
        expect(validateTestPod(p)).toBeNull()
    })

    it.each([
        ['ungültiger Name', { name: 'Bad Name' }, /Name/],
        ['Image ohne Tag', { image: 'busybox' }, /Tag/],
        ['Image latest', { image: 'busybox:latest' }, /latest/],
        ['zu viel CPU', { cpu: '4' }, /CPU/],
        ['zu viel Speicher', { memory: '8Gi' }, /Speicher/],
        ['zu lange Laufzeit', { laufzeitSekunden: 7 * 24 * 3600 }, /Laufzeit/],
    ])('build refuses %s', (_label, overrides, why) => {
        const built = buildTestPod({ name: 'xvt-probe', image: 'busybox:1.36', ...overrides } as any)
        expect(built.ok).toBe(false)
        expect((built as any).reason).toMatch(why)
    })

    it.each([
        ['ohne Label managed-by=xaventra', (p: any) => { p.metadata.labels = {} }, /managed-by=xaventra/],
        ['falsches Label', (p: any) => { p.metadata.labels['managed-by'] = 'fremd' }, /managed-by=xaventra/],
        ['anderer Namespace im Objekt', (p: any) => { p.metadata.namespace = NS }, /Namespace/],
        ['hostNetwork', (p: any) => { p.spec.hostNetwork = true }, /hostNetwork/],
        ['hostPID', (p: any) => { p.spec.hostPID = true }, /hostPID/],
        ['hostPath-Volume', (p: any) => { p.spec.volumes = [{ name: 'root', hostPath: { path: '/' } }] }, /hostPath|Volumes/],
        ['privileged', (p: any) => { p.spec.containers[0].securityContext.privileged = true }, /privileged/],
        ['Privilege Escalation', (p: any) => { p.spec.containers[0].securityContext.allowPrivilegeEscalation = true }, /Escalation/],
        ['Capabilities hinzufügen', (p: any) => { p.spec.containers[0].securityContext.capabilities.add = ['SYS_ADMIN'] }, /Capabilities/],
        ['ohne Limits', (p: any) => { delete p.spec.containers[0].resources.limits }, /Limits/],
        ['Limits zu hoch', (p: any) => { p.spec.containers[0].resources.limits.memory = '64Gi' }, /Speicher/],
        ['Secret als Umgebungsvariable', (p: any) => { p.spec.containers[0].env = [{ name: 'X', valueFrom: { secretKeyRef: { name: 's', key: 'k' } } }] }, /Secret|valueFrom/],
        ['envFrom Secret', (p: any) => { p.spec.containers[0].envFrom = [{ secretRef: { name: 's' } }] }, /envFrom|nicht erlaubt/],
        ['hostPort', (p: any) => { p.spec.containers[0].ports = [{ containerPort: 80, hostPort: 80 }] }, /ports|nicht erlaubt/],
        ['Service-Account-Token', (p: any) => { p.spec.automountServiceAccountToken = true }, /Token/],
        ['fremder ServiceAccount', (p: any) => { p.spec.serviceAccountName = 'xaventra-control' }, /serviceAccountName|nicht erlaubt/],
        ['festen Knoten wählen', (p: any) => { p.spec.nodeName = 'node-a' }, /nodeName|nicht erlaubt/],
        ['ohne Laufzeitgrenze', (p: any) => { delete p.spec.activeDeadlineSeconds }, /Laufzeit/],
        ['Init-Container', (p: any) => { p.spec.initContainers = [clone(p.spec.containers[0])] }, /initContainers|nicht erlaubt/],
        ['kein Pod', (p: any) => { p.kind = 'Deployment' }, /Pod/],
    ])('validator refuses %s', (_label, mutate, why) => {
        const p = clone(pod())
        mutate(p)
        expect(validateTestPod(p)).toMatch(why)
    })
})

describe('Wächter: Schreiben nur für Pods in genau xaventra-test', () => {
    it('allows create (valid template), get, list, logs and delete of pods in xaventra-test', () => {
        expect(checkKubeRequest({ method: 'POST', path: POD_PATH, body: pod() }, policy())).toBeNull()
        expect(checkKubeRequest({ method: 'GET', path: `${POD_PATH}?labelSelector=managed-by%3Dxaventra` }, policy())).toBeNull()
        expect(checkKubeRequest({ method: 'GET', path: `${POD_PATH}/xvt-probe` }, policy())).toBeNull()
        expect(checkKubeRequest({ method: 'GET', path: `${POD_PATH}/xvt-probe/log?tailLines=50` }, policy())).toBeNull()
        expect(checkKubeRequest({ method: 'DELETE', path: `${POD_PATH}/xvt-probe`, body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'u1' } } }, policy())).toBeNull()
    })

    it.each([
        ['Pod anlegen im eigenen Namespace', 'POST', `/api/v1/namespaces/${NS}/pods`],
        ['Pod löschen im eigenen Namespace', 'DELETE', `/api/v1/namespaces/${NS}/pods/xv-main-0`],
        ['Pod anlegen in kube-system', 'POST', '/api/v1/namespaces/kube-system/pods'],
        ['Pod löschen in default', 'DELETE', '/api/v1/namespaces/default/pods/x'],
        ['Pod anlegen in fremd', 'POST', '/api/v1/namespaces/fremd/pods'],
        ['ähnlicher Namespace', 'POST', '/api/v1/namespaces/xaventra-test2/pods'],
        ['Secrets in xaventra-test lesen', 'GET', `/api/v1/namespaces/${TEST_NS}/secrets`],
        ['Secret in xaventra-test anlegen', 'POST', `/api/v1/namespaces/${TEST_NS}/secrets`],
        ['exec in xaventra-test', 'POST', `${POD_PATH}/xvt-probe/exec`],
        ['attach in xaventra-test', 'GET', `${POD_PATH}/xvt-probe/attach`],
        ['portforward in xaventra-test', 'POST', `${POD_PATH}/xvt-probe/portforward`],
        ['proxy in xaventra-test', 'GET', `${POD_PATH}/xvt-probe/proxy`],
        ['ephemeralcontainers in xaventra-test', 'PATCH', `${POD_PATH}/xvt-probe/ephemeralcontainers`],
        ['Pod ändern in xaventra-test', 'PATCH', `${POD_PATH}/xvt-probe`],
        ['Pod ersetzen in xaventra-test', 'PUT', `${POD_PATH}/xvt-probe`],
        ['alle Pods auf einmal löschen', 'DELETE', POD_PATH],
        ['Deployment in xaventra-test', 'POST', `/apis/apps/v1/namespaces/${TEST_NS}/deployments`],
        ['ConfigMap in xaventra-test', 'POST', `/api/v1/namespaces/${TEST_NS}/configmaps`],
        ['Job in xaventra-test', 'POST', `/apis/batch/v1/namespaces/${TEST_NS}/jobs`],
        ['Namespace selbst löschen', 'DELETE', `/api/v1/namespaces/${TEST_NS}`],
        ['Service-Account-Token in xaventra-test', 'POST', `/api/v1/namespaces/${TEST_NS}/serviceaccounts/default/token`],
        ['Pfad-Trick', 'POST', `${POD_PATH}/../../${NS}/pods`],
        ['Query beim Schreiben', 'POST', `${POD_PATH}?dryRun=All`],
    ])('refuses %s', (_label, method, path) => {
        expect(checkKubeRequest({ method: method as any, path, body: pod() }, policy())).toMatch(/.+/)
    })

    it('refuses a pod body without the label or with host access even on the allowed route', () => {
        const unlabelled = clone(pod()); unlabelled.metadata.labels = {}
        expect(checkKubeRequest({ method: 'POST', path: POD_PATH, body: unlabelled }, policy())).toMatch(/managed-by=xaventra/)
        const host = clone(pod()); host.spec.hostNetwork = true
        expect(checkKubeRequest({ method: 'POST', path: POD_PATH, body: host }, policy())).toMatch(/hostNetwork/)
        expect(checkKubeRequest({ method: 'DELETE', path: `${POD_PATH}/xvt-probe`, body: { propagationPolicy: 'Orphan', dryRun: ['All'] } }, policy())).toMatch(/.+/)
    })

    it('a refused write never reaches the API server', async () => {
        const c = runtime().client
        const unlabelled = clone(pod()); unlabelled.metadata.labels = {}
        await expect(c.request({ method: 'POST', path: POD_PATH, body: unlabelled })).rejects.toThrow(/managed-by/)
        await expect(c.request({ method: 'POST', path: `/api/v1/namespaces/${NS}/pods`, body: pod() })).rejects.toThrow(/abgelehnt/)
        await expect(c.request({ method: 'GET', path: `/api/v1/namespaces/${TEST_NS}/secrets` })).rejects.toThrow(/Secret/)
        expect(fake.calls).toEqual([])
    })
})

describe('Anlegen, Liste, Löschen über /cluster-Logik', () => {
    const approved = async () => null

    it('creating without approval switches nothing', async () => {
        const result = await runTestPodAction({ art: 'anlegen', input: { name: 'xvt-probe', image: 'busybox:1.36' }, approve: async () => '❌ braucht Freigabe' }, deps)
        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/Freigabe/)
        expect(fake.writes()).toEqual([])
        expect(fake.testPods.has('xvt-probe')).toBe(false)
    })

    it('the approval is asked for exactly this pod (detail from the template)', async () => {
        const details: string[] = []
        await runTestPodAction({ art: 'anlegen', input: { name: 'xvt-probe', image: 'busybox:1.36' }, approve: async detail => { details.push(detail); return 'nein' } }, deps)
        await runTestPodAction({ art: 'anlegen', input: { name: 'xvt-probe', image: 'busybox:1.37' }, approve: async detail => { details.push(detail); return 'nein' } }, deps)
        expect(details[0]).toMatch(/^#[a-f0-9]{12}$/)
        expect(details[1]).not.toBe(details[0])
    })

    it('with approval: one POST of the template into xaventra-test', async () => {
        const result = await runTestPodAction({ art: 'anlegen', input: { name: 'xvt-probe', image: 'busybox:1.36', command: ['sh', '-c', 'echo ok'] }, approve: approved }, deps)
        expect(result.ok, result.message).toBe(true)
        expect(fake.writes()).toHaveLength(1)
        expect(fake.writes()[0]).toMatchObject({ method: 'POST', path: POD_PATH })
        expect(fake.testPods.get('xvt-probe').metadata.labels).toEqual({ 'managed-by': 'xaventra' })
    })

    it('an invalid request is refused before the approval is asked', async () => {
        let asked = false
        const result = await runTestPodAction({ art: 'anlegen', input: { name: 'xvt-probe', image: 'busybox' }, approve: async () => { asked = true; return null } }, deps)
        expect(result.ok).toBe(false)
        expect(asked).toBe(false)
        expect(fake.writes()).toEqual([])
    })

    it('lists only own labelled pods', async () => {
        await runTestPodAction({ art: 'anlegen', input: { name: 'xvt-probe', image: 'busybox:1.36' }, approve: approved }, deps)
        const result = await runTestPodAction({ art: 'liste' }, deps)
        expect(result.message).toContain('xvt-probe')
        expect(result.message).not.toContain('fremd-debug')
    })

    it('deletes only own labelled pods, with uid precondition', async () => {
        await runTestPodAction({ art: 'anlegen', input: { name: 'xvt-probe', image: 'busybox:1.36' }, approve: approved }, deps)
        const result = await runTestPodAction({ art: 'loeschen', name: 'xvt-probe' }, deps)
        expect(result.ok, result.message).toBe(true)
        const del = fake.writes().find(call => call.method === 'DELETE')!
        expect(del.path).toBe(`${POD_PATH}/xvt-probe`)
        expect((del.body as any).preconditions.uid).toMatch(/^uid-/)
        expect(fake.testPods.has('xvt-probe')).toBe(false)
    })

    it('a pod without the label is never deleted (no DELETE request)', async () => {
        const result = await runTestPodAction({ art: 'loeschen', name: 'fremd-debug' }, deps)
        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/managed-by=xaventra/)
        expect(fake.writes()).toEqual([])
        expect(fake.testPods.has('fremd-debug')).toBe(true)
    })

    it('workers never act; without the Main lease nothing is written', async () => {
        const worker = await runTestPodAction({ art: 'anlegen', input: { name: 'xvt-probe', image: 'busybox:1.36' }, approve: approved }, { ...deps, nodeOnly: true })
        expect(worker.ok).toBe(false)
        const unfenced = await runTestPodAction({ art: 'anlegen', input: { name: 'xvt-probe', image: 'busybox:1.36' }, approve: approved }, { ...deps, fence: async () => ({ ok: false, reason: 'no lease' }) })
        expect(unfenced.message).toMatch(/Main-Lease/)
        const unfencedDelete = await runTestPodAction({ art: 'loeschen', name: 'fremd-debug' }, { ...deps, fence: async () => ({ ok: false, reason: 'no lease' }) })
        expect(unfencedDelete.message).toMatch(/Main-Lease/)
        expect(fake.calls.filter(call => call.path.includes(TEST_NS))).toEqual([])
    })
})
