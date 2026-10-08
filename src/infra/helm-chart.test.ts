import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'
import { describe, expect, it } from 'vitest'
import { HelmLite, HelmLiteError } from '../../test/helpers/helm-lite.js'
import { parseControlPolicy } from './kubernetes.js'
import { detectKubernetes } from './kubernetes-node.js'
import { validateConfig } from '../core/config-validator.js'

// P19/P21: structural checks of deploy/helm/xaventra without the helm binary
// (test/helpers/helm-lite.ts renders the chart). When helm IS installed (CI
// runners), the real `helm lint` + `helm template` run as well.
// P21 (real cluster): workers are DaemonSets on owner-labelled nodes only,
// without host network, with an own /runtime and a stable mesh id per node;
// no Main in the cluster by default; sandbox workloads only with kata-clh.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CHART = join(ROOT, 'deploy/helm/xaventra')
// The repair sandbox (src/synthesis/patch-sandbox.ts) snapshots no deploy/ files;
// there the chart checks are skipped, everywhere else they run.
const CHART_PRESENT = existsSync(join(CHART, 'Chart.yaml'))
const chart = (CHART_PRESENT ? new HelmLite(CHART) : null) as HelmLite
type Obj = Record<string, any>

const byKind = (objects: Obj[], kind: string) => objects.filter(o => o.kind === kind)
const one = (objects: Obj[], kind: string, name: string) => {
    const found = objects.find(o => o.kind === kind && o.metadata?.name === name)
    if (!found) throw new Error(`${kind}/${name} fehlt: ${objects.map(o => `${o.kind}/${o.metadata?.name}`).join(', ')}`)
    return found
}
const podSpecs = (objects: Obj[]) => objects.filter(o => ['StatefulSet', 'Deployment', 'DaemonSet'].includes(o.kind)).map(o => ({ kind: o.kind, name: o.metadata.name, spec: o.spec.template.spec, labels: o.spec.template.metadata.labels }))
const KATA = { sandbox: { runtimeClassActive: true } }
const ALL_WORKERS = { ...KATA, workers: { voice: { enabled: true, gpus: 1 }, toolSandbox: { enabled: true }, browserComputer: { enabled: true } } }
const MAIN_ON = { main: { enabled: true }, config: { existingSecret: 'xv-config' } }
const envOf = (container: Obj) => Object.fromEntries((container.env as Obj[]).map(e => [e.name, e.value ?? e.valueFrom]))
const worker = (objects: Obj[], name = 'xv-xaventra-worker-general') => one(objects, 'DaemonSet', name)

