/**
 * Test-Pods (2.89.15) — the one write exception of the Kubernetes adapter.
 *
 * Fixed rules (code, not config):
 * - Only core `pods` in exactly the namespace `xaventra-test`. Every other
 *   namespace keeps the read/patch rules of src/infra/kubernetes.ts (no create,
 *   no delete). Secrets, exec/attach/portforward/proxy, tokens stay refused
 *   everywhere — those segments are checked before this file is asked.
 * - Created pods come only from `buildTestPod`, and the guard re-checks every
 *   POST body with `validateTestPod` (whitelist): label managed-by=xaventra,
 *   CPU/memory limits within the caps, a run-time limit, no service-account
 *   token, no host network/PID/IPC, no volumes (so no hostPath), no
 *   privileged/escalation/added capabilities, no ports, no env from Secrets.
 * - Delete only own labelled pods: the client reads the pod first and deletes
 *   with its uid as precondition, so exactly the checked pod goes. RBAC cannot
 *   restrict delete to a label — this check is the code's job.
 * - Every create needs the owner's approval for exactly this pod (the tool
 *   passes `confirm`, see src/tools/cluster-tools.ts).
 * - The namespace, quota and RBAC are created by the owner
 *   (deploy/kubernetes/xaventra-test-rbac.yaml), never by Xaventra.
 */

export const KUBE_TEST_NAMESPACE = 'xaventra-test'
export const TEST_POD_LABEL = Object.freeze({ key: 'managed-by', value: 'xaventra' })
export const TEST_POD_SELECTOR = `${TEST_POD_LABEL.key}=${TEST_POD_LABEL.value}`

const MAX_CPU_MILLI = 1000
const MAX_MEMORY_MI = 1024
const DEFAULT_CPU = '250m'
const DEFAULT_MEMORY = '128Mi'
const DEFAULT_DEADLINE_S = 3600
const MAX_DEADLINE_S = 4 * 3600
const MAX_ARGS = 20
const MAX_ARG_LENGTH = 512

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IMAGE_REPO = /^[a-z0-9][a-z0-9._/-]{0,200}[a-z0-9](?::[0-9]{1,5}(?=\/))?(?:\/[a-z0-9._-]+)*$/
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

export interface TestPodInput {
    name: string
    image: string
    command?: string[]
    cpu?: string
    memory?: string
    laufzeitSekunden?: number
}
export type TestPodBuild = { ok: true; pod: any; summary: string } | { ok: false; reason: string }

const isObject = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const extraKey = (value: Record<string, any>, allowed: readonly string[]): string | undefined => Object.keys(value).find(key => !allowed.includes(key))

/** CPU quantity in millicores, or null. */
function cpuMilli(value: unknown): number | null {
    const match = /^([0-9]{1,4})(?:\.([0-9]{1,3}))?(m)?$/.exec(String(value ?? ''))
    if (!match) return null
    if (match[3]) return match[2] ? null : Number(match[1])
    return Math.round(Number(`${match[1]}.${match[2] || '0'}`) * 1000)
}
/** Memory quantity in MiB (Mi/Gi only), or null. */
function memoryMi(value: unknown): number | null {
    const match = /^([0-9]{1,5})(Mi|Gi)$/.exec(String(value ?? ''))
    if (!match) return null
    return Number(match[1]) * (match[2] === 'Gi' ? 1024 : 1)
}

function imageProblem(image: unknown): string | null {
    const value = String(image ?? '')
    if (!value || value.length > 300 || CONTROL.test(value)) return 'Image fehlt oder ist ungültig'
    // 2.92.2 (Langtest C): test pods run without root; the official nginx image needs root and ends as „Failed“.
    if (/^(?:docker\.io\/)?(?:library\/)?nginx[:@]/i.test(value)) return 'Das offizielle nginx-Image braucht root und scheitert hier (Test-Pods laufen ohne root). Nimm nginxinc/nginx-unprivileged:<tag>, es lauscht auf Port 8080'
    const at = value.indexOf('@')
    if (at >= 0) return IMAGE_REPO.test(value.slice(0, at)) && IMAGE_DIGEST.test(value.slice(at + 1)) ? null : 'Image-Digest ungültig'
    const colon = value.lastIndexOf(':')
    if (colon < 0 || value.slice(colon).includes('/')) return 'Image braucht einen festen Tag (z. B. busybox:1.36)'
    const tag = value.slice(colon + 1)
    if (!IMAGE_REPO.test(value.slice(0, colon)) || !IMAGE_TAG.test(tag)) return 'Image oder Tag ungültig'
    if (tag === 'latest') return 'Tag latest ist nicht erlaubt — die Freigabe gilt einem festen Image'
    return null
}

