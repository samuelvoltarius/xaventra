import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'
import { describe, expect, it } from 'vitest'
import { HelmLite, HelmLiteError } from '../../test/helpers/helm-lite.js'
import { parseControlPolicy } from './kubernetes.js'
import { NODE_LABEL_KEYS, detectKubernetes } from './kubernetes-node.js'

// P19: structural checks of deploy/helm/xaventra without the helm binary
// (test/helpers/helm-lite.ts renders the chart). When helm IS installed (CI
// runners), the real `helm lint` + `helm template` run as well.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CHART = join(ROOT, 'deploy/helm/xaventra')
// The repair sandbox (src/synthesis/patch-sandbox.ts) snapshots no deploy/ files;
// there the chart checks are skipped, everywhere else they run.
const CHART_PRESENT = existsSync(join(CHART, 'Chart.yaml'))
const chart = (CHART_PRESENT ? new HelmLite(CHART) : null) as HelmLite
const IDS = { workers: { general: { identitySecret: 'xv-worker-general-identity' } } }
type Obj = Record<string, any>

const byKind = (objects: Obj[], kind: string) => objects.filter(o => o.kind === kind)
const one = (objects: Obj[], kind: string, name: string) => {
    const found = objects.find(o => o.kind === kind && o.metadata?.name === name)
    if (!found) throw new Error(`${kind}/${name} fehlt: ${objects.map(o => `${o.kind}/${o.metadata?.name}`).join(', ')}`)
    return found
}
const podSpecs = (objects: Obj[]) => objects.filter(o => ['StatefulSet', 'Deployment'].includes(o.kind)).map(o => ({ name: o.metadata.name, spec: o.spec.template.spec, labels: o.spec.template.metadata.labels }))
const ALL_OPTIONAL = { workers: { voice: { enabled: true, gpus: 1, identitySecret: 'v' }, toolSandbox: { enabled: true, identitySecret: 't' }, browserComputer: { enabled: true, identitySecret: 'b' }, general: { identitySecret: 'g' } } }