if (!CHART_PRESENT) it.skip('Helm-Chart fehlt in diesem Abbild (Reparatur-Sandbox)', () => {})
else describe('Helm-Chart deploy/helm/xaventra', () => {
describe('Chart: Worker als DaemonSet auf freigegebenen Knoten', () => {
    const objects = chart.objects({})

    it('renders only worker-general as DaemonSet by default — no Main, no Deployment, no Service, no PVC', () => {
        expect(byKind(objects, 'DaemonSet').map(o => o.metadata.name)).toEqual(['xv-xaventra-worker-general'])
        for (const kind of ['Deployment', 'StatefulSet', 'Service', 'Ingress', 'PersistentVolumeClaim', 'ResourceQuota', 'Secret']) expect(byKind(objects, kind), kind).toEqual([])
        const all = chart.objects({ values: ALL_WORKERS })
        expect(byKind(all, 'DaemonSet').map(o => o.metadata.name).sort()).toEqual(['xv-xaventra-browser-computer', 'xv-xaventra-tool-sandbox', 'xv-xaventra-voice', 'xv-xaventra-worker-general'])
        expect(byKind(all, 'Deployment')).toEqual([])
    })

    it('runs only on nodes labelled xaventra.ai/worker=true and never on nodes marked as Docker-worker nodes', () => {
        for (const { name, spec } of podSpecs(chart.objects({ values: ALL_WORKERS }))) {
            expect(spec.nodeSelector['xaventra.ai/worker'], name).toBe('true')
            expect(spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms, name)
                .toEqual([{ matchExpressions: [{ key: 'xaventra.ai/docker-worker', operator: 'DoesNotExist' }] }])
        }
        const all = chart.objects({ values: ALL_WORKERS })
        expect(worker(all, 'xv-xaventra-browser-computer').spec.template.spec.nodeSelector).toEqual({ 'xaventra.ai/worker': 'true', 'xaventra.ai/desktop': 'true' })
        expect(worker(all, 'xv-xaventra-voice').spec.template.spec.nodeSelector).toEqual({ 'xaventra.ai/worker': 'true', 'xaventra.ai/gpu': 'true' })
        expect(() => chart.objects({ values: { workerNodes: { label: '' } } })).toThrow(/workerNodes.label/)
    })

    it('never uses the host network, host PID/IPC or host ports', () => {
        for (const { name, spec } of podSpecs(chart.objects({ values: { ...ALL_WORKERS, ...MAIN_ON } }))) {
            expect(spec.hostNetwork ?? false, name).toBe(false)
            expect(spec.hostPID ?? false, name).toBe(false)
            expect(spec.hostIPC ?? false, name).toBe(false)
            for (const container of [...spec.containers, ...(spec.initContainers || [])]) {
                for (const port of container.ports || []) expect(port.hostPort, `${name} ${container.name}`).toBeUndefined()
            }
        }
    })

    it('one pod per node, never two: RollingUpdate without surge, no replicas', () => {
        const ds = worker(objects)
        expect(ds.spec.replicas).toBeUndefined()
        expect(ds.spec.updateStrategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } })
    })

    it('tolerates the WAN taint and unreachable/not-ready for 900 s', () => {
        const tolerations = worker(objects).spec.template.spec.tolerations
        expect(tolerations).toEqual(expect.arrayContaining([
            { key: 'xaventra.ai/wan', operator: 'Exists', effect: 'PreferNoSchedule' },
            { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 900 },
            { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 900 },
        ]))
    })

    it('stable mesh identity per node: NOVA_NODE_ID = <prefix>-$(spec.nodeName), defined after the node name', () => {
        const env = worker(objects).spec.template.spec.containers[0].env as Obj[]
        const nodeIndex = env.findIndex(e => e.name === 'XAVENTRA_K8S_NODE_NAME')
        const idIndex = env.findIndex(e => e.name === 'NOVA_NODE_ID')
        expect(env[nodeIndex].valueFrom.fieldRef.fieldPath).toBe('spec.nodeName')
        expect(env[idIndex].value).toBe('xv-xaventra-worker-general-$(XAVENTRA_K8S_NODE_NAME)')
        expect(nodeIndex).toBeLessThan(idIndex)
        const custom = worker(chart.objects({ values: { workers: { general: { nodeIdPrefix: 'k8s-worker', identitySecret: 'xv-id' } } } })).spec.template.spec
        expect(envOf(custom.containers[0]).NOVA_NODE_ID).toBe('k8s-worker-$(XAVENTRA_K8S_NODE_NAME)')
        expect(envOf(custom.containers[0]).XAVENTRA_MESH_IDENTITY_FILE).toBe('/etc/xaventra/mesh-identity/identity.json')
        expect(custom.volumes.find((v: Obj) => v.name === 'mesh-identity').secret).toMatchObject({ secretName: 'xv-id', defaultMode: 288 })
    })

    it('own /runtime per node: hostPath below the fixed Xaventra directory, must already exist, unique per workload', () => {
        const all = chart.objects({ values: ALL_WORKERS })
        const paths = podSpecs(all).map(({ spec }) => spec.volumes.find((v: Obj) => v.name === 'runtime').hostPath)
        for (const hostPath of paths) {
            expect(hostPath.type).toBe('Directory')
            expect(hostPath.path.startsWith('/var/lib/xaventra/')).toBe(true)
        }
        expect(new Set(paths.map(p => p.path)).size).toBe(paths.length)
        expect(worker(objects).spec.template.spec.containers[0].workingDir).toBe('/runtime')
        expect(() => chart.objects({ values: { workers: { general: { runtimeHostPath: '/etc' } } } })).toThrow(/runtimeHostPath/)
        expect(() => chart.objects({ values: { workers: { general: { runtimeHostPath: '/var/lib/xaventra/../../etc' } } } })).toThrow(/runtimeHostPath/)
        expect(() => chart.objects({ values: { workers: { voice: { enabled: true, runtimeHostPath: '/var/lib/xaventra/runtime' } } } })).toThrow(/eigenes \/runtime/)
    })

    it('worker invariants beat the env Secret (env wins over envFrom in Kubernetes)', () => {
        const spec = worker(chart.objects({ values: { secrets: { existingSecret: 'xv-env' } } })).spec.template.spec
        expect(spec.containers[0].envFrom).toEqual([{ secretRef: { name: 'xv-env' } }])
        expect(envOf(spec.containers[0])).toMatchObject({ NOVA_NODE_ONLY: 'true', NOVA_NO_TELEGRAM: 'true', NOVA_TELEGRAM_MODE: 'disabled', NOVA_MAIN_ELIGIBLE: 'false', NOVA_MESH_FAILOVER_MAIN: 'false' })
    })
})