function stringList(value: unknown, what: string): string | null {
    if (value === undefined) return null
    if (!Array.isArray(value) || value.length > MAX_ARGS) return `${what}: höchstens ${MAX_ARGS} Einträge`
    for (const item of value) if (typeof item !== 'string' || item.length > MAX_ARG_LENGTH || CONTROL.test(item)) return `${what}: ungültiger Eintrag`
    return null
}

function limitsProblem(resources: unknown): string | null {
    if (!isObject(resources) || extraKey(resources, ['limits', 'requests'])) return 'resources: nur limits und requests'
    const limits = resources.limits
    if (!isObject(limits) || limits.cpu === undefined || limits.memory === undefined) return 'Limits für CPU und Speicher sind Pflicht'
    for (const block of [limits, resources.requests]) {
        if (block === undefined) continue
        if (!isObject(block) || extraKey(block, ['cpu', 'memory'])) return 'resources: nur cpu und memory'
        if (block.cpu !== undefined) { const cpu = cpuMilli(block.cpu); if (cpu === null || cpu < 1 || cpu > MAX_CPU_MILLI) return `CPU höchstens ${MAX_CPU_MILLI}m` }
        if (block.memory !== undefined) { const mem = memoryMi(block.memory); if (mem === null || mem < 1 || mem > MAX_MEMORY_MI) return `Speicher höchstens ${MAX_MEMORY_MI}Mi` }
    }
    return null
}

const POD_KEYS = ['apiVersion', 'kind', 'metadata', 'spec'] as const
const METADATA_KEYS = ['name', 'namespace', 'labels'] as const
const SPEC_KEYS = ['containers', 'restartPolicy', 'activeDeadlineSeconds', 'automountServiceAccountToken', 'enableServiceLinks', 'securityContext'] as const
const POD_SECURITY_KEYS = ['runAsNonRoot', 'runAsUser', 'runAsGroup', 'seccompProfile'] as const
const CONTAINER_KEYS = ['name', 'image', 'command', 'args', 'env', 'resources', 'securityContext', 'imagePullPolicy'] as const
const CONTAINER_SECURITY_KEYS = ['privileged', 'allowPrivilegeEscalation', 'capabilities', 'readOnlyRootFilesystem', 'runAsNonRoot', 'runAsUser', 'runAsGroup'] as const
/** Named on purpose, so a refusal says what it is (the whitelist would refuse them anyway). */
const HOST_FIELDS = ['hostNetwork', 'hostPID', 'hostIPC', 'hostUsers'] as const