if (!CHART_PRESENT) it.skip('Helm-Chart fehlt in diesem Abbild (Reparatur-Sandbox)', () => {})
else describe('Helm-Chart deploy/helm/xaventra', () => {
describe('Chart: Grundgerüst', () => {
    const objects = chart.objects({ values: IDS })

    it('renders Main as StatefulSet (1 active) and worker-general as Deployment; optional workloads only when enabled', () => {
        const main = one(objects, 'StatefulSet', 'xv-xaventra-main')
        expect(main.spec.replicas).toBe(1)
        expect(main.spec.serviceName).toBe('xv-xaventra-main-headless')
        const worker = one(objects, 'Deployment', 'xv-xaventra-worker-general')
        expect(worker.spec.template.metadata.labels['xaventra.ai/component']).toBe('worker')
        expect(byKind(objects, 'Deployment').map(o => o.metadata.name)).toEqual(['xv-xaventra-worker-general'])
        expect(byKind(objects, 'Ingress')).toEqual([])
        expect(byKind(objects, 'ResourceQuota')).toEqual([])
        const all = chart.objects({ values: ALL_OPTIONAL })
        expect(byKind(all, 'Deployment').map(o => o.metadata.name).sort()).toEqual(['xv-xaventra-browser-computer', 'xv-xaventra-tool-sandbox', 'xv-xaventra-voice', 'xv-xaventra-worker-general'])
    })

    it('keeps PVCs for state, memory and git workspaces on the Main', () => {
        const main = one(objects, 'StatefulSet', 'xv-xaventra-main')
        expect(main.spec.volumeClaimTemplates.map((v: Obj) => v.metadata.name)).toEqual(['state', 'memory', 'workspaces'])
        const mounts = main.spec.template.spec.containers[0].volumeMounts.map((m: Obj) => `${m.name}:${m.mountPath}`)
        expect(mounts).toEqual(expect.arrayContaining(['state:/runtime', 'memory:/runtime/.nova-vector-memory', 'workspaces:/runtime/.nova-data/mission-workspaces']))
    })

    it('has API, dashboard and mesh services; headless service publishes not-ready Main pods', () => {
        expect(one(objects, 'Service', 'xv-xaventra-api').spec.ports.map((p: Obj) => p.name)).toEqual(['dashboard', 'api'])
        expect(one(objects, 'Service', 'xv-xaventra-mesh').spec.ports[0].port).toBe(9091)
        const headless = one(objects, 'Service', 'xv-xaventra-main-headless')
        expect(headless.spec).toMatchObject({ clusterIP: 'None', publishNotReadyAddresses: true })
    })

    it('autoscaled workers carry no replicas field (helm upgrade never fights Xaventra)', () => {
        expect(one(objects, 'Deployment', 'xv-xaventra-worker-general').spec.replicas).toBeUndefined()
        const fixed = chart.objects({ values: { workers: { general: { autoscale: false, identitySecret: 'g', replicas: { min: 2, max: 2 } } } } })
        expect(one(fixed, 'Deployment', 'xv-xaventra-worker-general').spec.replicas).toBe(2)
        expect(() => chart.objects({ values: { workers: { general: { replicas: { min: 3, max: 2 } } } } })).toThrow(/min darf nicht größer/)
    })
})

describe('Chart: Sicherheit', () => {
    const objects = chart.objects({ values: ALL_OPTIONAL })

    it('runs every pod non-root with seccomp, every container without privileges', () => {
        for (const { name, spec } of podSpecs(objects)) {
            expect(spec.securityContext, name).toMatchObject({ runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } })
            expect(spec.enableServiceLinks, name).toBe(false)
            for (const container of spec.containers) {
                expect(container.securityContext, name).toMatchObject({ allowPrivilegeEscalation: false, privileged: false, capabilities: { drop: ['ALL'] } })
            }
        }
    })

    it('read-only root filesystem everywhere except the browser computer', () => {
        for (const { name, spec } of podSpecs(objects)) {
            const ro = spec.containers[0].securityContext.readOnlyRootFilesystem
            expect(ro, name).toBe(!name.endsWith('browser-computer'))
            if (ro) expect(spec.containers[0].volumeMounts.some((m: Obj) => m.mountPath === '/tmp'), name).toBe(true)
        }
    })

    it('sets requests and limits and all three probes on the existing health endpoints', () => {
        for (const { name, spec } of podSpecs(objects)) {
            const c = spec.containers[0]
            expect(c.resources.requests, name).toMatchObject({ cpu: expect.anything(), memory: expect.anything() })
            expect(c.resources.limits, name).toMatchObject({ cpu: expect.anything(), memory: expect.anything() })
            for (const probe of ['startupProbe', 'livenessProbe', 'readinessProbe']) {
                expect(c[probe]?.exec?.command?.[0], `${name} ${probe}`).toBe('node')
            }
            expect(c.livenessProbe.exec.command[2]).toContain("connect(9091,'127.0.0.1')")
        }
        const main = one(objects, 'StatefulSet', 'xv-xaventra-main').spec.template.spec.containers[0]
        expect(main.readinessProbe.exec.command[2]).toContain('http://127.0.0.1:18789/v1/health')
        const noApi = one(chart.objects({ values: { ...IDS, main: { api: { enabled: false } } } }), 'StatefulSet', 'xv-xaventra-main').spec.template.spec.containers[0]
        expect(noApi.readinessProbe.exec.command[2]).toContain('connect(9091')
        expect(one(objects, 'Deployment', 'xv-xaventra-voice').spec.template.spec.containers[0].resources.limits['nvidia.com/gpu']).toBe(1)
    })

    it('renders no Secret and no secret value; secrets only by reference', () => {
        const withRefs = chart.objects({ values: { ...ALL_OPTIONAL, secrets: { existingSecret: 'xv-env' }, config: { existingSecret: 'xv-config' }, ingress: { enabled: true, host: 'xaventra.example.com', tlsSecretName: 'xv-tls' } } })
        expect(byKind(withRefs, 'Secret')).toEqual([])
        const text = [...chart.render({ values: ALL_OPTIONAL }).values(), readFileSync(join(CHART, 'values.yaml'), 'utf8')].join('\n')
        for (const pattern of [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bxox[bap]-/, /\bAKIA[0-9A-Z]{16}\b/, /"(password|apiKey|token|secret)"\s*:\s*"[^"]+"/i]) {
            expect(text).not.toMatch(pattern)
        }
        for (const { name, spec } of podSpecs(withRefs)) {
            for (const env of spec.containers[0].env) {
                if (/KEY|TOKEN|SECRET|PASSW/i.test(env.name)) expect(env.value, `${name} ${env.name}`).toBeUndefined()
            }
            expect(spec.containers[0].envFrom, name).toEqual([{ secretRef: { name: 'xv-env' } }])
            expect(spec.volumes.find((v: Obj) => v.name === 'config')?.secret, name).toMatchObject({ secretName: 'xv-config' })
        }
        expect(one(withRefs, 'Ingress', 'xv-xaventra').spec.tls).toEqual([{ hosts: ['xaventra.example.com'], secretName: 'xv-tls' }])
    })

    it('RBAC: one Role in the own namespace — no secrets, no exec, no delete/create, writes only on named own objects', () => {
        const objects2 = chart.objects({ values: IDS })
        expect(byKind(objects2, 'ClusterRole')).toEqual([])
        expect(byKind(objects2, 'ClusterRoleBinding')).toEqual([])
        const role = one(objects2, 'Role', 'xv-xaventra-control')
        const resources = role.rules.flatMap((r: Obj) => r.resources)
        expect(resources).not.toContain('secrets')
        for (const forbidden of ['pods/exec', 'pods/attach', 'pods/portforward', 'pods/proxy', 'serviceaccounts/token', 'persistentvolumeclaims', 'roles', 'rolebindings', '*']) expect(resources).not.toContain(forbidden)
        for (const rule of role.rules) {
            expect(rule.verbs).not.toEqual(expect.arrayContaining(['*']))
            for (const verb of ['create', 'delete', 'deletecollection', 'update', 'escalate', 'bind', 'impersonate']) expect(rule.verbs, JSON.stringify(rule)).not.toContain(verb)
            if (rule.verbs.includes('patch')) {
                expect(Array.isArray(rule.resourceNames) && rule.resourceNames.length > 0, JSON.stringify(rule)).toBe(true)
            }
        }
        const deploymentWrite = role.rules.find((r: Obj) => r.resources.includes('deployments/scale'))
        expect(deploymentWrite.resourceNames).toEqual(['xv-xaventra-worker-general'])
        expect(one(objects2, 'RoleBinding', 'xv-xaventra-control').subjects).toEqual([{ kind: 'ServiceAccount', name: 'xv-xaventra-main', namespace: 'xaventra' }])
    })

    it('RBAC never grants an empty resourceNames list (would mean: everything)', () => {
        const none = chart.objects({ values: { workers: { general: { enabled: false } } } })
        const role = one(none, 'Role', 'xv-xaventra-control')
        expect(role.rules.some((r: Obj) => r.resources.includes('deployments/scale'))).toBe(false)
        for (const rule of role.rules) if ('resourceNames' in rule) expect(rule.resourceNames.length).toBeGreaterThan(0)
    })

    it('only the Main gets an API token, and only with control enabled', () => {
        const on = chart.objects({ values: ALL_OPTIONAL })
        for (const { name, spec } of podSpecs(on)) expect(spec.automountServiceAccountToken, name).toBe(name.endsWith('-main'))
        const off = chart.objects({ values: { ...IDS, control: { enabled: false } } })
        expect(byKind(off, 'Role')).toEqual([])
        expect(off.find(o => o.metadata?.name === 'xv-xaventra-control')).toBeUndefined()
        for (const { spec } of podSpecs(off)) expect(spec.automountServiceAccountToken).toBe(false)
    })

    it('NetworkPolicies: Main mesh only from the release, workers only from the Main, tool sandbox egress locked', () => {
        const mainPolicy = one(objects, 'NetworkPolicy', 'xv-xaventra-main')
        expect(mainPolicy.spec.ingress[0].ports).toEqual([{ port: 9091, protocol: 'TCP' }])
        expect(mainPolicy.spec.ingress[0].from).toEqual([{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'xaventra', 'app.kubernetes.io/instance': 'xv' } } }])
        const workers = one(objects, 'NetworkPolicy', 'xv-xaventra-workers')
        expect(workers.spec.ingress[0].from[0].podSelector.matchLabels['xaventra.ai/component']).toBe('main')
        const sandbox = one(objects, 'NetworkPolicy', 'xv-xaventra-tool-sandbox-egress')
        expect(sandbox.spec.policyTypes).toEqual(['Egress'])
        expect(sandbox.spec.egress.flatMap((e: Obj) => e.ports.map((p: Obj) => p.port)).sort()).toEqual([53, 53, 9091])
        const extra = chart.objects({ values: { ...IDS, networkPolicy: { meshFrom: [{ ipBlock: { cidr: '198.51.100.0/24' } }] } } })
        expect(one(extra, 'NetworkPolicy', 'xv-xaventra-main').spec.ingress[0].from[1]).toEqual({ ipBlock: { cidr: '198.51.100.0/24' } })
    })
})

