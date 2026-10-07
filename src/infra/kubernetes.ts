/**
 * Kubernetes-Adapter (2.88 P19, 2.89 P21) — narrow like src/infra/proxmox.ts.
 *
 * Grundsatz: Kubernetes decides WHERE a process runs; Xaventra decides WHAT
 * runs. Kubernetes never replaces the Xaventra mesh, its lease, witness epoch
 * or fencing.
 *
 * Fixed rules (code, not config):
 * - Never raw kubectl (stays on the Nie-Liste, src/install/never-list.ts).
 *   This adapter talks to the Kubernetes API directly with the chart's control
 *   ServiceAccount: mounted in an in-cluster Main, or — the normal case, the
 *   Main runs natively outside — server + CA file + token file configured on
 *   the Main. No kubeconfig exec plugins.
 * - Only the OWN namespace and only objects of the OWN release (the chart's
 *   control policy names them). Every request passes `checkKubeRequest` BEFORE
 *   the transport: foreign namespaces, cluster-scoped paths, Secrets,
 *   pods/exec|attach|portforward|proxy, tokens, RBAC, PVCs, scale, DELETE and
 *   POST are refused without a request.
 * - Workers are DaemonSets (one pod per owner-labelled node). There is no
 *   replica count to scale and no autoscaler: more workers = the owner labels
 *   one more node. Actions:
 *     lesen                 status, events, logs (bounded, redacted)
 *     neu starten           rollout restart of an own worker DaemonSet — no card
 *                           Main / optional workloads                  — card
 *     Chart-Update          image tag, resources; diff preview         — card
 *     abschalten/skalieren  never through the API (helm / node labels by the owner)
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
export const CONTROL_SCHEMA = 2
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_LOG_LINES = 500

/** Documented, refused, and without any code path. */
export const KUBERNETES_NEVER: readonly string[] = Object.freeze([
    'rohes kubectl (Nie-Liste) — nur feste Aktionen über die API',
    'fremde Namespaces und cluster-weite Objekte (Nodes, Labels, Namespaces, RBAC)',
    'Secrets lesen, auflisten oder ändern; Tokens anfordern',
    'pods/exec, attach, portforward, proxy',
    'PersistentVolumeClaims, Daten oder Namespaces löschen',
    'Worker über Kubernetes skalieren oder abschalten (DaemonSet: ein Pod je freigegebenem Knoten — Knoten freigeben macht der Owner)',
    'die Main über Kubernetes skalieren oder abschalten (Führung nur über Xaventras Lease/Witness/Fencing)',
])

// ---------------------------------------------------------------------------
// Control policy (rendered by the Helm chart into ConfigMap <fullname>-control)
// ---------------------------------------------------------------------------