/** null = this pod may be created in xaventra-test; otherwise the reason. */
export function validateTestPod(body: unknown): string | null {
    if (!isObject(body) || body.apiVersion !== 'v1' || body.kind !== 'Pod') return 'nur ein Pod (apiVersion v1, kind Pod)'
    let extra = extraKey(body, POD_KEYS)
    if (extra) return `Pod-Feld ${extra} nicht erlaubt`
    const metadata = body.metadata
    if (!isObject(metadata)) return 'metadata fehlt'
    extra = extraKey(metadata, METADATA_KEYS)
    if (extra) return `metadata.${extra} nicht erlaubt`
    if (typeof metadata.name !== 'string' || !DNS_LABEL.test(metadata.name)) return 'ungültiger Pod-Name'
    if (metadata.namespace !== undefined && metadata.namespace !== KUBE_TEST_NAMESPACE) return `Namespace im Objekt muss ${KUBE_TEST_NAMESPACE} sein`
    const labels = metadata.labels
    if (!isObject(labels) || labels[TEST_POD_LABEL.key] !== TEST_POD_LABEL.value) return `Label ${TEST_POD_SELECTOR} fehlt — nur gelabelte Pods`
    for (const [key, value] of Object.entries(labels)) if (typeof value !== 'string' || key.length > 63 || value.length > 63 || CONTROL.test(key + value)) return 'ungültiges Label'

    const spec = body.spec
    if (!isObject(spec)) return 'spec fehlt'
    for (const field of HOST_FIELDS) if (field in spec) return `${field} ist tabu`
    if ('volumes' in spec) return 'Volumes sind tabu (kein hostPath)'
    extra = extraKey(spec, SPEC_KEYS)
    if (extra) return `spec.${extra} nicht erlaubt`
    if (spec.automountServiceAccountToken !== false) return 'Service-Account-Token muss aus sein (automountServiceAccountToken: false)'
    if (spec.restartPolicy !== 'Never' && spec.restartPolicy !== 'OnFailure') return 'restartPolicy nur Never oder OnFailure'
    if (!Number.isInteger(spec.activeDeadlineSeconds) || spec.activeDeadlineSeconds < 1 || spec.activeDeadlineSeconds > MAX_DEADLINE_S) return `Laufzeitgrenze (activeDeadlineSeconds) 1–${MAX_DEADLINE_S} s ist Pflicht`
    if (spec.enableServiceLinks !== undefined && spec.enableServiceLinks !== false) return 'enableServiceLinks nur false'
    if (spec.securityContext !== undefined) {
        const sc = spec.securityContext
        if (!isObject(sc)) return 'securityContext ungültig'
        extra = extraKey(sc, POD_SECURITY_KEYS)
        if (extra) return `securityContext.${extra} nicht erlaubt`
        if (sc.seccompProfile !== undefined && (!isObject(sc.seccompProfile) || extraKey(sc.seccompProfile, ['type']) || sc.seccompProfile.type !== 'RuntimeDefault')) return 'seccompProfile nur RuntimeDefault'
    }

    const containers = spec.containers
    if (!Array.isArray(containers) || containers.length < 1 || containers.length > 2) return '1–2 Container'
    for (const container of containers) {
        if (!isObject(container)) return 'Container ungültig'
        if ('ports' in container) return 'ports nicht erlaubt (kein hostPort)'
        if ('envFrom' in container) return 'envFrom nicht erlaubt (keine Secrets)'
        extra = extraKey(container, CONTAINER_KEYS)
        if (extra) return `Container-Feld ${extra} nicht erlaubt`
        if (typeof container.name !== 'string' || !DNS_LABEL.test(container.name)) return 'ungültiger Container-Name'
        const image = imageProblem(container.image)
        if (image) return image
        const list = stringList(container.command, 'command') || stringList(container.args, 'args')
        if (list) return list
        if (container.imagePullPolicy !== undefined && !['IfNotPresent', 'Always', 'Never'].includes(container.imagePullPolicy)) return 'imagePullPolicy ungültig'
        if (container.env !== undefined) {
            if (!Array.isArray(container.env) || container.env.length > MAX_ARGS) return 'env ungültig'
            for (const item of container.env) {
                if (!isObject(item)) return 'env ungültig'
                if ('valueFrom' in item) return 'env.valueFrom nicht erlaubt (keine Secrets)'
                if (extraKey(item, ['name', 'value']) || typeof item.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(item.name) || (item.value !== undefined && (typeof item.value !== 'string' || item.value.length > MAX_ARG_LENGTH))) return 'env ungültig'
            }
        }
        const limits = limitsProblem(container.resources)
        if (limits) return limits
        const sc = container.securityContext
        if (!isObject(sc)) return 'Container-securityContext ist Pflicht (allowPrivilegeEscalation: false)'
        extra = extraKey(sc, CONTAINER_SECURITY_KEYS)
        if (extra) return `Container-securityContext.${extra} nicht erlaubt`
        if (sc.privileged !== undefined && sc.privileged !== false) return 'privileged ist tabu'
        if (sc.allowPrivilegeEscalation !== false) return 'allowPrivilegeEscalation muss false sein (keine Privilege Escalation)'
        if (sc.capabilities !== undefined) {
            if (!isObject(sc.capabilities) || extraKey(sc.capabilities, ['drop'])) return 'Capabilities hinzufügen ist tabu'
            if (!Array.isArray(sc.capabilities.drop) || sc.capabilities.drop.some((item: unknown) => typeof item !== 'string')) return 'capabilities.drop ungültig'
        }
    }
    return null
}

