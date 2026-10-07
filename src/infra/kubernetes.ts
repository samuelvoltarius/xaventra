/**
 * Kubernetes-Adapter (2.88, Paket P19) — narrow like src/infra/proxmox.ts.
 *
 * Grundsatz: Kubernetes decides WHERE a process runs; Xaventra decides WHAT
 * runs. Kubernetes never replaces the Xaventra mesh, its lease, witness epoch
 * or fencing.
 *
 * Fixed rules (code, not config):
 * - Never raw kubectl (stays on the Nie-Liste, src/install/never-list.ts).
 *   This adapter talks to the Kubernetes API directly with the pod's own
 *   ServiceAccount (in-cluster) or an explicitly configured own account
 *   (server + CA file + token file). No kubeconfig exec plugins.
 * - Only the OWN namespace and only objects of the OWN release (the chart's
 *   control file names them). Every request passes `checkKubeRequest` BEFORE
 *   the transport: foreign namespaces, cluster-scoped paths, Secrets,
 *   pods/exec|attach|portforward|proxy, tokens, RBAC, PVCs, DELETE and POST are
 *   refused without a request.
 * - Actions:
 *     lesen                 status, events, logs (bounded, redacted)
 *     skalieren             own worker Deployment within min/max   — no card
 *     neu starten           rollout restart of an own worker        — no card
 *                           Main / optional workloads               — card
 *     Chart-Update          fixed value paths, diff preview         — card
 *     abschalten/entfernen  only as part of a chart update          — card
 * - The token never reaches a log, an error text, a card or a thought.
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { resolveConfigPath } from '../config/config-path.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { SERVICE_ACCOUNT_DIR, detectKubernetes } from './kubernetes-node.js'

export const DEFAULT_CONTROL_FILE = '/etc/xaventra/cluster/control.json'
export const RESTARTED_AT_ANNOTATION = 'kubectl.kubernetes.io/restartedAt'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_LOG_LINES = 500
const MAX_REPLICAS = 20

/** Documented, refused, and without any code path. */
export const KUBERNETES_NEVER: readonly string[] = Object.freeze([
    'rohes kubectl (Nie-Liste) — nur feste Aktionen über die API',
    'fremde Namespaces und cluster-weite Objekte (Nodes, Namespaces, RBAC)',
    'Secrets lesen, auflisten oder ändern; Tokens anfordern',
    'pods/exec, attach, portforward, proxy',
    'PersistentVolumeClaims, Daten oder Namespaces löschen',
    'die Main über Kubernetes skalieren oder abschalten (Führung nur über Xaventras Lease/Witness/Fencing)',
])

// ---------------------------------------------------------------------------
// Control policy (rendered by the Helm chart into ConfigMap <fullname>-control)
// ---------------------------------------------------------------------------

export type WorkloadRole = 'main' | 'worker' | 'optional'
export interface ControlWorkload {
    name: string
    kind: 'Deployment' | 'StatefulSet'
    object: string
    container: string
    role: WorkloadRole
    min: number
    max: number
    autoscale: boolean
}
export interface AutoscaleSettings { tasksPerWorker: number; cooldownSeconds: number; idleMinutes: number; intervalSeconds: number }
export interface ControlPolicy {
    namespace: string
    release: string
    fullname: string
    controlConfigMap: string
    imageRepository: string
    autoscale: AutoscaleSettings
    workloads: Record<string, ControlWorkload>
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DNS_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const IMAGE_REPO = /^[a-z0-9][a-z0-9._/-]{0,200}[a-z0-9](?::[0-9]{1,5}(?=\/))?(?:\/[a-z0-9._-]+)*$/
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const QUANTITY = /^[0-9]{1,6}(?:\.[0-9]{1,3})?(?:m|k|M|G|T|Ki|Mi|Gi|Ti)?$/

const int = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
}