export type WorkloadRole = 'main' | 'worker' | 'optional'
export type WorkloadKind = 'DaemonSet' | 'StatefulSet'
export interface ControlWorkload {
    name: string
    kind: WorkloadKind
    object: string
    container: string
    role: WorkloadRole
}
export interface ControlPolicy {
    namespace: string
    release: string
    fullname: string
    controlConfigMap: string
    imageRepository: string
    /** Node label the owner sets to release a node for workers. */
    workerNodeLabel: string
    workloads: Record<string, ControlWorkload>
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DNS_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const LABEL_KEY = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\/)?[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/
const IMAGE_REPO = /^[a-z0-9][a-z0-9._/-]{0,200}[a-z0-9](?::[0-9]{1,5}(?=\/))?(?:\/[a-z0-9._-]+)*$/
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const QUANTITY = /^[0-9]{1,6}(?:\.[0-9]{1,3})?(?:m|k|M|G|T|Ki|Mi|Gi|Ti)?$/

export function parseControlPolicy(raw: unknown): ControlPolicy | null {
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, any>
    if (value.schema !== CONTROL_SCHEMA) return null
    const namespace = String(value.namespace ?? '')
    const release = String(value.release ?? '')
    const fullname = String(value.fullname ?? release)
    const controlConfigMap = String(value.controlConfigMap ?? `${fullname}-control`)
    if (!DNS_LABEL.test(namespace) || !DNS_LABEL.test(release) || !DNS_SUBDOMAIN.test(fullname) || !DNS_SUBDOMAIN.test(controlConfigMap)) return null
    const imageRepository = String(value.image?.repository ?? '')
    const workerNodeLabel = String(value.workerNodeLabel ?? 'xaventra.ai/worker')
    const workloads: Record<string, ControlWorkload> = {}
    for (const [name, item] of Object.entries((value.workloads && typeof value.workloads === 'object') ? value.workloads : {})) {
        const w = item as Record<string, any>
        if (!DNS_LABEL.test(name) || (w?.kind !== 'DaemonSet' && w?.kind !== 'StatefulSet')) continue
        const object = String(w.object ?? '')
        const container = String(w.container ?? 'xaventra')
        if (!DNS_SUBDOMAIN.test(object) || !DNS_LABEL.test(container)) continue
        const role: WorkloadRole = w.role === 'main' ? 'main' : w.role === 'optional' ? 'optional' : 'worker'
        // A Main is only ever the StatefulSet; workers are only ever DaemonSets.
        if ((role === 'main') !== (w.kind === 'StatefulSet')) continue
        workloads[name] = { name, kind: w.kind, object, container, role }
    }
    return {
        namespace, release, fullname, controlConfigMap,
        imageRepository: IMAGE_REPO.test(imageRepository) ? imageRepository : '',
        workerNodeLabel: LABEL_KEY.test(workerNodeLabel) ? workerNodeLabel : 'xaventra.ai/worker',
        workloads,
    }
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
    [/^scale$/i, 'Skalieren gibt es nicht (DaemonSet: Knoten-Freigabe macht der Owner)'],
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
    const method = request.method

    if (group === 'core' && resource === 'pods') {
        if (method !== 'GET') return 'Pods werden nie gelöscht oder geändert'
        if (sub === undefined || sub === 'log') return null
        return 'Pod-Unterressource nicht erlaubt'
    }
    if (group === 'core' && resource === 'events') return method === 'GET' && name === undefined ? null : 'Events nur lesen'
    if (group === 'events.k8s.io' && resource === 'events') return method === 'GET' && name === undefined ? null : 'Events nur lesen'
    if (group === 'core' && resource === 'configmaps') {
        if (name !== policy.controlConfigMap) return 'nur die eigene Steuer-ConfigMap'
        if (sub !== undefined) return 'Pfad nicht erlaubt'
        return method === 'GET' ? null : 'Steuer-ConfigMap nur lesen'
    }
    if (group === 'apps' && (resource === 'daemonsets' || resource === 'statefulsets')) {
        if (sub !== undefined) return 'Pfad nicht erlaubt'
        if (method === 'GET') return null
        if (method !== 'PATCH') return 'nur lesen oder patchen — nie anlegen/löschen'
        const workload = Object.values(policy.workloads).find(w => w.object === name)
        if (!name || !workload) return 'nur eigene Workloads dieses Release'
        if ((resource === 'daemonsets') !== (workload.kind === 'DaemonSet')) return 'Art passt nicht'
        return null
    }
    if (group === 'apps') return `apps/${resource || '?'} nicht erlaubt (Worker sind DaemonSets)`
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
        // Tokens rotate: read it for every request, keep it out of every message.
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
export interface WorkloadStatus {
    name: string; kind: WorkloadKind; object: string; role: WorkloadRole
    /** DaemonSet: nodes that should run a pod; StatefulSet: replicas. */
    desired: number; ready: number; available: number; updated: number
    image: string; found: boolean
}
export interface PodStatus { name: string; workload: string; phase: string; ready: boolean; restarts: number; node: string }
export interface ClusterEvent { type: string; reason: string; message: string; object: string; at: string; count: number }
export interface ClusterStatus { namespace: string; release: string; workerNodeLabel: string; workloads: WorkloadStatus[]; pods: PodStatus[] }

export interface ChartChange { path: string; value: string }
export interface ChartPlan {
    id: string
    changes: ChartChange[]
    lines: string[]
    /** Hash of the live state the preview was computed from. */
    beforeHash: string
}

const text = (value: unknown, max = 160): string => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, max)
const safeNum = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0 }