describe('Chart: Main-Führung bleibt bei Xaventra', () => {
    it('warm Main candidates need Xaventra\'s own lease coordinator', () => {
        expect(() => chart.objects({ values: { ...IDS, main: { warmCandidates: 1 } } })).toThrow(/leaseCoordinator/)
        const warm = chart.objects({ values: { ...IDS, main: { warmCandidates: 2, leaseCoordinator: 'witness' } } })
        expect(one(warm, 'StatefulSet', 'xv-xaventra-main').spec.replicas).toBe(3)
    })

    it('Main eligibility is the owner\'s per-release decision; workers are never eligible', () => {
        const env = (objects: Obj[], kind: string, name: string) => Object.fromEntries(one(objects, kind, name).spec.template.spec.containers[0].env.map((e: Obj) => [e.name, e.value ?? e.valueFrom]))
        expect(env(chart.objects({ values: IDS }), 'StatefulSet', 'xv-xaventra-main').NOVA_MAIN_ELIGIBLE).toBe('true')
        expect(env(chart.objects({ values: { ...IDS, main: { mainEligible: false } } }), 'StatefulSet', 'xv-xaventra-main').NOVA_MAIN_ELIGIBLE).toBe('false')
        const worker = env(chart.objects({ values: IDS }), 'Deployment', 'xv-xaventra-worker-general')
        expect(worker).toMatchObject({ NOVA_NODE_ONLY: 'true', NOVA_MAIN_ELIGIBLE: 'false', NOVA_MESH_FAILOVER_MAIN: 'false', NOVA_TELEGRAM_MODE: 'disabled' })
    })
})