export function parseControlPolicy(raw: unknown): ControlPolicy | null {
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, any>
    if (value.schema !== 1) return null
    const namespace = String(value.namespace ?? '')
    const release = String(value.release ?? '')
    const fullname = String(value.fullname ?? release)
    const controlConfigMap = String(value.controlConfigMap ?? `${fullname}-control`)
    if (!DNS_LABEL.test(namespace) || !DNS_LABEL.test(release) || !DNS_SUBDOMAIN.test(fullname) || !DNS_SUBDOMAIN.test(controlConfigMap)) return null
    const imageRepository = String(value.image?.repository ?? '')
    const workloads: Record<string, ControlWorkload> = {}
    for (const [name, item] of Object.entries((value.workloads && typeof value.workloads === 'object') ? value.workloads : {})) {
        const w = item as Record<string, any>
        if (!DNS_LABEL.test(name) || (w?.kind !== 'Deployment' && w?.kind !== 'StatefulSet')) continue
        const object = String(w.object ?? '')
        const container = String(w.container ?? 'xaventra')
        if (!DNS_SUBDOMAIN.test(object) || !DNS_LABEL.test(container)) continue
        const role: WorkloadRole = w.role === 'main' ? 'main' : w.role === 'optional' ? 'optional' : 'worker'
        if (role === 'main' && w.kind !== 'StatefulSet') continue
        if (Number(w.min) > Number(w.max)) continue
        const min = int(w.min, 0, MAX_REPLICAS, 0)
        const max = int(w.max, min, MAX_REPLICAS, min)
        workloads[name] = { name, kind: w.kind, object, container, role, min, max, autoscale: role === 'worker' && w.kind === 'Deployment' && w.autoscale === true }
    }
    const a = value.autoscale || {}
    return {
        namespace, release, fullname, controlConfigMap,
        imageRepository: IMAGE_REPO.test(imageRepository) ? imageRepository : '',
        autoscale: {
            tasksPerWorker: int(a.tasksPerWorker, 1, 100, 4), cooldownSeconds: int(a.cooldownSeconds, 30, 86_400, 300),
            idleMinutes: int(a.idleMinutes, 1, 1440, 15), intervalSeconds: int(a.intervalSeconds, 15, 3600, 60),
        },
        workloads,
    }
}

/** The policy as the chart's control.json (written back after a chart update). */
export function serializeControlPolicy(policy: ControlPolicy, applied: unknown[] = []): string {
    return JSON.stringify({
        schema: 1, namespace: policy.namespace, release: policy.release, fullname: policy.fullname, controlConfigMap: policy.controlConfigMap,
        image: { repository: policy.imageRepository }, autoscale: policy.autoscale,
        workloads: Object.fromEntries(Object.values(policy.workloads).map(w => [w.name, { kind: w.kind, object: w.object, container: w.container, role: w.role, min: w.min, max: w.max, autoscale: w.autoscale }])),
        ...(applied.length ? { applied: applied.slice(-20) } : {}),
    }, null, 2)
}

// ---------------------------------------------------------------------------
// Request guard — runs before every transport call
// ---------------------------------------------------------------------------

export interface KubeRequest {
    method: 'GET' | 'PATCH' | 'POST' | 'PUT' | 'DELETE'
    path: string
    body?: unknown
    contentType?: 'application/merge-patch+json' | 'application/strategic-merge-patch+json'
}
export interface KubeResponse { status: number; data: any }
export type KubeTransport = (request: KubeRequest) => Promise<KubeResponse>

export class KubeRequestRefused extends Error {
    constructor(reason: string) { super(`Kubernetes: abgelehnt — ${reason}`); this.name = 'KubeRequestRefused' }
}

const ALLOWED_QUERY = new Set(['labelSelector', 'limit', 'tailLines', 'container', 'fieldSelector'])
const FORBIDDEN_SEGMENTS: Array<[RegExp, string]> = [
    [/^secrets?$/i, 'Secrets sind tabu'],
    [/^(exec|attach|portforward|proxy)$/i, 'exec/attach/portforward/proxy sind tabu'],
    [/^token$/i, 'Tokens werden nie angefordert'],
    [/^(persistentvolumeclaims|persistentvolumes)$/i, 'Speicher/PVCs sind tabu'],
]

