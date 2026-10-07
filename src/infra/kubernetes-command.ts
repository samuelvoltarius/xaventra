/**
 * /cluster (Owner), the Kubernetes Knopf-Karten and the worker autoscaler
 * (2.88, Paket P19).
 *
 * - Read: status, events, logs — no card.
 * - Scale an own worker Deployment within min/max, rollout-restart an own
 *   worker — no card (bounded and reversible), but only with the Main lease.
 * - Restart of the Main or an optional workload, every chart update (diff
 *   preview first) and everything that switches something off — Knopf-Karte,
 *   runs only after the owner's Ja; the executor re-reads the cluster first.
 * - Workers (NOVA_NODE_ONLY=true) never act and never talk to the owner.
 * - Autoscaler: many open tasks → more workers, idle → fewer, inside the
 *   chart's min/max with a cooldown. Only the lease-holding Main scales.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    createApprovalCard, getCardExecutor, registerCardExecutor, type ApprovalCard, type CardExecutor, type CardStoreOptions,
} from '../core/approval-cards.js'
import type { NodeProfile } from '../core/node-profile.js'
import { formatLabelSuggestions } from './kubernetes-node.js'
import {
    KUBERNETES_NEVER, loadKubernetesRuntime, parseChartChanges, readKubernetesRawConfig,
    type ChartPlan, type ClusterEvent, type ClusterStatus, type KubernetesRuntime,
} from './kubernetes.js'

export interface FenceVerdict { ok: boolean; reason: string }
export interface ClusterDeps {
    runtime?: () => Promise<KubernetesRuntime>
    cardOpts?: CardStoreOptions
    nodeOnly?: boolean
    now?: () => number
    /** Main lease check before every write (default: the nova-main fence, live). */
    fence?: (effect: string) => Promise<FenceVerdict>
    /** Open tasks for the autoscaler (default: command lanes + pending task queue). */
    openTasks?: () => number
    /** Node profiles for label suggestions (default: own profile + mesh peers). */
    profiles?: () => Promise<Array<{ nodeId: string; profile: NodeProfile | null }>>
    log?: (line: string) => void
}

export const K8S_CARD = Object.freeze({
    update: { kind: 'k8s-chart-update', effect: 'infra:k8s-update', label: 'Chart-Update anwenden' },
    restart: { kind: 'k8s-neustart', effect: 'infra:k8s-restart', label: 'Workload neu starten' },
})

const isWorker = (deps: ClusterDeps) => deps.nodeOnly ?? process.env.NOVA_NODE_ONLY === 'true'
const runtimeOf = (deps: ClusterDeps) => (deps.runtime || (() => loadKubernetesRuntime({ rawConfig: readKubernetesRawConfig() })))()
const nowOf = (deps: ClusterDeps) => (deps.now || Date.now)()
const safe = (error: unknown) => String((error as Error)?.message || error).slice(0, 240)
const WORKER_ONLY_TEXT = 'Kubernetes-Steuerung gibt es nur am Main (Worker handeln nicht und schreiben dem Owner nicht).'

async function defaultFence(effect: string): Promise<FenceVerdict> {
    try {
        const { assertFenced } = await import('../mesh/fence.js')
        return await assertFenced('nova-main', { live: true, effect })
    } catch (error) {
        return { ok: false, reason: safe(error) }
    }
}
async function fenced(deps: ClusterDeps, effect: string): Promise<FenceVerdict> {
    return (deps.fence || defaultFence)(effect)
}