/** Why there is no scaling: shown instead of any API call. */
export function scaleExplanation(policy: Pick<ControlPolicy, 'workerNodeLabel'>): string {
    return `Worker laufen als DaemonSet: genau ein Pod je Knoten mit ${policy.workerNodeLabel}=true. `
        + `Mehr Worker = einen weiteren Knoten freigeben, weniger = Freigabe entfernen — das macht der Owner selbst `
        + `(kubectl label node <knoten> ${policy.workerNodeLabel}=true bzw. ${policy.workerNodeLabel}-). Xaventra ändert keine Knoten und skaliert nichts automatisch.`
}

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
            if (/^[a-z0-9-]+\.(min|max|enabled|replicas)$/.test(path)) {
                return `„${path}“: Worker sind DaemonSets — es gibt keine Replikas. Ein-/Abschalten und mehr/weniger Knoten macht der Owner (helm bzw. Knoten-Label).`
            }
            const field = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(resources\.(?:requests|limits)\.(?:cpu|memory))$/.exec(path)
            if (!field) return `„${path}“ darf Xaventra nicht ändern (erlaubt: image.tag, <workload>.resources.requests|limits.cpu|memory).`
            if (!QUANTITY.test(value)) return `${path}: ungültige Menge (z. B. 500m, 2, 4Gi).`
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
    private workloadPath(w: ControlWorkload): string { return this.nsPath('apps', w.kind === 'DaemonSet' ? 'daemonsets' : 'statefulsets', w.object) }

    async status(): Promise<ClusterStatus> {
        const hasMain = Object.values(this.policy.workloads).some(w => w.kind === 'StatefulSet')
        const [daemonsets, statefulsets, pods] = await Promise.all([
            this.request({ method: 'GET', path: `${this.nsPath('apps', 'daemonsets')}?${this.selector()}` }),
            hasMain ? this.request({ method: 'GET', path: `${this.nsPath('apps', 'statefulsets')}?${this.selector()}` }) : Promise.resolve({ status: 200, data: { items: [] } }),
            this.request({ method: 'GET', path: `${this.nsPath('core', 'pods')}?${this.selector()}` }),
        ])
        // List items carry no `kind`; keep the two lists apart.
        const own = (list: any) => new Map<string, any>((list?.items || [])
            .filter((item: any) => !item?.metadata?.namespace || item.metadata.namespace === this.policy.namespace)
            .map((item: any) => [String(item?.metadata?.name), item]))
        const byKind = { DaemonSet: own(daemonsets.data), StatefulSet: own(statefulsets.data) }
        const workloads = Object.values(this.policy.workloads).map((w): WorkloadStatus => {
            const item = byKind[w.kind].get(w.object)
            const container = (item?.spec?.template?.spec?.containers || []).find((c: any) => c?.name === w.container)
            const s = item?.status || {}
            const counts = w.kind === 'DaemonSet'
                ? { desired: safeNum(s.desiredNumberScheduled), ready: safeNum(s.numberReady), available: safeNum(s.numberAvailable), updated: safeNum(s.updatedNumberScheduled) }
                : { desired: safeNum(item?.spec?.replicas), ready: safeNum(s.readyReplicas), available: safeNum(s.availableReplicas), updated: safeNum(s.updatedReplicas) }
            return { name: w.name, kind: w.kind, object: w.object, role: w.role, found: Boolean(item), ...counts, image: text(container?.image, 200) }
        })
        const podList = (pods.data?.items || []).map((pod: any): PodStatus => ({
            name: text(pod?.metadata?.name, 253), workload: text(pod?.metadata?.labels?.['xaventra.ai/workload'], 63),
            phase: text(pod?.status?.phase, 20) || 'Unknown',
            ready: (pod?.status?.containerStatuses || []).length > 0 && (pod.status.containerStatuses as any[]).every(c => c?.ready === true),
            restarts: (pod?.status?.containerStatuses || []).reduce((sum: number, c: any) => sum + safeNum(c?.restartCount), 0),
            node: text(pod?.spec?.nodeName, 253),
        }))
        return { namespace: this.policy.namespace, release: this.policy.release, workerNodeLabel: this.policy.workerNodeLabel, workloads, pods: podList }
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

    /** Rollout restart. Own worker DaemonSets without card; Main/optional only with an approved card. */
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
        return {
            ok: true, requested: true,
            message: w.kind === 'DaemonSet'
                ? `${w.name}: Neustart angestoßen (Kubernetes tauscht den Pod je Knoten nacheinander; nie zwei gleichzeitig auf einem Knoten).`
                : `${w.name}: Neustart angestoßen.`,
        }
    }

    // -- Chart update ---------------------------------------------------------

    private async snapshot(): Promise<Record<string, { image: string; resources: any }>> {
        const objects: Record<string, { image: string; resources: any }> = {}
        for (const w of Object.values(this.policy.workloads)) {
            const response = await this.request({ method: 'GET', path: this.workloadPath(w) })
            const container = (response.data?.spec?.template?.spec?.containers || []).find((c: any) => c?.name === w.container) || {}
            objects[w.name] = { image: text(container.image, 200), resources: container.resources || {} }
        }
        return objects
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
        for (const change of changes) {
            if (change.path === 'image.tag') {
                for (const w of Object.values(this.policy.workloads)) {
                    const next = `${this.policy.imageRepository}:${change.value}`
                    if (snap[w.name].image !== next) lines.push(`${w.name}: Image ${snap[w.name].image || '?'} → ${next}`)
                }
                continue
            }
            const [workload, ...rest] = change.path.split('.')
            const key = rest.join('.')
            const [, kind, resource] = key.split('.')
            const current = snap[workload].resources?.[kind]?.[resource] ?? '—'
            if (String(current) !== change.value) lines.push(`${workload}: ${key} ${current} → ${change.value}`)
        }
        if (!lines.length) return { ok: false, message: 'Nichts zu ändern — alles ist schon so.' }
        return { id: `k8splan-${randomBytes(6).toString('hex')}`, changes, lines, beforeHash: KubernetesClient.hash(snap) }
    }

    /** Runs only after the owner's Ja (card executor). Re-reads the cluster first. */
    async applyChartUpdate(plan: ChartPlan): Promise<KubeActionResult> {
        const snap = await this.snapshot()
        if (KubernetesClient.hash(snap) !== plan.beforeHash) {
            return { ok: false, requested: false, message: 'Der Cluster hat sich seit der Vorschau geändert — nichts geändert, bitte neu anfragen.' }
        }
        const patches = new Map<string, Record<string, any>>()
        const containerPatch = (w: ControlWorkload) => {
            if (!patches.has(w.name)) patches.set(w.name, { name: w.container })
            return patches.get(w.name)!
        }
        for (const change of plan.changes) {
            if (change.path === 'image.tag') {
                for (const w of Object.values(this.policy.workloads)) containerPatch(w).image = `${this.policy.imageRepository}:${change.value}`
                continue
            }
            const [workload, ...rest] = change.path.split('.')
            const [, kind, resource] = rest.join('.').split('.')
            const patch = containerPatch(this.policy.workloads[workload])
            patch.resources = patch.resources || {}
            patch.resources[kind] = { ...(patch.resources[kind] || {}), [resource]: change.value }
        }
        for (const [name, patch] of patches) {
            await this.request({ method: 'PATCH', path: this.workloadPath(this.policy.workloads[name]), contentType: 'application/strategic-merge-patch+json', body: { spec: { template: { spec: { containers: [patch] } } } } })
        }
        this.log(`[Kubernetes] Chart-Update ${plan.id} angewendet (${plan.lines.length} Änderungen)`)
        return { ok: true, requested: true, message: `Chart-Update angewendet: ${plan.lines.join('; ')}. Hinweis: ein späteres helm upgrade ohne diese Werte setzt sie zurück — übernimm sie in die values-Datei.` }
    }
}