/** null = allowed; otherwise the refusal reason (no request is sent). */
export function checkKubeRequest(request: KubeRequest, policy: ControlPolicy): string | null {
    const raw = String(request?.path ?? '')
    const rawPath = raw.split('?')[0]
    // No percent-encoding, backslashes, empty segments or dot segments in the path.
    if (!raw.startsWith('/') || /[%\\]|\/\/|\/\.\.?(?:\/|$)/.test(rawPath)) return 'ungültiger Pfad'
    let url: URL
    try { url = new URL(`http://guard${raw}`) } catch { return 'ungültiger Pfad' }
    if (url.pathname !== rawPath) return 'ungültiger Pfad'
    const segments = url.pathname.split('/').filter(Boolean)
    for (const segment of segments) for (const [pattern, why] of FORBIDDEN_SEGMENTS) if (pattern.test(segment)) return why
    for (const key of url.searchParams.keys()) if (!ALLOWED_QUERY.has(key)) return `Parameter ${key} nicht erlaubt`
    if (request.method !== 'GET' && url.search) return 'Schreiben ohne Query-Parameter'

    // /api/v1/namespaces/<ns>/<resource>[/<name>[/<sub>]]  or  /apis/<group>/<version>/namespaces/<ns>/...
    let rest: string[]
    let group: string
    if (segments[0] === 'api' && segments[1] === 'v1') { group = 'core'; rest = segments.slice(2) }
    else if (segments[0] === 'apis' && segments.length >= 3) { group = segments[1]; rest = segments.slice(3); if (segments[2] !== 'v1') return 'API-Version nicht erlaubt' }
    else return 'Pfad nicht erlaubt'
    if (rest[0] !== 'namespaces' || rest.length < 3) return 'cluster-weite Objekte sind tabu'
    if (rest[1] !== policy.namespace) return `fremder Namespace (${rest[1]}) ist tabu`
    const [resource, name, sub, ...extra] = rest.slice(2)
    if (extra.length) return 'Pfad nicht erlaubt'
    if (name !== undefined && !DNS_SUBDOMAIN.test(name)) return 'ungültiger Objektname'
    const own = new Set(Object.values(policy.workloads).map(w => w.object))
    const method = request.method

    if (group === 'core' && resource === 'pods') {
        if (method !== 'GET') return 'Pods werden nie gelöscht oder geändert'
        if (name === undefined && sub === undefined) return null
        if (sub === undefined || sub === 'log') return null
        return 'Pod-Unterressource nicht erlaubt'
    }
    if (group === 'core' && resource === 'events') return method === 'GET' && name === undefined ? null : 'Events nur lesen'
    if (group === 'events.k8s.io' && resource === 'events') return method === 'GET' && name === undefined ? null : 'Events nur lesen'
    if (group === 'core' && resource === 'configmaps') {
        if (name !== policy.controlConfigMap) return 'nur die eigene Steuer-ConfigMap'
        if (sub !== undefined) return 'Pfad nicht erlaubt'
        return method === 'GET' || method === 'PATCH' ? null : 'ConfigMap nur lesen/patchen'
    }
    if (group === 'apps' && (resource === 'deployments' || resource === 'statefulsets' || resource === 'replicasets')) {
        if (method === 'GET') return sub === undefined || (sub === 'scale' && resource === 'deployments') ? null : 'Pfad nicht erlaubt'
        if (method !== 'PATCH') return 'nur lesen oder patchen — nie anlegen/löschen'
        if (resource === 'replicasets') return 'ReplicaSets nur lesen'
        if (!name || !own.has(name)) return 'nur eigene Workloads dieses Release'
        const workload = Object.values(policy.workloads).find(w => w.object === name)!
        if ((resource === 'deployments') !== (workload.kind === 'Deployment')) return 'Art passt nicht'
        if (sub === 'scale') return workload.role !== 'main' && resource === 'deployments' ? null : 'die Main wird nie über Kubernetes skaliert'
        return sub === undefined ? null : 'Pfad nicht erlaubt'
    }
    if (group === 'coordination.k8s.io' && resource === 'leases') return method === 'GET' ? null : 'Leases nur lesen (Führung macht Xaventra)'
    return `Ressource ${resource || '?'} nicht erlaubt`
}

// ---------------------------------------------------------------------------
// Transport: TLS against the cluster CA, bearer token re-read per request
// ---------------------------------------------------------------------------