describe('Chart: Split-Brain-Schutz auf Knoten mit Docker-Worker', () => {
    const guardOf = (objects: Obj[]) => worker(objects).spec.template.spec.initContainers?.find((c: Obj) => c.name === 'host-port-guard')

    it('an init check refuses to start when the mesh or REST port answers on the node address', () => {
        const guard = guardOf(chart.objects({}))
        expect(guard.command.slice(0, 2)).toEqual(['node', '-e'])
        expect(envOf(guard)).toMatchObject({ XAVENTRA_HOST_IP: { fieldRef: { fieldPath: 'status.hostIP' } }, XAVENTRA_GUARD_PORTS: '9091,18789' })
        expect(guard.securityContext).toMatchObject({ readOnlyRootFilesystem: true, allowPrivilegeEscalation: false })
        expect(guardOf(chart.objects({ values: { workerNodes: { hostPortGuard: { enabled: false } } } }))).toBeUndefined()
    })

    it('the guard script itself: busy port → exit 1 with a clear message, free node → exit 0, no address → exit 1', async () => {
        const script = guardOf(chart.objects({})).command[2] as string
        const run = (env: Record<string, string>, busy: number[]) => new Promise<{ code: number; out: string }>(resolve => {
            let out = ''
            const fakeNet = { connect: ({ port }: { port: number }) => {
                const handlers: Record<string, () => void> = {}
                const socket = { setTimeout: () => socket, on: (event: string, fn: () => void) => { handlers[event] = fn; return socket }, destroy: () => {} }
                setTimeout(() => (busy.includes(port) ? handlers.connect : handlers.error)?.(), 1)
                return socket
            } }
            runInNewContext(script, {
                require: (name: string) => { if (name !== 'net') throw new Error(name); return fakeNet },
                console: { log: (s: string) => { out += s }, error: (s: string) => { out += s } },
                process: { env, exit: (code: number) => resolve({ code, out }) },
            })
        })
        const base = { XAVENTRA_HOST_IP: '192.0.2.10', XAVENTRA_GUARD_PORTS: '9091,18789' }
        const busy = await run(base, [18789])
        expect(busy.code).toBe(1)
        expect(busy.out).toMatch(/18789.*Docker-Worker.*Split-Brain/)
        expect((await run(base, [])).code).toBe(0)
        expect((await run({ XAVENTRA_GUARD_PORTS: '9091' }, [])).code).toBe(1)
    })
})

describe('Chart: Sandbox nur mit kata-clh', () => {
    it('refuses sandbox workloads while the RuntimeClass is not switched on, with a clear message', () => {
        expect(() => chart.objects({ values: { workers: { toolSandbox: { enabled: true } } } })).toThrow(/kata-clh.*sandbox.runtimeClassActive=true/s)
        expect(() => chart.objects({ values: { workers: { general: { sandbox: true } } } })).toThrow(/Sandbox-Workload/)
        expect(() => chart.objects({ values: { sandbox: { runtimeClassActive: true, runtimeClassName: 'runc' }, workers: { toolSandbox: { enabled: true } } } })).toThrow(/kata-clh/)
    })

    it('with kata-clh active: runtimeClassName on sandbox workloads only, egress locked', () => {
        const objects = chart.objects({ values: ALL_WORKERS })
        for (const { name, spec } of podSpecs(objects)) {
            expect(spec.runtimeClassName, name).toBe(name.endsWith('tool-sandbox') ? 'kata-clh' : undefined)
        }
        const egress = one(objects, 'NetworkPolicy', 'xv-xaventra-tool-sandbox-egress')
        expect(egress.spec.policyTypes).toEqual(['Egress'])
        expect(egress.spec.egress.flatMap((e: Obj) => e.ports?.map((p: Obj) => p.port) || [])).toEqual([53, 53])
        const extra = chart.objects({ values: { ...ALL_WORKERS, networkPolicy: { sandboxEgressTo: [{ ipBlock: { cidr: '192.0.2.10/32' } }] } } })
        expect(one(extra, 'NetworkPolicy', 'xv-xaventra-tool-sandbox-egress').spec.egress.at(-1)).toEqual({ to: [{ ipBlock: { cidr: '192.0.2.10/32' } }] })
    })
})

