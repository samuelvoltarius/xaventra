/**
 * Fake Kubernetes API server for tests (P19). In-memory: no cluster, no real
 * address, no real token. Records every request so tests can prove that a
 * refused action never reached the API. Only the namespace `xaventra` and the
 * release `xv` exist; a second namespace `fremd` exists to prove it is never
 * touched.
 */
import type { KubeRequest, KubeResponse, KubeTransport } from '../../src/infra/kubernetes.js'

export const NS = 'xaventra'
export const RELEASE = 'xv'
export const IMAGE = 'ghcr.io/example/xaventra:2.88.0'

export function controlPolicyRaw(overrides: Record<string, unknown> = {}) {
    return {
        schema: 1, namespace: NS, release: RELEASE, fullname: RELEASE, controlConfigMap: `${RELEASE}-control`,
        image: { repository: 'ghcr.io/example/xaventra' },
        autoscale: { tasksPerWorker: 4, cooldownSeconds: 300, idleMinutes: 15, intervalSeconds: 60 },
        workloads: {
            main: { kind: 'StatefulSet', object: `${RELEASE}-main`, container: 'xaventra', role: 'main', min: 1, max: 1, autoscale: false },
            'worker-general': { kind: 'Deployment', object: `${RELEASE}-worker-general`, container: 'xaventra', role: 'worker', min: 1, max: 4, autoscale: true },
            voice: { kind: 'Deployment', object: `${RELEASE}-voice`, container: 'xaventra', role: 'optional', min: 0, max: 1, autoscale: false },
        },
        ...overrides,
    }
}

interface Workload { kind: 'Deployment' | 'StatefulSet'; name: string; replicas: number; ready: number; image: string; resources: Record<string, any>; restartedAt?: string; namespace: string }

export function createFakeKube(options: { workerReplicas?: number } = {}) {
    const calls: KubeRequest[] = []
    const workloads: Workload[] = [
        { kind: 'StatefulSet', name: `${RELEASE}-main`, replicas: 1, ready: 1, image: IMAGE, resources: { limits: { memory: '4Gi' } }, namespace: NS },
        { kind: 'Deployment', name: `${RELEASE}-worker-general`, replicas: options.workerReplicas ?? 1, ready: options.workerReplicas ?? 1, image: IMAGE, resources: { requests: { cpu: '250m' }, limits: { cpu: '2', memory: '2Gi' } }, namespace: NS },
        { kind: 'Deployment', name: `${RELEASE}-voice`, replicas: 1, ready: 1, image: IMAGE, resources: {}, namespace: NS },
        { kind: 'Deployment', name: 'fremd-app', replicas: 3, ready: 3, image: 'example/other:1', resources: {}, namespace: 'fremd' },
    ]
    let controlJson = JSON.stringify(controlPolicyRaw())
    const secretLog = 'Bearer abc.def.ghi und OPENAI_API_KEY=sk-test-' + 'x'.repeat(40)
    const respond = (data: unknown, status = 200): KubeResponse => ({ status, data })
    const kindPath = (kind: Workload['kind']) => kind === 'Deployment' ? 'deployments' : 'statefulsets'
    const asObject = (w: Workload) => ({
        kind: w.kind, metadata: { name: w.name, namespace: w.namespace, labels: { 'app.kubernetes.io/instance': RELEASE, 'xaventra.ai/workload': w.name.replace(`${RELEASE}-`, '') } },
        spec: { replicas: w.replicas, template: { metadata: { annotations: w.restartedAt ? { 'kubectl.kubernetes.io/restartedAt': w.restartedAt } : {} }, spec: { containers: [{ name: 'xaventra', image: w.image, resources: w.resources }] } } },
        status: { replicas: w.replicas, readyReplicas: w.ready, availableReplicas: w.ready },
    })
    const pods = () => workloads.filter(w => w.namespace === NS).flatMap(w => Array.from({ length: w.replicas }, (_, i) => ({
        metadata: { name: w.kind === 'StatefulSet' ? `${w.name}-${i}` : `${w.name}-5d8f7-${'abcde'.slice(0, 4)}${i}`, labels: { 'app.kubernetes.io/instance': RELEASE, 'xaventra.ai/workload': w.name.replace(`${RELEASE}-`, '') } },
        spec: { nodeName: `node-${i % 2 ? 'b' : 'a'}` },
        status: { phase: 'Running', containerStatuses: [{ name: 'xaventra', ready: true, restartCount: i }] },
    })))

    const transport: KubeTransport = async (request) => {
        calls.push(JSON.parse(JSON.stringify(request)))
        const url = new URL(`http://fake${request.path}`)
        const path = url.pathname
        if (request.method === 'GET' && path === `/api/v1/namespaces/${NS}/pods`) return respond({ items: pods() })
        if (request.method === 'GET' && path === `/api/v1/namespaces/${NS}/events`) {
            return respond({ items: [
                { type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', involvedObject: { kind: 'Pod', name: `${RELEASE}-voice-5d8f7-abcd0` }, lastTimestamp: '2026-10-07T10:00:00Z', count: 3 },
                { type: 'Normal', reason: 'Scheduled', message: 'Successfully assigned', involvedObject: { kind: 'Pod', name: `${RELEASE}-main-0` }, lastTimestamp: '2026-10-07T09:00:00Z', count: 1 },
            ] })
        }
        let match = new RegExp(`^/api/v1/namespaces/${NS}/pods/([a-z0-9.-]+)/log$`).exec(path)
        if (request.method === 'GET' && match) return respond(`Zeile 1\n${secretLog}\nZeile 3`)
        match = new RegExp(`^/apis/apps/v1/namespaces/${NS}/(deployments|statefulsets)$`).exec(path)
        if (request.method === 'GET' && match) return respond({ items: workloads.filter(w => w.namespace === NS && kindPath(w.kind) === match![1]).map(asObject) })
        match = new RegExp(`^/apis/apps/v1/namespaces/${NS}/(deployments|statefulsets)/([a-z0-9-]+)(/scale)?$`).exec(path)
        if (match) {
            const w = workloads.find(item => item.namespace === NS && kindPath(item.kind) === match![1] && item.name === match![2])
            if (!w) return respond({ message: 'not found' }, 404)
            if (request.method === 'GET') return respond(asObject(w))
            if (request.method === 'PATCH' && match[3]) {
                const replicas = (request.body as any)?.spec?.replicas
                w.replicas = replicas; w.ready = replicas
                return respond({ spec: { replicas } })
            }
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
        if (path === `/api/v1/namespaces/${NS}/configmaps/${RELEASE}-control`) {
            if (request.method === 'GET') return respond({ metadata: { name: `${RELEASE}-control` }, data: { 'control.json': controlJson } })
            if (request.method === 'PATCH') { controlJson = (request.body as any).data['control.json']; return respond({}) }
        }
        return respond({ message: `fake: no route ${request.method} ${path}` }, 404)
    }
    return {
        calls, transport, workloads,
        workload: (name: string) => workloads.find(w => w.name === name)!,
        control: () => JSON.parse(controlJson),
        writes: () => calls.filter(call => call.method !== 'GET'),
    }
}