export function createKubeTransport(options: { server: string; caPem: string; tokenFile: string; timeoutMs?: number; readFile?: (path: string) => string }): KubeTransport {
    const base = new URL(options.server)
    if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Kubernetes-API nur über https ohne Zugangsdaten in der URL')
    const host = base.hostname.replace(/^\[|\]$/g, '')
    const port = Number(base.port || 443)
    const timeoutMs = options.timeoutMs ?? 15_000
    const read = options.readFile || ((path: string) => readFileSync(path, 'utf8'))
    return (req: KubeRequest) => new Promise<KubeResponse>((resolve, reject) => {
        let token = ''
        // Projected tokens rotate: read it for every request, keep it out of every message.
        try { token = read(options.tokenFile).trim() } catch { reject(new Error('Kubernetes: Token-Datei nicht lesbar')); return }
        if (!token) { reject(new Error('Kubernetes: Token-Datei ist leer')); return }
        const scrub = (text: string) => redactSecrets(text.split(token).join('[REDACTED]'))
        const body = req.body === undefined ? undefined : JSON.stringify(req.body)
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
        if (body !== undefined) {
            headers['Content-Type'] = req.contentType || 'application/merge-patch+json'
            headers['Content-Length'] = String(Buffer.byteLength(body))
        }
        const request = httpsRequest({ host, port, method: req.method, path: req.path, headers, ca: options.caPem, servername: host, rejectUnauthorized: true }, response => {
            const chunks: Buffer[] = []
            let size = 0
            response.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > MAX_RESPONSE_BYTES) { request.destroy(new Error('Kubernetes-Antwort zu groß')); return }
                chunks.push(chunk)
            })
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                let parsed: unknown = text
                if (/json/i.test(String(response.headers['content-type'] || ''))) { try { parsed = JSON.parse(text || 'null') } catch { parsed = null } }
                resolve({ status: response.statusCode || 0, data: parsed })
            })
            response.on('error', error => reject(new Error(scrub(`Kubernetes: ${String(error?.message || error)}`).slice(0, 200))))
        })
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Kubernetes: Zeitüberschreitung')))
        request.on('error', error => reject(new Error(scrub(`Kubernetes nicht erreichbar: ${String(error?.message || error)}`).slice(0, 200))))
        if (body !== undefined) request.write(body)
        request.end()
    })
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface KubeActionResult { ok: boolean; message: string; requested: boolean; needsCard?: boolean }
export interface WorkloadStatus { name: string; kind: string; object: string; role: WorkloadRole; desired: number; ready: number; available: number; image: string; min: number; max: number; autoscale: boolean; found: boolean }
export interface PodStatus { name: string; workload: string; phase: string; ready: boolean; restarts: number; node: string }
export interface ClusterEvent { type: string; reason: string; message: string; object: string; at: string; count: number }
export interface ClusterStatus { namespace: string; release: string; workloads: WorkloadStatus[]; pods: PodStatus[] }

export interface ChartChange { path: string; value: string }
export interface ChartPlan {
    id: string
    changes: ChartChange[]
    lines: string[]
    /** Workloads this update switches off (shown as ENTFERNT on the card). */
    removes: string[]
    /** Hash of the live state the preview was computed from. */
    beforeHash: string
}

const text = (value: unknown, max = 160): string => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, max)
const safeNum = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0 }

/** Whitelisted chart value paths. Parsed from "key=value key=value". */
export function parseChartChanges(input: string): ChartChange[] | string {
    const parts = String(input || '').trim().split(/\s+/).filter(Boolean)
    if (!parts.length) return 'Keine Änderung angegeben (z. B. image.tag=2.88.1).'
    const out: ChartChange[] = []
    for (const part of parts) {
        const match = /^([a-z0-9.-]{1,120})=([^\s]{1,128})$/.exec(part)
        if (!match) return `„${text(part, 60)}“: Format ist schluessel=wert.`
        const [, path, value] = match
        if (path === 'image.tag') {
            if (!IMAGE_TAG.test(value)) return 'image.tag: ungültiger Tag.'
        } else {
            const field = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(min|max|enabled|resources\.(?:requests|limits)\.(?:cpu|memory))$/.exec(path)
            if (!field) return `„${path}“ darf Xaventra nicht ändern (erlaubt: image.tag, <workload>.min|max|enabled, <workload>.resources.requests|limits.cpu|memory).`
            const [, workload, key] = field
            if (workload === 'main' && !key.startsWith('resources.')) return 'Die Main wird nie über das Chart skaliert oder abgeschaltet.'
            if ((key === 'min' || key === 'max') && !/^\d{1,2}$/.test(value)) return `${path}: Zahl 0–${MAX_REPLICAS}.`
            if ((key === 'min' || key === 'max') && Number(value) > MAX_REPLICAS) return `${path}: höchstens ${MAX_REPLICAS}.`
            if (key === 'enabled' && value !== 'true' && value !== 'false') return `${path}: true oder false.`
            if (key.startsWith('resources.') && !QUANTITY.test(value)) return `${path}: ungültige Menge (z. B. 500m, 2, 4Gi).`
        }
        out.push({ path, value })
    }
    return out
}

export interface KubernetesClientOptions {
    policy: ControlPolicy
    transport: KubeTransport
    log?: (line: string) => void
    now?: () => number
}

export class KubernetesClient {
    readonly policy: ControlPolicy
    private readonly transport: KubeTransport
    private readonly log: (line: string) => void
    private readonly now: () => number

    constructor(options: KubernetesClientOptions) {
        this.policy = options.policy
        this.transport = options.transport
        this.log = options.log || (() => {})
        this.now = options.now || Date.now
    }