/** The only pod shape Xaventra creates. Invalid input is refused before any approval is asked. */
export function buildTestPod(input: TestPodInput): TestPodBuild {
    const name = String(input?.name ?? '').trim()
    if (!DNS_LABEL.test(name)) return { ok: false, reason: 'Ungültiger Name (Kleinbuchstaben, Ziffern, Bindestrich; max. 63).' }
    const image = String(input?.image ?? '').trim()
    const imageWhy = imageProblem(image)
    if (imageWhy) return { ok: false, reason: `${imageWhy}.` }
    const command = input?.command?.length ? input.command.map(String) : undefined
    const listWhy = stringList(command, 'Kommando')
    if (listWhy) return { ok: false, reason: `${listWhy}.` }
    const cpu = String(input?.cpu || DEFAULT_CPU).trim()
    const cpuValue = cpuMilli(cpu)
    if (cpuValue === null || cpuValue < 1 || cpuValue > MAX_CPU_MILLI) return { ok: false, reason: `CPU höchstens ${MAX_CPU_MILLI}m (z. B. 250m).` }
    const memory = String(input?.memory || DEFAULT_MEMORY).trim()
    const memoryValue = memoryMi(memory)
    if (memoryValue === null || memoryValue < 1 || memoryValue > MAX_MEMORY_MI) return { ok: false, reason: `Speicher höchstens ${MAX_MEMORY_MI}Mi (z. B. 128Mi).` }
    const deadline = input?.laufzeitSekunden === undefined ? DEFAULT_DEADLINE_S : Math.round(Number(input.laufzeitSekunden))
    if (!Number.isFinite(deadline) || deadline < 1 || deadline > MAX_DEADLINE_S) return { ok: false, reason: `Laufzeit 1–${MAX_DEADLINE_S / 60} Minuten.` }
    const pod = {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name, namespace: KUBE_TEST_NAMESPACE, labels: { [TEST_POD_LABEL.key]: TEST_POD_LABEL.value } },
        spec: {
            restartPolicy: 'Never',
            activeDeadlineSeconds: deadline,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
            containers: [{
                name: 'main',
                image,
                ...(command ? { command } : {}),
                resources: { requests: { cpu, memory }, limits: { cpu, memory } },
                securityContext: { privileged: false, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
            }],
        },
    }
    const why = validateTestPod(pod)
    if (why) return { ok: false, reason: `${why}.` }
    const summary = `Pod ${name} in ${KUBE_TEST_NAMESPACE}: ${image}${command ? ` · ${command.join(' ').slice(0, 120)}` : ''} · ${cpu} CPU, ${memory} · höchstens ${Math.ceil(deadline / 60)} min · Label ${TEST_POD_SELECTOR}`
    return { ok: true, pod, summary }
}

const DELETE_OPTION_KEYS = ['apiVersion', 'kind', 'preconditions', 'gracePeriodSeconds'] as const

/**
 * Guard for every request into xaventra-test (called by checkKubeRequest after
 * the forbidden segments). null = allowed.
 */
export function checkTestNamespaceRequest(method: string, group: string, resource: string | undefined, name: string | undefined, sub: string | undefined, body: unknown): string | null {
    if (group !== 'core' || resource !== 'pods') return `im ${KUBE_TEST_NAMESPACE} nur Pods`
    if (sub !== undefined) return method === 'GET' && sub === 'log' && name !== undefined ? null : 'Pod-Unterressource nicht erlaubt'
    if (method === 'GET') return null
    if (method === 'POST') return name === undefined ? validateTestPod(body) : 'Pfad nicht erlaubt'
    if (method === 'DELETE') {
        if (name === undefined) return 'nie alle Pods auf einmal löschen'
        if (body === undefined) return null
        if (!isObject(body) || extraKey(body, DELETE_OPTION_KEYS)) return 'Löschen nur mit uid-Vorbedingung'
        if (body.preconditions !== undefined && (!isObject(body.preconditions) || extraKey(body.preconditions, ['uid']))) return 'Löschen nur mit uid-Vorbedingung'
        return null
    }
    return 'Test-Pods werden nie geändert — nur angelegt oder gelöscht'
}