describe('Chart: Steuerung, Konfiguration, In-Cluster-Erkennung', () => {
    it('control.json is valid for the adapter and names the release namespace', () => {
        const objects = chart.objects({ values: ALL_OPTIONAL, namespace: 'kunde-a' })
        const policy = parseControlPolicy(JSON.parse(one(objects, 'ConfigMap', 'xv-xaventra-control').data['control.json']))!
        expect(policy).toMatchObject({ namespace: 'kunde-a', release: 'xv', fullname: 'xv-xaventra', controlConfigMap: 'xv-xaventra-control' })
        expect(policy.workloads.main).toMatchObject({ kind: 'StatefulSet', role: 'main', autoscale: false })
        expect(policy.workloads['worker-general']).toMatchObject({ kind: 'Deployment', object: 'xv-xaventra-worker-general', role: 'worker', min: 1, max: 4, autoscale: true })
        expect(policy.workloads.voice).toMatchObject({ role: 'optional', autoscale: false })
        expect(Object.keys(policy.workloads).sort()).toEqual(['browser-computer', 'main', 'tool-sandbox', 'voice', 'worker-general'])
    })

    it('config ConfigMap is JSON with the in-cluster mesh/dashboard/API binding', () => {
        const objects = chart.objects({ values: IDS })
        const config = JSON.parse(one(objects, 'ConfigMap', 'xv-xaventra-config').data['xaventra.config.json'])
        expect(config).toMatchObject({ mesh: { direct: { listenHost: '0.0.0.0', port: 9091 } }, dashboard: { host: '0.0.0.0' }, server: { enabled: true, host: '0.0.0.0', port: 18789 } })
        expect(chart.objects({ values: { ...IDS, config: { existingSecret: 'x' } } }).find(o => o.metadata?.name === 'xv-xaventra-config')).toBeUndefined()
    })

    it('pod env feeds the in-cluster detection (pod, namespace, node, workload, release)', () => {
        const objects = chart.objects({ values: IDS })
        for (const [kind, name, workload] of [['StatefulSet', 'xv-xaventra-main', 'main'], ['Deployment', 'xv-xaventra-worker-general', 'worker-general']]) {
            const envList = one(objects, kind, name).spec.template.spec.containers[0].env as Obj[]
            const fieldOf = (env: string) => envList.find(e => e.name === env)?.valueFrom?.fieldRef?.fieldPath
            expect(fieldOf('XAVENTRA_POD_NAME')).toBe('metadata.name')
            expect(fieldOf('NOVA_NODE_ID')).toBe('metadata.name')
            expect(fieldOf('XAVENTRA_POD_NAMESPACE')).toBe('metadata.namespace')
            expect(fieldOf('XAVENTRA_K8S_NODE_NAME')).toBe('spec.nodeName')
            // Simulate what the kubelet hands the process.
            const env: Record<string, string> = { KUBERNETES_SERVICE_HOST: '10.96.0.1', XAVENTRA_POD_NAME: `${name}-0`, XAVENTRA_POD_NAMESPACE: 'xaventra', XAVENTRA_K8S_NODE_NAME: 'node-a' }
            for (const e of envList) if (typeof e.value === 'string') env[e.name] = e.value
            expect(detectKubernetes(env, () => '')).toMatchObject({ workload, release: 'xv', namespace: 'xaventra', role: workload === 'main' ? 'main' : 'worker' })
        }
    })

    it('worker identity comes from the owner\'s Secret; without it NOTES warns', () => {
        const objects = chart.objects({ values: IDS })
        const spec = one(objects, 'Deployment', 'xv-xaventra-worker-general').spec.template.spec
        expect(spec.containers[0].env.find((e: Obj) => e.name === 'XAVENTRA_MESH_IDENTITY_FILE')?.value).toBe('/etc/xaventra/mesh-identity/identity.json')
        expect(spec.volumes.find((v: Obj) => v.name === 'mesh-identity').secret).toMatchObject({ secretName: 'xv-worker-general-identity', defaultMode: 288 })
        const notes = chart.render({}).get('NOTES.txt')!
        expect(notes).toMatch(/workers\.general\.identitySecret fehlt/)
        expect(chart.render({ values: IDS }).get('NOTES.txt')).not.toMatch(/identitySecret fehlt/)
        expect(notes).toContain('ws://xv-xaventra-main-0.xv-xaventra-main-headless.xaventra.svc.cluster.local:9091')
    })

    it('placement uses only the xaventra.ai label convention; WAN tolerations on request', () => {
        const objects = chart.objects({ values: { ...ALL_OPTIONAL, workers: { ...ALL_OPTIONAL.workers, general: { identitySecret: 'g', wanTolerations: true } } } })
        for (const { name, spec } of podSpecs(objects)) {
            const keys = [
                ...Object.keys(spec.nodeSelector || {}),
                ...(spec.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution || []).flatMap((p: Obj) => p.preference.matchExpressions.map((m: Obj) => m.key)),
            ]
            expect(keys.length, name).toBeGreaterThan(0)
            for (const key of keys) expect(NODE_LABEL_KEYS as readonly string[], `${name} ${key}`).toContain(key)
        }
        expect(one(objects, 'Deployment', 'xv-xaventra-browser-computer').spec.template.spec.nodeSelector).toEqual({ 'xaventra.ai/desktop': 'true' })
        const tolerations = one(objects, 'Deployment', 'xv-xaventra-worker-general').spec.template.spec.tolerations
        expect(tolerations).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'node.kubernetes.io/unreachable', tolerationSeconds: 900 })]))
    })
})