    /** Every API call goes through here: guard first, then the transport. */
    async request(request: KubeRequest): Promise<KubeResponse> {
        const refused = checkKubeRequest(request, this.policy)
        if (refused) throw new KubeRequestRefused(refused)
        const response = await this.transport(request)
        if (response.status >= 400) {
            const message = typeof response.data === 'object' && response.data ? (response.data as any).message : response.data
            throw new Error(`Kubernetes ${response.status}: ${text(redactSecrets(String(message ?? '')), 160)}`)
        }
        return response
    }

    private nsPath(group: 'core' | 'apps', resource: string, name?: string, sub?: string): string {
        const base = group === 'core' ? `/api/v1/namespaces/${this.policy.namespace}` : `/apis/apps/v1/namespaces/${this.policy.namespace}`
        return [base, resource, name, sub].filter(Boolean).join('/')
    }
    private selector(): string { return `labelSelector=${encodeURIComponent(`app.kubernetes.io/instance=${this.policy.release}`)}` }
    private workloadPath(w: ControlWorkload, sub?: string): string { return this.nsPath('apps', w.kind === 'Deployment' ? 'deployments' : 'statefulsets', w.object, sub) }

    async status(): Promise<ClusterStatus> {
        const [deployments, statefulsets, pods] = await Promise.all([
            this.request({ method: 'GET', path: `${this.nsPath('apps', 'deployments')}?${this.selector()}` }),
            this.request({ method: 'GET', path: `${this.nsPath('apps', 'statefulsets')}?${this.selector()}` }),
            this.request({ method: 'GET', path: `${this.nsPath('core', 'pods')}?${this.selector()}` }),
        ])
        // List items carry no `kind`; keep the two lists apart.
        const own = (list: any) => new Map<string, any>((list?.items || [])
            .filter((item: any) => !item?.metadata?.namespace || item.metadata.namespace === this.policy.namespace)
            .map((item: any) => [String(item?.metadata?.name), item]))
        const byKind = { Deployment: own(deployments.data), StatefulSet: own(statefulsets.data) }
        const workloads = Object.values(this.policy.workloads).map((w): WorkloadStatus => {
            const item = byKind[w.kind].get(w.object)
            const container = (item?.spec?.template?.spec?.containers || []).find((c: any) => c?.name === w.container)
            return {
                name: w.name, kind: w.kind, object: w.object, role: w.role, min: w.min, max: w.max, autoscale: w.autoscale, found: Boolean(item),
                desired: safeNum(item?.spec?.replicas), ready: safeNum(item?.status?.readyReplicas), available: safeNum(item?.status?.availableReplicas),
                image: text(container?.image, 200),
            }
        })
        const podList = (pods.data?.items || []).map((pod: any): PodStatus => ({
            name: text(pod?.metadata?.name, 253), workload: text(pod?.metadata?.labels?.['xaventra.ai/workload'], 63),
            phase: text(pod?.status?.phase, 20) || 'Unknown',
            ready: (pod?.status?.containerStatuses || []).length > 0 && (pod.status.containerStatuses as any[]).every(c => c?.ready === true),
            restarts: (pod?.status?.containerStatuses || []).reduce((sum: number, c: any) => sum + safeNum(c?.restartCount), 0),
            node: text(pod?.spec?.nodeName, 253),
        }))
        return { namespace: this.policy.namespace, release: this.policy.release, workloads, pods: podList }
    }

    async events(limit = 20): Promise<ClusterEvent[]> {
        const bounded = Math.min(100, Math.max(1, Math.round(limit)))
        const response = await this.request({ method: 'GET', path: `${this.nsPath('core', 'events')}?limit=200` })
        const events = (response.data?.items || []).map((e: any): ClusterEvent => ({
            type: text(e?.type, 20), reason: text(e?.reason, 60), message: text(redactSecrets(String(e?.message ?? '')), 200),
            object: `${text(e?.involvedObject?.kind, 30)}/${text(e?.involvedObject?.name, 253)}`,
            at: text(e?.lastTimestamp || e?.eventTime || e?.metadata?.creationTimestamp, 40), count: safeNum(e?.count) || 1,
        }))
        return events
            .sort((a, b) => (a.type === 'Warning' ? 0 : 1) - (b.type === 'Warning' ? 0 : 1) || b.at.localeCompare(a.at))
            .slice(0, bounded)
    }