describe('Chart: Sicherheit', () => {
    const objects = chart.objects({ values: { ...ALL_WORKERS, ...MAIN_ON } })

    it('runs every pod non-root with seccomp, every container without privileges', () => {
        for (const { name, spec } of podSpecs(objects)) {
            expect(spec.securityContext, name).toMatchObject({ runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: 'RuntimeDefault' } })
            expect(spec.enableServiceLinks, name).toBe(false)
            for (const container of [...spec.containers, ...(spec.initContainers || [])]) {
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

    it('sets requests, limits and all three probes; worker readiness = authenticated /v1/status with version check', () => {
        for (const { name, spec } of podSpecs(objects)) {
            const c = spec.containers[0]
            expect(c.resources.requests, name).toMatchObject({ cpu: expect.anything(), memory: expect.anything() })
            expect(c.resources.limits, name).toMatchObject({ cpu: expect.anything(), memory: expect.anything() })
            for (const probe of ['startupProbe', 'livenessProbe', 'readinessProbe']) expect(c[probe]?.exec?.command?.[0], `${name} ${probe}`).toBe('node')
            expect(c.livenessProbe.exec.command[2]).toContain("connect(9091,'127.0.0.1')")
        }
        const general = worker(objects).spec.template.spec.containers[0]
        expect(general.readinessProbe.exec.command[2]).toContain('http://127.0.0.1:18789/v1/status')
        expect(general.readinessProbe.exec.command[2]).toContain('NOVA_API_TOKEN')
        expect(envOf(general).XAVENTRA_EXPECTED_VERSION).toBe(chart.chart().appVersion)
        const pinned = worker(chart.objects({ values: { image: { tag: '2.88.3' } } })).spec.template.spec.containers[0]
        expect(envOf(pinned).XAVENTRA_EXPECTED_VERSION).toBe('2.88.3')
        const digest = worker(chart.objects({ values: { image: { digest: 'sha256:' + 'a'.repeat(64) } } })).spec.template.spec.containers[0]
        expect(digest.image).toBe(`ghcr.io/samuelvoltarius/xaventra@sha256:${'a'.repeat(64)}`)
        expect(envOf(digest).XAVENTRA_EXPECTED_VERSION).toBe('')
        const mesh = worker(chart.objects({ values: { workers: { general: { readiness: 'mesh' } } } })).spec.template.spec.containers[0]
        expect(mesh.readinessProbe.exec.command[2]).toContain('connect(9091')
        expect(worker(objects, 'xv-xaventra-voice').spec.template.spec.containers[0].resources.limits['nvidia.com/gpu']).toBe(1)
    })

    it('renders no Secret and no secret value; Secrets (env, config, CA, identity) only by reference', () => {
        const withRefs = chart.objects({ values: { ...ALL_WORKERS, secrets: { existingSecret: 'xv-env' }, config: { existingSecret: 'xv-config' }, coordinationCA: { existingSecret: 'xv-ca' } } })
        expect(byKind(withRefs, 'Secret')).toEqual([])
        const text = [...chart.render({ values: ALL_WORKERS }).values(), readFileSync(join(CHART, 'values.yaml'), 'utf8')].join('\n')
        for (const pattern of [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bxox[bap]-/, /\bAKIA[0-9A-Z]{16}\b/, /"(password|apiKey|token|secret)"\s*:\s*"[^"]+"/i]) {
            expect(text).not.toMatch(pattern)
        }
        for (const { name, spec } of podSpecs(withRefs)) {
            for (const env of spec.containers[0].env) if (/KEY|TOKEN|SECRET|PASSW/i.test(env.name)) expect(env.value, `${name} ${env.name}`).toBeUndefined()
            expect(spec.containers[0].envFrom, name).toEqual([{ secretRef: { name: 'xv-env' } }])
            expect(spec.volumes.find((v: Obj) => v.name === 'config')?.secret, name).toMatchObject({ secretName: 'xv-config' })
            expect(spec.volumes.find((v: Obj) => v.name === 'coordination-ca')?.secret, name).toMatchObject({ secretName: 'xv-ca', items: [{ key: 'ca.crt', path: 'ca.crt' }] })
            expect(spec.containers[0].volumeMounts.find((m: Obj) => m.name === 'coordination-ca'), name).toEqual({ name: 'coordination-ca', mountPath: '/run/secrets/coordination-ca.crt', subPath: 'ca.crt', readOnly: true })
            expect(envOf(spec.containers[0]).NODE_EXTRA_CA_CERTS, name).toBe('/run/secrets/coordination-ca.crt')
        }
    })

    it('RBAC: one Role in the own namespace — no secrets, no exec/attach/portforward, no delete/create, patch only on named own objects', () => {
        for (const values of [{}, ALL_WORKERS, { ...ALL_WORKERS, ...MAIN_ON }]) {
            const all = chart.objects({ values })
            expect(byKind(all, 'ClusterRole')).toEqual([])
            expect(byKind(all, 'ClusterRoleBinding')).toEqual([])
            const role = one(all, 'Role', 'xv-xaventra-control')
            const resources = role.rules.flatMap((r: Obj) => r.resources)
            for (const forbidden of ['secrets', 'pods/exec', 'pods/attach', 'pods/portforward', 'pods/proxy', 'nodes', 'nodes/proxy', 'serviceaccounts/token', 'persistentvolumeclaims', 'roles', 'rolebindings', 'deployments/scale', '*']) {
                expect(resources).not.toContain(forbidden)
            }
            for (const rule of role.rules) {
                expect(rule.apiGroups).not.toContain('*')
                expect(rule.verbs).not.toContain('*')
                for (const verb of ['create', 'delete', 'deletecollection', 'update', 'escalate', 'bind', 'impersonate']) expect(rule.verbs, JSON.stringify(rule)).not.toContain(verb)
                if (rule.verbs.includes('patch')) expect(Array.isArray(rule.resourceNames) && rule.resourceNames.length > 0, JSON.stringify(rule)).toBe(true)
            }
        }
        const role = one(chart.objects({ values: ALL_WORKERS }), 'Role', 'xv-xaventra-control')
        const patch = role.rules.filter((r: Obj) => r.verbs.includes('patch'))
        expect(patch).toHaveLength(1)
        expect(patch[0]).toMatchObject({ apiGroups: ['apps'], resources: ['daemonsets'], verbs: ['patch'] })
        expect([...patch[0].resourceNames].sort()).toEqual(['xv-xaventra-browser-computer', 'xv-xaventra-tool-sandbox', 'xv-xaventra-voice', 'xv-xaventra-worker-general'])
        expect(role.rules.find((r: Obj) => r.resources.includes('configmaps'))).toEqual({ apiGroups: [''], resources: ['configmaps'], resourceNames: ['xv-xaventra-control'], verbs: ['get'] })
        expect(one(chart.objects({}), 'RoleBinding', 'xv-xaventra-control').subjects).toEqual([{ kind: 'ServiceAccount', name: 'xv-xaventra-control', namespace: 'xaventra' }])
    })

    it('RBAC never grants an empty resourceNames list (would mean: everything)', () => {
        const none = chart.objects({ values: { workers: { general: { enabled: false } } } })
        const role = one(none, 'Role', 'xv-xaventra-control')
        expect(role.rules.some((r: Obj) => r.verbs.includes('patch'))).toBe(false)
        for (const rule of role.rules) if ('resourceNames' in rule) expect(rule.resourceNames.length).toBeGreaterThan(0)
    })

    it('workers never get an API token; an in-cluster Main uses the control account', () => {
        for (const { name, spec } of podSpecs(objects)) {
            expect(spec.automountServiceAccountToken, name).toBe(name.endsWith('-main'))
            expect(spec.serviceAccountName, name).toBe(name.endsWith('-main') ? 'xv-xaventra-control' : 'xv-xaventra-worker')
        }
        const off = chart.objects({ values: { control: { enabled: false } } })
        expect(byKind(off, 'Role')).toEqual([])
        expect(off.find(o => o.metadata?.name === 'xv-xaventra-control')).toBeUndefined()
    })

    it('NetworkPolicies: nobody reaches the workers; an in-cluster Main may reach their mesh port', () => {
        const workers = one(chart.objects({}), 'NetworkPolicy', 'xv-xaventra-workers')
        expect(workers.spec.policyTypes).toEqual(['Ingress'])
        expect(workers.spec.ingress).toEqual([])
        const withMain = chart.objects({ values: MAIN_ON })
        expect(one(withMain, 'NetworkPolicy', 'xv-xaventra-workers').spec.ingress[0].from[0].podSelector.matchLabels['xaventra.ai/component']).toBe('main')
        const mainPolicy = one(withMain, 'NetworkPolicy', 'xv-xaventra-main')
        expect(mainPolicy.spec.ingress[0].ports).toEqual([{ port: 9091, protocol: 'TCP' }])
    })
})

describe('Chart: Main bleibt außerhalb (Standard) — optional im Cluster', () => {
    it('main.enabled=false renders no Main, no Service, no PVC; the control policy names no main', () => {
        const objects = chart.objects({})
        expect(byKind(objects, 'StatefulSet')).toEqual([])
        const policy = parseControlPolicy(JSON.parse(one(objects, 'ConfigMap', 'xv-xaventra-control').data['control.json']))!
        expect(Object.keys(policy.workloads)).toEqual(['worker-general'])
        expect(policy.workloads['worker-general']).toMatchObject({ kind: 'DaemonSet', object: 'xv-xaventra-worker-general', role: 'worker' })
    })

    it('external Main: one pinned peer (public key only) in the worker config; incomplete or private keys refused', () => {
        const pub = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA' + 'A'.repeat(43) + '=\n-----END PUBLIC KEY-----\n'
        const objects = chart.objects({ values: { externalMain: { nodeId: 'main-node', url: 'ws://100.100.1.2:9091', publicKey: pub } } })
        const config = JSON.parse(one(objects, 'ConfigMap', 'xv-xaventra-config').data['xaventra.config.json'])
        expect(config.mesh.direct.peers).toEqual([{ nodeId: 'main-node', url: 'ws://100.100.1.2:9091', publicKey: pub, roles: ['system', 'worker'] }])
        expect(config).toMatchObject({ mesh: { direct: { listenHost: '0.0.0.0', port: 9091, allowInsecureLan: false } }, server: { enabled: true, host: '127.0.0.1', port: 18789 } })
        // Defaults stay untouched (deepCopy): a second render has no peer.
        expect(JSON.parse(one(chart.objects({}), 'ConfigMap', 'xv-xaventra-config').data['xaventra.config.json']).mesh.direct.peers).toEqual([])
        expect(() => chart.objects({ values: { externalMain: { nodeId: 'main-node' } } })).toThrow(/nodeId, url UND publicKey/)
        expect(() => chart.objects({ values: { externalMain: { nodeId: 'm', url: 'ws://192.0.2.10:9091', publicKey: '-----BEGIN PRIVATE KEY-----' } } })).toThrow(/PRIVATEN/)
        expect(() => chart.objects({ values: { externalMain: { nodeId: 'm', url: 'http://192.0.2.10', publicKey: pub } } })).toThrow(/ws:\/\//)
        const urlOf = (url: string) => () => chart.objects({ values: { externalMain: { nodeId: 'm', url, publicKey: pub } } })
        expect(urlOf('wss://main.example.com')).not.toThrow()
        expect(urlOf('ws://100.64.0.1:9091')).not.toThrow()
        expect(urlOf('ws://100.127.255.254:9091')).not.toThrow()
        for (const bad of ['ws://main.example.com', 'ws://main.example.com:9091', 'ws://192.0.2.10:9091', 'ws://100.128.0.1', 'ws://100.63.0.1:9091', 'ws://100.100.1.2.example.com:9091'])
            expect(urlOf(bad), bad).toThrow(/Tailscale-Adresse \(CGNAT-Bereich 100\.64\/10\)/)
    })

    it('config from the node runtime (migrated Docker worker): nothing mounted over it, no ConfigMap', () => {
        const objects = chart.objects({ values: { config: { fromRuntime: true } } })
        expect(objects.find(o => o.metadata?.name === 'xv-xaventra-config')).toBeUndefined()
        const spec = worker(objects).spec.template.spec
        expect(spec.volumes.some((v: Obj) => v.name === 'config')).toBe(false)
        expect(spec.containers[0].volumeMounts.some((m: Obj) => m.name === 'config')).toBe(false)
    })

    it('in-cluster Main only on request, with its own full config; warm candidates need Xaventra\'s lease coordinator', () => {
        expect(() => chart.objects({ values: { main: { enabled: true } } })).toThrow(/vollständige eigene Konfiguration/)
        const objects = chart.objects({ values: MAIN_ON })
        const main = one(objects, 'StatefulSet', 'xv-xaventra-main')
        expect(main.spec.replicas).toBe(1)
        expect(envOf(main.spec.template.spec.containers[0])).toMatchObject({ NOVA_MAIN_ELIGIBLE: 'true', NOVA_NODE_ID: '$(XAVENTRA_POD_NAME)' })
        expect(one(objects, 'Service', 'xv-xaventra-api').spec.ports.map((p: Obj) => p.name)).toEqual(['dashboard', 'api'])
        const policy = parseControlPolicy(JSON.parse(one(objects, 'ConfigMap', 'xv-xaventra-control').data['control.json']))!
        expect(policy.workloads.main).toMatchObject({ kind: 'StatefulSet', role: 'main' })
        expect(one(objects, 'Role', 'xv-xaventra-control').rules).toEqual(expect.arrayContaining([{ apiGroups: ['apps'], resources: ['statefulsets'], resourceNames: ['xv-xaventra-main'], verbs: ['patch'] }]))
        expect(() => chart.objects({ values: { ...MAIN_ON, main: { enabled: true, warmCandidates: 1 } } })).toThrow(/leaseCoordinator/)
        expect(() => chart.objects({ values: { ingress: { enabled: true, host: 'xaventra.example.com' } } })).toThrow(/main.enabled/)
    })
})

describe('Chart: Steuerung und In-Cluster-Erkennung', () => {
    it('control.json is valid for the adapter and names the release namespace', () => {
        const objects = chart.objects({ values: ALL_WORKERS, namespace: 'kunde-a' })
        const policy = parseControlPolicy(JSON.parse(one(objects, 'ConfigMap', 'xv-xaventra-control').data['control.json']))!
        expect(policy).toMatchObject({ namespace: 'kunde-a', release: 'xv', fullname: 'xv-xaventra', controlConfigMap: 'xv-xaventra-control', workerNodeLabel: 'xaventra.ai/worker' })
        expect(Object.keys(policy.workloads).sort()).toEqual(['browser-computer', 'tool-sandbox', 'voice', 'worker-general'])
        expect(policy.workloads.voice).toMatchObject({ kind: 'DaemonSet', role: 'optional' })
    })

    it('pod env feeds the in-cluster detection (pod, namespace, node, workload, release)', () => {
        const envList = worker(chart.objects({})).spec.template.spec.containers[0].env as Obj[]
        const env: Record<string, string> = { KUBERNETES_SERVICE_HOST: '10.96.0.1', XAVENTRA_POD_NAME: 'xv-xaventra-worker-general-abcde', XAVENTRA_POD_NAMESPACE: 'xaventra', XAVENTRA_K8S_NODE_NAME: 'node-a' }
        for (const e of envList) if (typeof e.value === 'string') env[e.name] = e.value
        expect(detectKubernetes(env, () => '')).toMatchObject({ workload: 'worker-general', release: 'xv', namespace: 'xaventra', node: 'node-a', role: 'worker' })
    })

    it('NOTES explain node release, per-node identity and the missing env Secret', () => {
        const notes = chart.render({}).get('NOTES.txt')!
        expect(notes).toContain('xaventra.ai/worker=true')
        expect(notes).toContain('xv-xaventra-worker-general-<Knotenname>')
        expect(notes).toMatch(/secrets.existingSecret fehlt/)
        expect(chart.render({ values: { secrets: { existingSecret: 'x' }, workers: { general: { identitySecret: 'y' } } } }).get('NOTES.txt')).not.toMatch(/fehlt|kein identitySecret/)
    })
})

describe('Chart: Mandanten (Namespace pro Kunde)', () => {
    it('adds quota, limits, default-deny isolation and an optional namespace (privileged only for the hostPath, audit restricted)', () => {
        const objects = chart.objects({ values: { tenant: { enabled: true, createNamespace: true, name: 'kunde-a' } }, namespace: 'kunde-a', releaseName: 'kunde-a' })
        const ns = one(objects, 'Namespace', 'kunde-a')
        expect(ns.metadata.labels).toMatchObject({ 'pod-security.kubernetes.io/enforce': 'privileged', 'pod-security.kubernetes.io/audit': 'restricted', 'xaventra.ai/tenant': 'kunde-a' })
        expect(one(objects, 'ResourceQuota', 'kunde-a-xaventra-quota').spec.hard).toMatchObject({ 'requests.cpu': '4', 'limits.memory': '32Gi', 'services.loadbalancers': '0' })
        expect(one(objects, 'LimitRange', 'kunde-a-xaventra-limits').spec.limits[0]).toMatchObject({ type: 'Container', default: { cpu: '1' } })
        expect(one(objects, 'NetworkPolicy', 'kunde-a-xaventra-tenant-isolation').spec).toEqual({ podSelector: {}, policyTypes: ['Ingress'] })
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
    it('lints and templates; output parses and matches helm-lite kinds', () => {
        execFileSync('helm', ['lint', CHART], { encoding: 'utf8' })
        for (const set of [[], ['--set', 'sandbox.runtimeClassActive=true', '--set', 'workers.toolSandbox.enabled=true', '--set', 'workers.voice.enabled=true']]) {
            const text = execFileSync('helm', ['template', 'xv', CHART, '--namespace', 'xaventra', ...set], { encoding: 'utf8' })
            const real = parseAllDocuments(text).map(doc => doc.toJS()).filter(Boolean).map((o: Obj) => `${o.kind}/${o.metadata.name}`).sort()
            const values = set.length ? { sandbox: { runtimeClassActive: true }, workers: { toolSandbox: { enabled: true }, voice: { enabled: true } } } : {}
            const lite = chart.objects({ values }).map(o => `${o.kind}/${o.metadata.name}`).sort()
            expect(real).toEqual(lite)
        }
        const refused = spawnSync('helm', ['template', 'xv', CHART, '--set', 'workers.toolSandbox.enabled=true'], { encoding: 'utf8' })
        expect(refused.status).not.toBe(0)
        expect(refused.stderr).toMatch(/kata-clh/)
    })
})

describe('Chart: echtes Image und gültige Konfiguration (P22)', () => {
    const configOf = (objects: Obj[]) => JSON.parse(one(objects, 'ConfigMap', 'xv-xaventra-config').data['xaventra.config.json'])
    const validate = (config: Obj) => {
        const dir = mkdtempSync(join(tmpdir(), 'xv-config-'))
        const saved = process.env.NOVA_NODE_ONLY
        try {
            const file = join(dir, 'xaventra.config.json')
            writeFileSync(file, JSON.stringify(config))
            process.env.NOVA_NODE_ONLY = 'true'
            return validateConfig(file)
        } finally {
            if (saved === undefined) delete process.env.NOVA_NODE_ONLY; else process.env.NOVA_NODE_ONLY = saved
            rmSync(dir, { recursive: true, force: true })
        }
    }

    it('the default rendered worker config passes the real config validator (provider, name, model)', () => {
        const config = configOf(chart.objects({}))
        expect(config).toMatchObject({ name: expect.any(String), provider: expect.any(String), model: expect.any(String) })
        const result = validate(config)
        expect(result.errors).toEqual([])
        expect(result.valid).toBe(true)
        // the former pilot config (mesh + server only) is exactly what the daemon refused
        expect(validate({ mesh: config.mesh, server: config.server }).errors.join()).toMatch(/provider fehlt/)
    })

    it('provider and model can be set through values; the external Main peer is still added', () => {
        const config = configOf(chart.objects({ values: { config: { values: { provider: 'ollama', model: 'llama3.1' } }, externalMain: { nodeId: 'main-1', url: 'wss://main.example.com', publicKey: ['-----BEGIN PUBLIC KEY-----', 'abc', '-----END PUBLIC KEY-----'].join(String.fromCharCode(10)) } } }))
        expect(config).toMatchObject({ provider: 'ollama', model: 'llama3.1' })
        expect(config.mesh.direct.peers).toHaveLength(1)
        expect(validate(config).valid).toBe(true)
    })

    it('config.existingSecret mounts the whole config from the Secret and renders no ConfigMap config', () => {
        const objects = chart.objects({ values: { config: { existingSecret: 'xv-config' } } })
        expect(objects.some(o => o.kind === 'ConfigMap' && o.metadata.name === 'xv-xaventra-config')).toBe(false)
        const spec = worker(objects).spec.template.spec
        expect(spec.volumes.find((v: Obj) => v.name === 'config').secret).toMatchObject({ secretName: 'xv-config' })
    })

    it('command, workingDir and mounts match the real image layout (deploy/update/Dockerfile)', () => {
        const dockerfile = readFileSync(join(ROOT, 'deploy/update/Dockerfile'), 'utf8')
        const entrypoint = JSON.parse(/^ENTRYPOINT (\[.*\])$/m.exec(dockerfile)![1]) as string[]
        const workdir = [...dockerfile.matchAll(/^WORKDIR (\S+)$/gm)].map(m => m[1])
        const app = workdir[0]
        const runtime = workdir[workdir.length - 1]
        expect(entrypoint).toEqual(['node', `${app}/dist/daemon.js`])
        const container = worker(chart.objects({ values: ALL_WORKERS })).spec.template.spec.containers[0]
        // The image's own entrypoint starts the daemon; the chart must not replace it with something else.
        expect(container.command).toBeUndefined()
        expect(container.args).toBeUndefined()
        expect(container.workingDir).toBe(runtime)
        for (const w of podSpecs(chart.objects({ values: ALL_WORKERS }))) {
            for (const m of w.spec.containers[0].volumeMounts as Obj[]) {
                // no mount may hide the application directory (dist/, node_modules)
                expect(m.mountPath === app || m.mountPath.startsWith(`${app}/`) || app.startsWith(`${m.mountPath}/`) || m.mountPath === '/', `${w.name}:${m.mountPath}`).toBe(false)
            }
            expect(w.spec.containers[0].volumeMounts.find((m: Obj) => m.name === 'runtime').mountPath).toBe(runtime)
        }
    })

    it('the daemon reads version and dist/ from the installation, not from the cwd (/runtime in the container)', () => {
        const daemon = readFileSync(join(ROOT, 'src/daemon.ts'), 'utf8')
        expect(daemon).not.toMatch(/join\(process\.cwd\(\),\s*'package\.json'\)/)
        expect(daemon).not.toMatch(/join\(process\.cwd\(\),\s*'dist',\s*'daemon\.js'\)/)
        expect(daemon).toMatch(/fileURLToPath\(import\.meta\.url\)/)
    })

    it('an image digest wins over the tag, a per-workload digest wins over the root one; version check only with an explicit version', () => {
        const d1 = `sha256:${'a'.repeat(64)}`
        const d2 = `sha256:${'b'.repeat(64)}`
        const container = (values: Obj, name?: string) => worker(chart.objects({ values }), name).spec.template.spec.containers[0]
        expect(container({ image: { tag: '2.89.0', digest: d1 } }).image).toBe(`ghcr.io/samuelvoltarius/xaventra@${d1}`)
        expect(envOf(container({ image: { digest: d1 } })).XAVENTRA_EXPECTED_VERSION).toBe('')
        expect(envOf(container({ image: { digest: d1, version: '2.89.0' } })).XAVENTRA_EXPECTED_VERSION).toBe('2.89.0')
        const mixed = chart.objects({ values: { image: { digest: d1 }, workers: { voice: { enabled: true, image: { digest: d2 } } } } })
        expect(worker(mixed).spec.template.spec.containers[0].image).toContain(d1)
        expect(worker(mixed, 'xv-xaventra-voice').spec.template.spec.containers[0].image).toContain(d2)
    })

    it('worker-general requires no extra node label by default (only xaventra.ai/worker)', () => {
        expect(worker(chart.objects({})).spec.template.spec.nodeSelector).toEqual({ 'xaventra.ai/worker': 'true' })
    })
})

describe('Doku docs/KUBERNETES.md', () => {
    const doc = readFileSync(join(ROOT, 'docs/KUBERNETES.md'), 'utf8')
    it('covers the required topics', () => {
        for (const topic of [/Kubernetes entscheidet, WO/, /etcd/, /Control Plane/, /Toleranz/i, /direkte Mesh-Node/i, /GPU/, /External Secrets|Vault/, /Proxmox/, /Join-Token/, /ResourceQuota/, /\/cluster/,
            /DaemonSet/, /hostNetwork/, /xaventra\.ai\/worker=true/, /Split-Brain/, /kata-clh/, /per Pipe/i, /Rückweg/, /nie direkt auf/i, /Auto-Skalierung/, /container\.json/, /image\.digest/, /provider fehlt/]) expect(doc).toMatch(topic)
    })
    it('names no private hosts or addresses (public repo)', () => {
        const ips = doc.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []
        for (const ip of ips) expect(ip, ip).toMatch(/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|10\.96\.0\.1$|127\.0\.0\.1$|0\.0\.0\.0$)/)
        expect(doc).not.toMatch(/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+/)
        expect(doc).not.toMatch(/spark|gx10|ns1|ns2|alfred|\.ts\.net/i)
    })
})

it('chart and its values name no private hosts or addresses (public repo)', () => {
    const files = [join(CHART, 'Chart.yaml'), join(CHART, 'values.yaml'), ...readdirSync(join(CHART, 'templates')).map(name => join(CHART, 'templates', name))]
    for (const file of files) {
        const text = readFileSync(file, 'utf8')
        expect(text, file).not.toMatch(/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+/)
        expect(text, file).not.toMatch(/spark|gx10|ns1|ns2|alfred|\.ts\.net/i)
        for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []) expect(ip, `${file} ${ip}`).toMatch(/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|127\.0\.0\.1$|0\.0\.0\.0$)/)
    }
})

it('chart directory contains only chart files', () => {
    expect(readdirSync(CHART).sort()).toEqual(['Chart.yaml', 'templates', 'values.yaml'])
    expect(existsSync(join(CHART, 'templates', 'NOTES.txt'))).toBe(true)
})
})