describe('Chart: Mandanten (Namespace pro Kunde)', () => {
    it('adds quota, limits, default-deny isolation and an optional restricted Namespace', () => {
        const objects = chart.objects({ values: { ...IDS, tenant: { enabled: true, createNamespace: true, name: 'kunde-a' } }, namespace: 'kunde-a', releaseName: 'kunde-a' })
        const ns = one(objects, 'Namespace', 'kunde-a')
        expect(ns.metadata.labels).toMatchObject({ 'pod-security.kubernetes.io/enforce': 'restricted', 'xaventra.ai/tenant': 'kunde-a' })
        expect(one(objects, 'ResourceQuota', 'kunde-a-xaventra-quota').spec.hard).toMatchObject({ 'requests.cpu': '4', 'limits.memory': '32Gi', 'services.loadbalancers': '0' })
        expect(one(objects, 'LimitRange', 'kunde-a-xaventra-limits').spec.limits[0]).toMatchObject({ type: 'Container', default: { cpu: '1' } })
        const isolation = one(objects, 'NetworkPolicy', 'kunde-a-xaventra-tenant-isolation')
        expect(isolation.spec).toEqual({ podSelector: {}, policyTypes: ['Ingress'] })
        expect(objects.filter(o => o.metadata?.namespace && o.metadata.namespace !== 'kunde-a')).toEqual([])
    })
})