    async logs(pod: string, tailLines = 100): Promise<string> {
        if (!DNS_SUBDOMAIN.test(String(pod || ''))) throw new Error('Ungültiger Pod-Name')
        const pods = await this.request({ method: 'GET', path: `${this.nsPath('core', 'pods')}?${this.selector()}` })
        const found = (pods.data?.items || []).find((item: any) => item?.metadata?.name === pod)
        if (!found) throw new Error(`Pod ${pod} ist nicht aus diesem Release.`)
        const workload = Object.values(this.policy.workloads).find(w => w.name === found?.metadata?.labels?.['xaventra.ai/workload'])
        const tail = Math.min(MAX_LOG_LINES, Math.max(1, Math.round(Number(tailLines) || 100)))
        const response = await this.request({ method: 'GET', path: `${this.nsPath('core', 'pods', pod, 'log')}?tailLines=${tail}&container=${workload?.container || 'xaventra'}` })
        return redactSecrets(String(typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? ''))).slice(-64 * 1024)
    }

    /** Own worker Deployment within min/max. No card (reversible, bounded). */
    async scaleWorker(name: string, replicas: number, reason = 'Owner'): Promise<KubeActionResult> {
        const w = this.policy.workloads[name]
        if (!w) return { ok: false, requested: false, message: `Unbekannte Workload „${text(name, 63)}“.` }
        if (w.role === 'main') return { ok: false, requested: false, message: 'Die Main wird nie über Kubernetes skaliert (Führung macht Xaventras Lease).' }
        if (w.kind !== 'Deployment') return { ok: false, requested: false, message: `${w.name} ist kein Deployment.` }
        if (!Number.isInteger(replicas) || replicas < w.min || replicas > w.max) {
            return { ok: false, requested: false, message: `${w.name}: erlaubt sind ${w.min}–${w.max} Replikas (aus den Chart-Werten).` }
        }
        await this.request({ method: 'PATCH', path: this.workloadPath(w, 'scale'), body: { spec: { replicas } }, contentType: 'application/merge-patch+json' })
        this.log(`[Kubernetes] ${w.name} → ${replicas} Replikas (${text(reason, 80)})`)
        return { ok: true, requested: true, message: `${w.name}: auf ${replicas} Replikas gestellt.` }
    }

    /** Rollout restart. Own workers without card; Main/optional only with an approved card. */
    async restartWorkload(name: string, options: { approved?: boolean } = {}): Promise<KubeActionResult> {
        const w = this.policy.workloads[name]
        if (!w) return { ok: false, requested: false, message: `Unbekannte Workload „${text(name, 63)}“.` }
        if (w.role !== 'worker' && !options.approved) return { ok: false, requested: false, needsCard: true, message: `${w.name} neu starten braucht eine Karte.` }
        const at = new Date(this.now()).toISOString()
        await this.request({
            method: 'PATCH', path: this.workloadPath(w), contentType: 'application/strategic-merge-patch+json',
            body: { spec: { template: { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: at } } } } },
        })
        this.log(`[Kubernetes] ${w.name} neu gestartet (rollout restart)`)
        return { ok: true, requested: true, message: `${w.name}: Neustart angestoßen (Kubernetes tauscht die Pods nacheinander).` }
    }

    // -- Chart update ---------------------------------------------------------

    private async snapshot(): Promise<{ objects: Record<string, any>; control: ControlPolicy }> {
        const objects: Record<string, any> = {}
        for (const w of Object.values(this.policy.workloads)) {
            const response = await this.request({ method: 'GET', path: this.workloadPath(w) })
            const container = (response.data?.spec?.template?.spec?.containers || []).find((c: any) => c?.name === w.container) || {}
            objects[w.name] = { replicas: safeNum(response.data?.spec?.replicas), image: text(container.image, 200), resources: container.resources || {} }
        }
        const cm = await this.request({ method: 'GET', path: this.nsPath('core', 'configmaps', this.policy.controlConfigMap) })
        let control = this.policy
        try { control = parseControlPolicy(JSON.parse(String(cm.data?.data?.['control.json'] ?? ''))) || this.policy } catch { /* keep mounted policy */ }
        return { objects, control }
    }

    private static hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32) }

    async planChartUpdate(changes: ChartChange[]): Promise<ChartPlan | { ok: false; message: string }> {
        for (const change of changes) {
            const workload = change.path === 'image.tag' ? null : change.path.split('.')[0]
            if (workload && !this.policy.workloads[workload]) return { ok: false, message: `Unbekannte Workload „${workload}“.` }
            if (change.path === 'image.tag' && !this.policy.imageRepository) return { ok: false, message: 'Image-Repository unbekannt — kein Image-Wechsel.' }
        }
        const snap = await this.snapshot()
        const lines: string[] = []
        const removes: string[] = []
        for (const change of changes) {
            if (change.path === 'image.tag') {
                for (const w of Object.values(this.policy.workloads)) {
                    const next = `${this.policy.imageRepository}:${change.value}`
                    if (snap.objects[w.name].image !== next) lines.push(`${w.name}: Image ${snap.objects[w.name].image || '?'} → ${next}`)
                }
                continue
            }
            const [workload, ...rest] = change.path.split('.')
            const key = rest.join('.')
            const current = snap.control.workloads[workload] || this.policy.workloads[workload]
            if (key === 'min' || key === 'max') lines.push(`${workload}: ${key} ${current[key]} → ${change.value}`)
            else if (key === 'enabled') {
                const replicas = snap.objects[workload].replicas
                if (change.value === 'false') { lines.push(`${workload}: abgeschaltet (Replikas ${replicas} → 0) — ENTFERNT diese Workload`); removes.push(workload) }
                else lines.push(`${workload}: eingeschaltet (Replikas ${replicas} → ${Math.max(1, current.min)})`)
            } else {
                const [, kind, resource] = key.split('.')
                lines.push(`${workload}: ${key} ${snap.objects[workload].resources?.[kind]?.[resource] ?? '—'} → ${change.value}`)
            }
        }
        if (!lines.length) return { ok: false, message: 'Nichts zu ändern — alles ist schon so.' }
        const minMax = new Map<string, { min: number; max: number }>()
        for (const w of Object.values(snap.control.workloads)) minMax.set(w.name, { min: w.min, max: w.max })
        for (const change of changes) {
            const [workload, key] = change.path.split('.')
            if (key !== 'min' && key !== 'max') continue
            const entry = minMax.get(workload)!
            entry[key] = Number(change.value)
            if (entry.min > entry.max) return { ok: false, message: `${workload}: min (${entry.min}) wäre größer als max (${entry.max}).` }
        }
        return { id: `k8splan-${randomBytes(6).toString('hex')}`, changes, lines, removes, beforeHash: KubernetesClient.hash(snap) }
    }

    /** Runs only after the owner's Ja (card executor). Re-reads the cluster first. */
    async applyChartUpdate(plan: ChartPlan): Promise<KubeActionResult> {
        const snap = await this.snapshot()
        if (KubernetesClient.hash(snap) !== plan.beforeHash) {
            return { ok: false, requested: false, message: 'Der Cluster hat sich seit der Vorschau geändert — nichts geändert, bitte neu anfragen.' }
        }
        const control: ControlPolicy = JSON.parse(JSON.stringify(snap.control))
        const patches = new Map<string, Record<string, any>>()
        const containerPatch = (w: ControlWorkload) => {
            if (!patches.has(w.name)) patches.set(w.name, { name: w.container })
            return patches.get(w.name)!
        }
        const scales: Array<[ControlWorkload, number]> = []
        for (const change of plan.changes) {
            if (change.path === 'image.tag') {
                for (const w of Object.values(this.policy.workloads)) containerPatch(w).image = `${this.policy.imageRepository}:${change.value}`
                continue
            }
            const [workload, ...rest] = change.path.split('.')
            const key = rest.join('.')
            const w = this.policy.workloads[workload]
            if (key === 'min' || key === 'max') control.workloads[workload][key] = Number(change.value)
            else if (key === 'enabled') {
                if (change.value === 'false') { control.workloads[workload].min = 0; scales.push([w, 0]) }
                else { const min = Math.max(1, control.workloads[workload].min); control.workloads[workload].min = min; control.workloads[workload].max = Math.max(min, control.workloads[workload].max); scales.push([w, min]) }
            } else {
                const [, kind, resource] = key.split('.')
                const patch = containerPatch(w)
                patch.resources = patch.resources || {}
                patch.resources[kind] = { ...(patch.resources[kind] || {}), [resource]: change.value }
            }
        }
        const done: string[] = []
        for (const [name, patch] of patches) {
            const w = this.policy.workloads[name]
            await this.request({ method: 'PATCH', path: this.workloadPath(w), contentType: 'application/strategic-merge-patch+json', body: { spec: { template: { spec: { containers: [patch] } } } } })
            done.push(name)
        }
        for (const [w, replicas] of scales) {
            if (w.kind === 'Deployment') await this.request({ method: 'PATCH', path: this.workloadPath(w, 'scale'), body: { spec: { replicas } }, contentType: 'application/merge-patch+json' })
            else await this.request({ method: 'PATCH', path: this.workloadPath(w), body: { spec: { replicas } }, contentType: 'application/merge-patch+json' })
        }
        if (plan.changes.some(change => /\.(min|max|enabled)$/.test(change.path))) {
            const applied = [{ at: new Date(this.now()).toISOString(), plan: plan.id, changes: plan.changes }]
            await this.request({ method: 'PATCH', path: this.nsPath('core', 'configmaps', this.policy.controlConfigMap), body: { data: { 'control.json': serializeControlPolicy(control, applied) } }, contentType: 'application/merge-patch+json' })
        }
        this.log(`[Kubernetes] Chart-Update ${plan.id} angewendet (${plan.lines.length} Änderungen)`)
        return { ok: true, requested: true, message: `Chart-Update angewendet: ${plan.lines.join('; ')}. Hinweis: ein späteres helm upgrade ohne diese Werte setzt sie zurück.` }
    }
}