function planDir(deps: ClusterDeps): string {
    const base = deps.cardOpts?.dataDir || join(process.env.NOVA_RUNTIME_ROOT || process.cwd(), '.nova-data')
    return join(base, 'kubernetes-plans')
}
const PLAN_ID = /^k8splan-[0-9a-f]{12}$/
function savePlan(deps: ClusterDeps, plan: ChartPlan): void {
    const dir = planDir(deps)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${plan.id}.json`), JSON.stringify(plan, null, 2))
}
function loadPlan(deps: ClusterDeps, id: string): ChartPlan | null {
    if (!PLAN_ID.test(id)) return null
    try { return JSON.parse(readFileSync(join(planDir(deps), `${id}.json`), 'utf8')) as ChartPlan } catch { return null }
}

// ---------------------------------------------------------------------------
// Overview text
// ---------------------------------------------------------------------------

export function formatClusterStatus(status: ClusterStatus, events: ClusterEvent[]): string {
    const lines = [`*Kubernetes* — Namespace ${status.namespace}, Release ${status.release} (Kubernetes entscheidet WO, Xaventra WAS)`]
    for (const w of status.workloads) {
        const bounds = w.role === 'main' ? 'Führung über Xaventras Lease' : `${w.min}–${w.max}${w.autoscale ? ', automatisch' : ''}`
        lines.push(`${w.found ? (w.ready >= w.desired && w.desired > 0 ? '🟢' : w.desired === 0 ? '⚫' : '🟡') : '❔'} *${w.name}* (${w.kind}) — ${w.ready}/${w.desired} bereit, Grenzen ${bounds}${w.image ? ` — ${w.image}` : ''}`)
    }
    if (status.pods.length) {
        lines.push('', 'Pods:')
        for (const pod of status.pods) lines.push(`• ${pod.name} — ${pod.phase}${pod.ready ? '' : ', nicht bereit'}${pod.restarts ? `, ${pod.restarts} Neustarts` : ''}${pod.node ? `, Node ${pod.node}` : ''}`)
    }
    const warnings = events.filter(event => event.type === 'Warning')
    if (warnings.length) {
        lines.push('', 'Warnungen:')
        for (const event of warnings.slice(0, 5)) lines.push(`⚠️ ${event.object}: ${event.reason} — ${event.message}${event.count > 1 ? ` (${event.count}×)` : ''}`)
    }
    lines.push('', '/cluster hilfe zeigt, was geht.')
    return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export async function proposeChartUpdate(input: string, deps: ClusterDeps = {}, options: { titel?: string } = {}): Promise<{ ok: boolean; message: string; card?: ApprovalCard }> {
    if (isWorker(deps)) return { ok: false, message: WORKER_ONLY_TEXT }
    const changes = parseChartChanges(input)
    if (typeof changes === 'string') return { ok: false, message: changes }
    const runtime = await runtimeOf(deps)
    if (runtime.ok === false) return { ok: false, message: `Kubernetes-Steuerung ist aus: ${runtime.reason}` }
    let plan: Awaited<ReturnType<typeof runtime.client.planChartUpdate>>
    try { plan = await runtime.client.planChartUpdate(changes) } catch (error) { return { ok: false, message: safe(error) } }
    if (!('lines' in plan)) return { ok: false, message: `${plan.message} Keine Karte.` }
    savePlan(deps, plan)
    registerKubernetesCardExecutors(deps)
    const removing = plan.removes.length > 0
    const result = createApprovalCard({
        art: 'kubernetes',
        titel: options.titel || (removing ? `Kubernetes: ${plan.removes.join(', ')} abschalten (entfernt Workload)` : `Kubernetes: Chart-Update (${plan.lines.length} Änderung${plan.lines.length === 1 ? '' : 'en'})`),
        beleg: [`Namespace ${runtime.policy.namespace}, Release ${runtime.policy.release}.`, 'Vorschau (vorher → nachher):', ...plan.lines.map(line => `• ${line}`)].join('\n'),
        vorschlag: `${K8S_CARD.update.label}. Vor dem Anwenden liest Xaventra den Cluster neu; hat er sich geändert, passiert nichts. Rückweg: dieselben Werte zurück per /cluster update (wieder mit Karte)${removing ? '; abgeschaltete Workloads mit <name>.enabled=true wieder einschalten (Daten-PVCs bleiben)' : ''}.`,
        aktion: { kind: K8S_CARD.update.kind, ref: plan.id },
        wirkung: 'infra',
        effects: [K8S_CARD.update.effect],
        ablaufMs: 2 * 60 * 60_000,
        dedupeKey: `kubernetes:update:${changes.map(change => `${change.path}=${change.value}`).join(',')}`.slice(0, 200),
        quelle: 'kubernetes',
    }, deps.cardOpts)
    if (result.ok === false) return { ok: false, message: `Keine Karte: ${result.reason}` }
    return {
        ok: true, card: result.card,
        message: result.created ? `🔘 Karte erstellt (${removing ? 'entfernt Workload' : 'Chart-Update'}). Angewendet wird erst nach deinem Ja.\n${plan.lines.map(line => `• ${line}`).join('\n')}` : '🔘 Diese Karte liegt schon offen.',
    }
}

export async function proposeRestart(workload: string, deps: ClusterDeps = {}): Promise<{ ok: boolean; message: string; card?: ApprovalCard }> {
    if (isWorker(deps)) return { ok: false, message: WORKER_ONLY_TEXT }
    const runtime = await runtimeOf(deps)
    if (runtime.ok === false) return { ok: false, message: `Kubernetes-Steuerung ist aus: ${runtime.reason}` }
    const w = runtime.policy.workloads[workload]
    if (!w) return { ok: false, message: `Unbekannte Workload „${String(workload).slice(0, 63)}“.` }
    registerKubernetesCardExecutors(deps)
    const result = createApprovalCard({
        art: 'kubernetes',
        titel: `Kubernetes: ${w.name} neu starten`,
        beleg: `${w.kind} ${w.object} in ${runtime.policy.namespace}. ${w.role === 'main' ? 'Die Main ist kurz weg; Telegram/Dashboard sind während des Tauschs nicht erreichbar. Die Führung übernimmt danach wieder, wer Xaventras Lease hält.' : 'Optionale Workload; Kubernetes tauscht die Pods.'}`,
        vorschlag: `${K8S_CARD.restart.label} (rollout restart). Rückweg: keiner nötig — Daten und Werte bleiben.`,
        aktion: { kind: K8S_CARD.restart.kind, ref: w.name },
        wirkung: 'infra',
        effects: [K8S_CARD.restart.effect],
        ablaufMs: 60 * 60_000,
        dedupeKey: `kubernetes:restart:${w.name}`,
        quelle: 'kubernetes',
    }, deps.cardOpts)
    if (result.ok === false) return { ok: false, message: `Keine Karte: ${result.reason}` }
    return { ok: true, card: result.card, message: result.created ? `🔘 Karte erstellt (${w.name} neu starten). Ausgeführt wird erst nach deinem Ja.` : '🔘 Diese Karte liegt schon offen.' }
}

export function createKubernetesCardExecutors(deps: ClusterDeps = {}): CardExecutor[] {
    const update: CardExecutor = {
        kind: K8S_CARD.update.kind,
        impact: 'infra',
        allowAlways: () => false,
        async execute(card) {
            if (isWorker(deps)) return { ok: false, message: 'Worker führen keine Kubernetes-Aktionen aus.' }
            const plan = loadPlan(deps, card.aktion.ref)
            if (!plan) return { ok: false, message: 'Vorschau nicht mehr vorhanden — nichts geändert.' }
            const runtime = await runtimeOf(deps)
            if (runtime.ok === false) return { ok: false, message: `Kubernetes-Steuerung ist aus: ${runtime.reason} — nichts geändert.` }
            const fence = await fenced(deps, 'k8s:chart-update')
            if (!fence.ok) return { ok: false, message: `Keine Main-Lease (${fence.reason}) — nichts geändert.` }
            try {
                const result = await runtime.client.applyChartUpdate(plan)
                return { ok: result.ok, message: result.message }
            } catch (error) { return { ok: false, message: safe(error) } }
        },
        async reject() { return { ok: true, message: 'Abgelehnt — an Kubernetes wurde nichts gesendet.' } },
        // 2.89: closed when the stored preview is gone (the cluster is read again before applying).
        isStillOpen(card) { return loadPlan(deps, card.aktion.ref) !== null },
    }
    const restart: CardExecutor = {
        kind: K8S_CARD.restart.kind,
        impact: 'infra',
        allowAlways: () => false,
        async execute(card) {
            if (isWorker(deps)) return { ok: false, message: 'Worker führen keine Kubernetes-Aktionen aus.' }
            const runtime = await runtimeOf(deps)
            if (runtime.ok === false) return { ok: false, message: `Kubernetes-Steuerung ist aus: ${runtime.reason} — nichts geändert.` }
            const fence = await fenced(deps, 'k8s:restart')
            if (!fence.ok) return { ok: false, message: `Keine Main-Lease (${fence.reason}) — nichts geändert.` }
            try {
                const result = await runtime.client.restartWorkload(card.aktion.ref, { approved: true })
                return { ok: result.ok, message: result.message }
            } catch (error) { return { ok: false, message: safe(error) } }
        },
        async reject() { return { ok: true, message: 'Abgelehnt — an Kubernetes wurde nichts gesendet.' } },
        // 2.89: a restart is never „done elsewhere“ — the workload is checked against the policy on the press.
        isStillOpen: () => true,
    }
    return [update, restart]
}

export function registerKubernetesCardExecutors(deps: ClusterDeps = {}, options: { force?: boolean } = {}): void {
    for (const executor of createKubernetesCardExecutors(deps)) {
        if (!options.force && getCardExecutor(executor.kind)) continue
        registerCardExecutor(executor)
    }
}

// ---------------------------------------------------------------------------
// Autoscaler
// ---------------------------------------------------------------------------

export interface ScaleInput {
    replicas: number; min: number; max: number; openTasks: number; tasksPerWorker: number
    now: number; lastChangeAt: number; cooldownMs: number; idleSince: number | null; idleMs: number
}

/** Pure decision. Up: enough workers for the open tasks. Down: one step after idling. */
export function decideWorkerScale(input: ScaleInput): { target: number; reason: string } | null {
    const { replicas, min, max } = input
    if (replicas < min) return { target: min, reason: 'unter dem Minimum' }
    if (replicas > max) return { target: max, reason: 'über dem Maximum' }
    if (input.now - input.lastChangeAt < input.cooldownMs) return null
    const wanted = Math.min(max, Math.max(min, Math.ceil(Math.max(0, input.openTasks) / Math.max(1, input.tasksPerWorker))))
    if (wanted > replicas) return { target: wanted, reason: `${input.openTasks} offene Aufgaben` }
    if (input.openTasks === 0 && input.idleSince !== null && input.now - input.idleSince >= input.idleMs && replicas > min) {
        return { target: replicas - 1, reason: `Leerlauf seit ${Math.round((input.now - input.idleSince) / 60_000)} min` }
    }
    return null
}

async function defaultOpenTasks(): Promise<number> {
    let total = 0
    try { total += (await import('../process/command-queue.js')).getTotalQueueSize() } catch { /* optional */ }
    try { total += (await import('../core/tasks.js')).getTaskQueue().getPendingTasks().length } catch { /* optional */ }
    return total
}

export class ClusterAutoscaler {
    private readonly lastChange = new Map<string, number>()
    private idleSince: number | null = null
    private timer: ReturnType<typeof setInterval> | null = null

    constructor(private readonly deps: ClusterDeps = {}) {}

    async tick(): Promise<Array<{ workload: string; target: number; reason: string }>> {
        if (isWorker(this.deps)) return []
        const runtime = await runtimeOf(this.deps)
        if (runtime.ok === false) return []
        const auto = Object.values(runtime.policy.workloads).filter(w => w.autoscale)
        if (!auto.length) return []
        const now = nowOf(this.deps)
        const open = this.deps.openTasks ? this.deps.openTasks() : await defaultOpenTasks()
        if (open > 0) this.idleSince = null
        else if (this.idleSince === null) this.idleSince = now
        let status: ClusterStatus
        try { status = await runtime.client.status() } catch (error) { this.deps.log?.(`[Kubernetes] Autoskalierung: Status nicht lesbar (${safe(error)})`); return [] }
        const done: Array<{ workload: string; target: number; reason: string }> = []
        for (const w of auto) {
            const live = status.workloads.find(item => item.name === w.name)
            if (!live?.found) continue
            const decision = decideWorkerScale({
                replicas: live.desired, min: w.min, max: w.max, openTasks: open, tasksPerWorker: runtime.policy.autoscale.tasksPerWorker,
                now, lastChangeAt: this.lastChange.get(w.name) ?? 0, cooldownMs: runtime.policy.autoscale.cooldownSeconds * 1000,
                idleSince: this.idleSince, idleMs: runtime.policy.autoscale.idleMinutes * 60_000,
            })
            if (!decision || decision.target === live.desired) continue
            // Only the lease-holding Main scales; a standby or split Main stays still.
            const fence = await fenced(this.deps, 'k8s:autoscale')
            if (!fence.ok) return done
            try {
                const result = await runtime.client.scaleWorker(w.name, decision.target, `Autoskalierung: ${decision.reason}`)
                if (result.ok) { this.lastChange.set(w.name, now); done.push({ workload: w.name, ...decision }) }
            } catch (error) { this.deps.log?.(`[Kubernetes] Autoskalierung ${w.name}: ${safe(error)}`) }
        }
        return done
    }

    start(intervalMs = 60_000): void {
        if (this.timer) return
        this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, intervalMs)
        this.timer.unref?.()
    }

    stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
}

/** Daemon hook: starts the autoscaler only in a pod with chart control enabled. */
export async function startClusterControl(deps: ClusterDeps = {}): Promise<{ started: boolean; reason: string; autoscaler?: ClusterAutoscaler }> {
    if (isWorker(deps)) return { started: false, reason: 'Worker' }
    const runtime = await runtimeOf(deps)
    if (runtime.ok === false) return { started: false, reason: runtime.reason }
    registerKubernetesCardExecutors(deps)
    const autoscaler = new ClusterAutoscaler(deps)
    const auto = Object.values(runtime.policy.workloads).filter(w => w.autoscale).map(w => `${w.name} ${w.min}–${w.max}`)
    if (auto.length) autoscaler.start(runtime.policy.autoscale.intervalSeconds * 1000)
    return { started: true, reason: auto.length ? `Autoskalierung: ${auto.join(', ')}` : 'Steuerung aktiv, keine Autoskalierung', autoscaler }
}

// ---------------------------------------------------------------------------
// /cluster
// ---------------------------------------------------------------------------

const NEVER_WORDS = /^(exec|shell|sh|bash|attach|portforward|port-forward|proxy|secret|secrets|token|kubectl|helm|namespace|namespaces|ns|delete|loeschen|löschen|entfernen|drain|cordon|taint|pvc|rbac|node-labels-setzen)$/i

async function defaultProfiles(): Promise<Array<{ nodeId: string; profile: NodeProfile | null }>> {
    const { collectNodeProfile } = await import('../core/node-profile.js')
    const { getMeshPeerStates } = await import('../mesh/mesh-transport-runtime.js')
    const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
    const localId = getLocalNodeId()
    const local = await collectNodeProfile()
    const peers = Object.values(getMeshPeerStates()).filter(peer => peer.nodeId && peer.nodeId !== localId)
        .sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(peer => ({ nodeId: peer.nodeId, profile: peer.profile || null }))
    return [{ nodeId: localId, profile: { ...local, nodeId: localId } }, ...peers]
}

export const CLUSTER_HELP = [
    '/cluster — Workloads, Pods, Warnungen (lesend)',
    '/cluster events · /cluster logs <pod> [zeilen]',
    '/cluster skalieren <worker> <anzahl> — innerhalb der Chart-Grenzen, ohne Karte',
    '/cluster neustart <workload> — eigene Worker sofort, Main/optionale per Karte',
    '/cluster update image.tag=… <workload>.resources.limits.memory=… <workload>.min|max=… — Vorschau + Karte',
    '/cluster abschalten <workload> — Karte (entfernt die Workload; Daten bleiben)',
    '/cluster labels — Node-Label-Vorschläge (nur Ausgabe)',
    `Nie: ${KUBERNETES_NEVER.join('; ')}.`,
].join('\n')

export async function handleClusterCommand(args: string, deps: ClusterDeps = {}): Promise<string> {
    const parts = String(args || '').trim().split(/\s+/).filter(Boolean)
    const sub = (parts[0] || '').toLowerCase()
    const answer = (result: { ok: boolean; message: string }) => result.ok ? result.message : `❌ ${result.message}`
    if (sub && NEVER_WORDS.test(sub)) return `⛔ „${sub}“ macht Xaventra im Cluster nie.\nNie: ${KUBERNETES_NEVER.join('; ')}.`
    if (sub === 'hilfe' || sub === 'help') return CLUSTER_HELP
    if (isWorker(deps)) return WORKER_ONLY_TEXT
    if (sub === 'labels') return formatLabelSuggestions(await (deps.profiles || defaultProfiles)())
    if (sub === 'update') return answer(await proposeChartUpdate(parts.slice(1).join(' '), deps))
    if (sub === 'abschalten') {
        const workload = String(parts[1] || '').toLowerCase()
        if (!workload) return 'Bitte Workload angeben, z. B. /cluster abschalten voice'
        return answer(await proposeChartUpdate(`${workload}.enabled=false`, deps))
    }
    const runtime = await runtimeOf(deps)
    if (runtime.ok === false) return `Kubernetes-Steuerung ist aus: ${runtime.reason}. Einrichtung: docs/KUBERNETES.md`
    try {
        if (sub === 'skalieren' || sub === 'scale') {
            const workload = String(parts[1] || '').toLowerCase()
            const replicas = Number(parts[2])
            if (!workload || !Number.isInteger(replicas)) return 'Format: /cluster skalieren worker-general 3'
            const fence = await fenced(deps, 'k8s:scale')
            if (!fence.ok) return `❌ Keine Main-Lease (${fence.reason}) — nichts geändert.`
            return answer(await runtime.client.scaleWorker(workload, replicas))
        }
        if (sub === 'neustart' || sub === 'restart') {
            const workload = String(parts[1] || '').toLowerCase()
            const w = runtime.policy.workloads[workload]
            if (!w) return `❌ Unbekannte Workload „${workload.slice(0, 63)}“.`
            if (w.role !== 'worker') return answer(await proposeRestart(workload, deps))
            const fence = await fenced(deps, 'k8s:restart')
            if (!fence.ok) return `❌ Keine Main-Lease (${fence.reason}) — nichts geändert.`
            return answer(await runtime.client.restartWorkload(workload))
        }
        if (sub === 'events') {
            const events = await runtime.client.events(20)
            if (!events.length) return 'Keine Events.'
            return events.map(e => `${e.type === 'Warning' ? '⚠️' : '•'} ${e.at} ${e.object}: ${e.reason} — ${e.message}${e.count > 1 ? ` (${e.count}×)` : ''}`).join('\n')
        }
        if (sub === 'logs') {
            if (!parts[1]) return 'Format: /cluster logs <pod> [zeilen]'
            const text = await runtime.client.logs(parts[1], Number(parts[2]) || 100)
            return `*Logs ${parts[1]}* (letzte Zeilen, Geheimnisse geschwärzt)\n${text.slice(-3500)}`
        }
        if (sub && !['status', 'liste', 'list'].includes(sub)) return `Unbekannt: /cluster ${sub}. /cluster hilfe zeigt alles.`
        const [status, events] = await Promise.all([runtime.client.status(), runtime.client.events(10)])
        return formatClusterStatus(status, events)
    } catch (error) {
        return `❌ ${safe(error)}`
    }
}
