/**
 * Fake Kubernetes API server for tests (P19/P21). In-memory: no cluster, no
 * real address, no real token. Records every request so tests can prove that a
 * refused action never reached the API. Only the namespace `xaventra` and the
 * release `xv` exist; a second namespace `fremd` exists to prove it is never
 * touched. Workers are DaemonSets (one pod per labelled node); the Main is an
 * optional StatefulSet.
 */
import type { KubeRequest, KubeResponse, KubeTransport } from '../../src/infra/kubernetes.js'

export const NS = 'xaventra'
export const RELEASE = 'xv'
export const IMAGE = 'ghcr.io/example/xaventra:2.88.0'

export function controlPolicyRaw(overrides: Record<string, unknown> = {}) {
    return {
        schema: 2, namespace: NS, release: RELEASE, fullname: RELEASE, controlConfigMap: `${RELEASE}-control`,
        image: { repository: 'ghcr.io/example/xaventra' },
        workerNodeLabel: 'xaventra.ai/worker',
        workloads: {
            main: { kind: 'StatefulSet', object: `${RELEASE}-main`, container: 'xaventra', role: 'main' },
            'worker-general': { kind: 'DaemonSet', object: `${RELEASE}-worker-general`, container: 'xaventra', role: 'worker' },
            voice: { kind: 'DaemonSet', object: `${RELEASE}-voice`, container: 'xaventra', role: 'optional' },
        },
        ...overrides,
    }
}

interface Workload { kind: 'DaemonSet' | 'StatefulSet'; name: string; nodes: string[]; ready: number; image: string; resources: Record<string, any>; restartedAt?: string; namespace: string }

export function createFakeKube(options: { workerNodes?: string[] } = {}) {
    const calls: KubeRequest[] = []
    const workerNodes = options.workerNodes ?? ['node-a']
    const workloads: Workload[] = [
        { kind: 'StatefulSet', name: `${RELEASE}-main`, nodes: ['node-a'], ready: 1, image: IMAGE, resources: { limits: { memory: '4Gi' } }, namespace: NS },
        { kind: 'DaemonSet', name: `${RELEASE}-worker-general`, nodes: workerNodes, ready: workerNodes.length, image: IMAGE, resources: { requests: { cpu: '500m' }, limits: { cpu: '2', memory: '4Gi' } }, namespace: NS },
        { kind: 'DaemonSet', name: `${RELEASE}-voice`, nodes: [], ready: 0, image: IMAGE, resources: {}, namespace: NS },
        { kind: 'DaemonSet', name: 'fremd-agent', nodes: ['node-a', 'node-b'], ready: 2, image: 'example/other:1', resources: {}, namespace: 'fremd' },
    ]
    const controlJson = JSON.stringify(controlPolicyRaw())
    const secretLog = 'Bearer abc.def.ghi und OPENAI_API_KEY=sk-test-' + 'x'.repeat(40)
    const respond = (data: unknown, status = 200): KubeResponse => ({ status, data })
    const kindPath = (kind: Workload['kind']) => kind === 'DaemonSet' ? 'daemonsets' : 'statefulsets'
    const asObject = (w: Workload) => ({
        kind: w.kind, metadata: { name: w.name, namespace: w.namespace, labels: { 'app.kubernetes.io/instance': RELEASE, 'xaventra.ai/workload': w.name.replace(`${RELEASE}-`, '') } },
        spec: {
            ...(w.kind === 'StatefulSet' ? { replicas: w.nodes.length } : {}),
            template: { metadata: { annotations: w.restartedAt ? { 'kubectl.kubernetes.io/restartedAt': w.restartedAt } : {} }, spec: { containers: [{ name: 'xaventra', image: w.image, resources: w.resources }] } },
        },
        status: w.kind === 'DaemonSet'
            ? { desiredNumberScheduled: w.nodes.length, currentNumberScheduled: w.nodes.length, numberReady: w.ready, numberAvailable: w.ready, updatedNumberScheduled: w.nodes.length }
            : { replicas: w.nodes.length, readyReplicas: w.ready, availableReplicas: w.ready, updatedReplicas: w.nodes.length },
    })
    const pods = () => workloads.filter(w => w.namespace === NS).flatMap(w => w.nodes.map((node, i) => ({
        metadata: { name: w.kind === 'StatefulSet' ? `${w.name}-${i}` : `${w.name}-${node.replace(/[^a-z0-9]/g, '').slice(-5)}`, labels: { 'app.kubernetes.io/instance': RELEASE, 'xaventra.ai/workload': w.name.replace(`${RELEASE}-`, '') } },
        spec: { nodeName: node },
        status: { phase: 'Running', containerStatuses: [{ name: 'xaventra', ready: true, restartCount: i }] },
    })))

    const transport: KubeTransport = async (request) => {
        calls.push(JSON.parse(JSON.stringify(request)))
        const url = new URL(`http://fake${request.path}`)
        const path = url.pathname
        if (request.method === 'GET' && path === `/api/v1/namespaces/${NS}/pods`) return respond({ items: pods() })
        if (request.method === 'GET' && path === `/api/v1/namespaces/${NS}/events`) {
            return respond({ items: [
                { type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', involvedObject: { kind: 'Pod', name: `${RELEASE}-worker-general-nodea` }, lastTimestamp: '2026-10-07T10:00:00Z', count: 3 },
                { type: 'Normal', reason: 'Scheduled', message: 'Successfully assigned', involvedObject: { kind: 'Pod', name: `${RELEASE}-main-0` }, lastTimestamp: '2026-10-07T09:00:00Z', count: 1 },
            ] })
        }
        let match = new RegExp(`^/api/v1/namespaces/${NS}/pods/([a-z0-9.-]+)/log$`).exec(path)
        if (request.method === 'GET' && match) return respond(`Zeile 1\n${secretLog}\nZeile 3`)
        match = new RegExp(`^/apis/apps/v1/namespaces/${NS}/(daemonsets|statefulsets)$`).exec(path)
        if (request.method === 'GET' && match) return respond({ items: workloads.filter(w => w.namespace === NS && kindPath(w.kind) === match![1]).map(asObject) })
        match = new RegExp(`^/apis/apps/v1/namespaces/${NS}/(daemonsets|statefulsets)/([a-z0-9-]+)$`).exec(path)
        if (match) {
            const w = workloads.find(item => item.namespace === NS && kindPath(item.kind) === match![1] && item.name === match![2])
            if (!w) return respond({ message: 'not found' }, 404)
            if (request.method === 'GET') return respond(asObject(w))
            if (request.method === 'PATCH') {
                const template = (request.body as any)?.spec?.template
                const restartedAt = template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt']
                if (restartedAt) w.restartedAt = restartedAt
                const container = template?.spec?.containers?.[0]
                if (container?.image) w.image = container.image
                if (container?.resources) w.resources = { ...w.resources, ...container.resources }
                return respond(asObject(w))
            }
        }
        if (path === `/api/v1/namespaces/${NS}/configmaps/${RELEASE}-control` && request.method === 'GET') {
            return respond({ metadata: { name: `${RELEASE}-control` }, data: { 'control.json': controlJson } })
        }
        return respond({ message: `fake: no route ${request.method} ${path}` }, 404)
    }
    return {
        calls, transport, workloads,
        workload: (name: string) => workloads.find(w => w.name === name)!,
        writes: () => calls.filter(call => call.method !== 'GET'),
    }
}