// ---------------------------------------------------------------------------
// Runtime: in-cluster ServiceAccount, or an explicitly configured own account
// ---------------------------------------------------------------------------

export type KubernetesRuntime = { ok: true; client: KubernetesClient; policy: ControlPolicy; server: string } | { ok: false; reason: string }

export async function loadKubernetesRuntime(options: {
    env?: NodeJS.ProcessEnv
    rawConfig?: unknown
    readFile?: (path: string) => string
    transport?: KubeTransport
    log?: (line: string) => void
} = {}): Promise<KubernetesRuntime> {
    const env = options.env || process.env
    const read = options.readFile || ((path: string) => readFileSync(path, 'utf8'))
    const config = (options.rawConfig && typeof options.rawConfig === 'object' ? (options.rawConfig as any).infra?.kubernetes : undefined) || {}
    if (config.enabled === false) return { ok: false, reason: 'infra.kubernetes.enabled ist false' }
    const inCluster = detectKubernetes(env, read)
    let server: string, caFile: string, tokenFile: string, namespace: string | null
    if (inCluster) {
        const host = String(env.KUBERNETES_SERVICE_HOST || '').trim()
        const port = String(env.KUBERNETES_SERVICE_PORT || '443').trim()
        server = `https://${host.includes(':') ? `[${host}]` : host}:${/^\d{1,5}$/.test(port) ? port : '443'}`
        caFile = `${SERVICE_ACCOUNT_DIR}/ca.crt`
        tokenFile = `${SERVICE_ACCOUNT_DIR}/token`
        namespace = inCluster.namespace
    } else {
        // Own account outside the cluster: server + CA file in config, token file path via env.
        if (typeof config.server !== 'string' || !config.server) return { ok: false, reason: 'nicht im Cluster und infra.kubernetes.server fehlt' }
        server = config.server
        caFile = String(config.caFile || '')
        tokenFile = String(env.XAVENTRA_K8S_TOKEN_FILE || '')
        namespace = typeof config.namespace === 'string' ? config.namespace : null
        if (!caFile || !tokenFile) return { ok: false, reason: 'infra.kubernetes.caFile und XAVENTRA_K8S_TOKEN_FILE sind nötig' }
    }
    const controlFile = String(env.XAVENTRA_K8S_CONTROL_FILE || config.controlFile || DEFAULT_CONTROL_FILE)
    let policy: ControlPolicy | null = null
    try { policy = parseControlPolicy(JSON.parse(read(controlFile))) } catch { policy = null }
    if (!policy) return { ok: false, reason: `Steuerdatei ${controlFile} fehlt oder ist ungültig (Chart mit control.enabled=true installieren)` }
    if (!namespace || policy.namespace !== namespace) return { ok: false, reason: `Steuerdatei nennt Namespace ${policy.namespace}, dieser Pod läuft in ${namespace || '?'} — abgelehnt` }
    let transport = options.transport
    if (!transport) {
        let caPem = ''
        try { caPem = read(caFile) } catch { return { ok: false, reason: 'CA-Datei nicht lesbar' } }
        try { read(tokenFile) } catch { return { ok: false, reason: 'Token-Datei nicht lesbar (automountServiceAccountToken aus?)' } }
        try { transport = createKubeTransport({ server, caPem, tokenFile, readFile: read }) } catch (error) { return { ok: false, reason: String((error as Error)?.message || error) } }
    }
    return { ok: true, client: new KubernetesClient({ policy, transport, log: options.log }), policy, server }
}

export function readKubernetesRawConfig(): unknown {
    try { return JSON.parse(readFileSync(resolveConfigPath(), 'utf8')) } catch { return undefined }
}
