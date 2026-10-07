/**
 * /cluster (Owner) and the Kubernetes Knopf-Karten (2.88 P19, 2.89 P21).
 *
 * - Read: status, events, logs — no card.
 * - Rollout-restart an own worker DaemonSet — no card (bounded and
 *   reversible), but only with the Main lease.
 * - Restart of the Main or an optional workload and every chart update (image
 *   tag, resources; diff preview first) — Knopf-Karte, runs only after the
 *   owner's Ja; the executor re-reads the cluster first.
 * - No scaling and no autoscaler: workers are DaemonSets, one pod per node the
 *   owner labelled. Switching workers on/off or adding nodes is the owner's
 *   job (helm, node labels); /cluster explains it and sends nothing.
 * - Workers (NOVA_NODE_ONLY=true) never act and never talk to the owner.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    createApprovalCard, getCardExecutor, registerCardExecutor, type ApprovalCard, type CardExecutor, type CardStoreOptions,
} from '../core/approval-cards.js'
import type { NodeProfile } from '../core/node-profile.js'
import { formatLabelSuggestions } from './kubernetes-node.js'
import {
    KUBERNETES_NEVER, loadKubernetesRuntime, parseChartChanges, readKubernetesRawConfig, scaleExplanation,
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
const safe = (error: unknown) => String((error as Error)?.message || error).slice(0, 240)
const WORKER_ONLY_TEXT = 'Kubernetes-Steuerung gibt es nur am Main (Worker handeln nicht und schreiben dem Owner nicht).'
const DEFAULT_WORKER_LABEL = 'xaventra.ai/worker'

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
        const where = w.role === 'main' ? 'Führung über Xaventras Lease' : `je Knoten mit ${status.workerNodeLabel}=true`
        const icon = !w.found ? '❔' : w.desired === 0 ? '⚫' : w.ready >= w.desired ? '🟢' : '🟡'
        lines.push(`${icon} *${w.name}* (${w.kind}) — ${w.ready}/${w.desired} bereit${w.kind === 'DaemonSet' && w.updated < w.desired ? `, ${w.updated} aktuell` : ''}, ${where}${w.image ? ` — ${w.image}` : ''}`)
        if (w.found && w.kind === 'DaemonSet' && w.desired === 0) lines.push(`   (noch kein Knoten freigegeben: ${status.workerNodeLabel}=true setzt der Owner)`)
    }
    if (status.pods.length) {
        lines.push('', 'Pods:')
        for (const pod of status.pods) lines.push(`• ${pod.name} — ${pod.phase}${pod.ready ? '' : ', nicht bereit'}${pod.restarts ? `, ${pod.restarts} Neustarts` : ''}${pod.node ? `, Knoten ${pod.node}` : ''}`)
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
    const result = createApprovalCard({
        art: 'kubernetes',
        titel: options.titel || `Kubernetes: Chart-Update (${plan.lines.length} Änderung${plan.lines.length === 1 ? '' : 'en'})`,
        beleg: [`Namespace ${runtime.policy.namespace}, Release ${runtime.policy.release}.`, 'Vorschau (vorher → nachher):', ...plan.lines.map(line => `• ${line}`)].join('\n'),
        vorschlag: `${K8S_CARD.update.label}. Vor dem Anwenden liest Xaventra den Cluster neu; hat er sich geändert, passiert nichts. Kubernetes tauscht die Worker-Pods Knoten für Knoten. Rückweg: dieselben Werte zurück per /cluster update (wieder mit Karte).`,
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
        message: result.created ? `🔘 Karte erstellt (Chart-Update). Angewendet wird erst nach deinem Ja.\n${plan.lines.map(line => `• ${line}`).join('\n')}` : '🔘 Diese Karte liegt schon offen.',
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
        beleg: `${w.kind} ${w.object} in ${runtime.policy.namespace}. ${w.role === 'main' ? 'Die Main ist kurz weg; Telegram/Dashboard sind während des Tauschs nicht erreichbar. Die Führung übernimmt danach wieder, wer Xaventras Lease hält.' : 'Optionale Workload; Kubernetes tauscht den Pod je Knoten.'}`,
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

/** Daemon hook (Main only): registers the card executors so card answers work after a restart. No autoscaler. */
export async function startClusterControl(deps: ClusterDeps = {}): Promise<{ started: boolean; reason: string }> {
    if (isWorker(deps)) return { started: false, reason: 'Worker' }
    const runtime = await runtimeOf(deps)
    if (runtime.ok === false) return { started: false, reason: runtime.reason }
    registerKubernetesCardExecutors(deps)
    const workers = Object.values(runtime.policy.workloads).filter(w => w.kind === 'DaemonSet').map(w => w.name)
    return { started: true, reason: `Steuerung aktiv (Namespace ${runtime.policy.namespace}; Worker-DaemonSets: ${workers.join(', ') || 'keine'}; keine Auto-Skalierung)` }
}

// ---------------------------------------------------------------------------
// /cluster
// ---------------------------------------------------------------------------

const NEVER_WORDS = /^(exec|shell|sh|bash|attach|portforward|port-forward|proxy|secret|secrets|token|kubectl|helm|namespace|namespaces|ns|delete|loeschen|löschen|entfernen|drain|cordon|taint|label|pvc|rbac|node-labels-setzen)$/i

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
    '/cluster neustart <workload> — eigene Worker sofort, Main/optionale per Karte',
    '/cluster update image.tag=… <workload>.resources.limits.memory=… — Vorschau + Karte',
    '/cluster skalieren · /cluster abschalten — erklärt nur: Worker sind DaemonSets (ein Pod je freigegebenem Knoten), Knoten freigeben macht der Owner',
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
    if (sub === 'skalieren' || sub === 'scale' || sub === 'abschalten') {
        // No API call at all: there is nothing Xaventra may scale or switch off.
        const runtime = await runtimeOf(deps)
        const label = runtime.ok ? runtime.policy.workerNodeLabel : DEFAULT_WORKER_LABEL
        const off = sub === 'abschalten' ? ' Eine Workload ganz abschalten: helm upgrade mit workers.<name>.enabled=false (Owner).' : ''
        return `ℹ️ ${scaleExplanation({ workerNodeLabel: label })}${off}`
    }
    const runtime = await runtimeOf(deps)
    if (runtime.ok === false) return `Kubernetes-Steuerung ist aus: ${runtime.reason}. Einrichtung: docs/KUBERNETES.md`
    try {
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