describe('helm-lite selbst', () => {
    it('fails loudly on unknown functions instead of guessing', () => {
        expect(() => (chart as any).call('lookup', [], 'x')).toThrow(HelmLiteError)
    })
})

const helm = CHART_PRESENT && spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0
describe.skipIf(!helm)('echtes helm (nur wenn installiert, z. B. CI)', () => {
    it('lints and templates with the test values; output parses and matches helm-lite kinds', () => {
        const set = ['--set', 'workers.general.identitySecret=xv-worker-general-identity']
        execFileSync('helm', ['lint', CHART, ...set], { encoding: 'utf8' })
        const text = execFileSync('helm', ['template', 'xv', CHART, '--namespace', 'xaventra', ...set], { encoding: 'utf8' })
        const real = parseAllDocuments(text).map(doc => doc.toJS()).filter(Boolean).map((o: Obj) => `${o.kind}/${o.metadata.name}`).sort()
        const lite = chart.objects({ values: IDS }).map(o => `${o.kind}/${o.metadata.name}`).sort()
        expect(real).toEqual(lite)
    })
})

describe('Doku docs/KUBERNETES.md', () => {
    const doc = readFileSync(join(ROOT, 'docs/KUBERNETES.md'), 'utf8')
    it('covers the required topics', () => {
        for (const topic of [/Kubernetes entscheidet, WO/, /etcd/, /Control Plane/, /Toleranz/i, /direkte Mesh-Node/i, /GPU/, /External Secrets|Vault/, /Proxmox/, /Join-Token/, /ResourceQuota/, /\/cluster/]) expect(doc).toMatch(topic)
    })
    it('names no private hosts or addresses (public repo)', () => {
        const ips = doc.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []
        for (const ip of ips) expect(ip, ip).toMatch(/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|10\.96\.0\.1$|127\.0\.0\.1$|0\.0\.0\.0$)/)
        expect(doc).not.toMatch(/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+/)
        expect(doc).not.toMatch(/spark|gx10|ns1|ns2|alfred/i)
    })
})

it('chart directory contains only chart files', () => {
    expect(readdirSync(CHART).sort()).toEqual(['Chart.yaml', 'templates', 'values.yaml'])
    expect(existsSync(join(CHART, 'templates', 'NOTES.txt'))).toBe(true)
})
})