// ---------------------------------------------------------------------------
// Runtime: in-cluster ServiceAccount, or the external Main's own account
// ---------------------------------------------------------------------------

export type KubernetesRuntime = { ok: true; client: KubernetesClient; policy: ControlPolicy; server: string } | { ok: false; reason: string }

/** True when this process should offer cluster control at all (pod or configured external account). */
export function kubernetesControlConfigured(env: NodeJS.ProcessEnv = process.env, rawConfig: unknown = readKubernetesRawConfig()): boolean {
    const config = (rawConfig && typeof rawConfig === 'object' ? (rawConfig as any).infra?.kubernetes : undefined) || {}
    if (config.enabled === false) return false
    return Boolean(String(env.KUBERNETES_SERVICE_HOST || '').trim()) || (typeof config.server === 'string' && config.server.length > 0)
}

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
        // External Main (normal case): server + CA file + namespace + release in the
        // config, token file path via env. The token is the chart's control account.
        if (typeof config.server !== 'string' || !config.server) return { ok: false, reason: 'nicht im Cluster und infra.kubernetes.server fehlt' }
        server = config.server
        caFile = String(config.caFile || '')
        tokenFile = String(env.XAVENTRA_K8S_TOKEN_FILE || '')
        namespace = typeof config.namespace === 'string' && DNS_LABEL.test(config.namespace) ? config.namespace : null
        if (!caFile || !tokenFile) return { ok: false, reason: 'infra.kubernetes.caFile und XAVENTRA_K8S_TOKEN_FILE sind nötig' }
        if (!namespace) return { ok: false, reason: 'infra.kubernetes.namespace fehlt oder ist ungültig' }
    }
    let policy: ControlPolicy | null = null
    const controlFile = String(env.XAVENTRA_K8S_CONTROL_FILE || config.controlFile || (inCluster ? DEFAULT_CONTROL_FILE : ''))
    if (controlFile) { try { policy = parseControlPolicy(JSON.parse(read(controlFile))) } catch { policy = null } }
    if (!policy && inCluster) return { ok: false, reason: `Steuerdatei ${controlFile} fehlt oder ist ungültig (Chart mit control.enabled=true und main.enabled=true installieren)` }
    let transport = options.transport
    if (!transport) {
        let caPem = ''
        try { caPem = read(caFile) } catch { return { ok: false, reason: 'CA-Datei nicht lesbar' } }
        try { read(tokenFile) } catch { return { ok: false, reason: 'Token-Datei nicht lesbar' } }
        try { transport = createKubeTransport({ server, caPem, tokenFile, readFile: read }) } catch (error) { return { ok: false, reason: String((error as Error)?.message || error) } }
    }

    if (!policy && !inCluster) {
        // No mounted file outside the cluster: read the release's control ConfigMap
        // through the same guard (only GET on exactly this ConfigMap is possible).
        const release = String(config.release || '')
        const controlConfigMap = String(config.controlConfigMap || (config.fullname ? `${config.fullname}-control` : release ? `${release}-control` : ''))
        if (!DNS_SUBDOMAIN.test(controlConfigMap)) return { ok: false, reason: 'infra.kubernetes.release (oder controlConfigMap) fehlt' }
        const bootstrap: ControlPolicy = { namespace: namespace!, release: release || 'unbekannt', fullname: release || 'unbekannt', controlConfigMap, imageRepository: '', workerNodeLabel: 'xaventra.ai/worker', workloads: {} }
        try {
            const response = await new KubernetesClient({ policy: bootstrap, transport }).request({ method: 'GET', path: `/api/v1/namespaces/${namespace}/configmaps/${controlConfigMap}` })
            policy = parseControlPolicy(JSON.parse(String(response.data?.data?.['control.json'] ?? '')))
        } catch (error) {
            return { ok: false, reason: `Steuer-ConfigMap ${controlConfigMap} nicht lesbar (${text(String((error as Error)?.message || error), 120)})` }
        }
    }
    if (!policy) return { ok: false, reason: `Steuerdatei ${controlFile || '(Steuer-ConfigMap)'} fehlt oder ist ungültig (Chart mit control.enabled=true installieren)` }
    if (!namespace || policy.namespace !== namespace) return { ok: false, reason: `Steuerdatei nennt Namespace ${policy.namespace}, erwartet ${namespace || '?'} — abgelehnt` }
    return { ok: true, client: new KubernetesClient({ policy, transport, log: options.log }), policy, server }
}

export function readKubernetesRawConfig(): unknown {
    try { return JSON.parse(readFileSync(resolveConfigPath(), 'utf8')) } catch { return undefined }
}
