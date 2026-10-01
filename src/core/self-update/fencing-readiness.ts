/**
 * Phase 4 preparation: "is NOVA_FENCING_MODE=enforce safe?" as a read-only
 * report. Never switches the mode, never writes to the coordinator.
 *
 * Lesson 30.09.2026: v5 granted EXECUTE only to nova_anon while PostgREST used
 * a dedicated app role -> 403 on the new RPCs, every lease lost. So the probe
 * asks with the REAL app key: read-only (STABLE) RPCs are called via GET (a
 * read-only transaction in PostgREST), the two writing RPCs are checked via
 * the OpenAPI listing, which only shows functions the role may execute.
 */

import { compareUpdateVersions } from '../github-update.js'
import type { CoordinatorFencingStatus } from '../../mesh/leader-election.js'
import { makeThought, type Thought, type ThoughtSink } from './thought-sink.js'

/** First release with lease fencing (sequence epochs, instance ids, high-water mark). */
export const FENCE_SUPPORT_MIN_VERSION = '2.79.0'
export const V5_RPCS = ['nova_acquire_service_lease_v2', 'nova_check_fence', 'nova_fenced_upsert_shared_memory', 'nova_fencing_status'] as const
export type V5Rpc = typeof V5_RPCS[number]
/** granted = app role may execute; denied = 401/403 or hidden for the role; absent = 404; unknown = not determinable. */
export type RpcAccess = 'granted' | 'denied' | 'absent' | 'unknown'

export interface FencingFacts {
    appRole: string
    rpcs: Record<V5Rpc, RpcAccess>
    coordinator: CoordinatorFencingStatus | null
    /** Lease RPC generation of this process (leader-election getLeaseProtocol()). */
    leaseProtocol: 'v2' | 'v1' | null
    /** Current coordinator epoch per service (from nova_check_fence, read-only). */
    currentEpochs: Record<string, number | null>
    nodes: Array<{ nodeId: string; version: string; status: 'online' | 'offline' | 'busy' }>
    /** Per active node: persisted receiver high-water marks; null = node did not report. */
    highWater: Record<string, Record<string, number> | null>
}

export interface ReadinessCheck { id: string; ok: boolean; evidence: string }
export interface FencingReadinessReport { safe: boolean; checks: ReadinessCheck[] }

export function evaluateFencingEnforceReadiness(facts: FencingFacts, minVersion = FENCE_SUPPORT_MIN_VERSION): FencingReadinessReport {
    const checks: ReadinessCheck[] = []
    const status = facts.coordinator
    const absent = V5_RPCS.filter(name => facts.rpcs[name] === 'absent')
    const v5Present = absent.length === 0 && Boolean(status && Number(status.version) >= 5 && status.epoch_sequence === true && status.epoch_guard_trigger === true)
    checks.push({
        id: 'v5-rpcs-present', ok: v5Present,
        evidence: absent.length ? `fehlend: ${absent.join(', ')}` : status ? `Koordinator v${status.version ?? '?'}, Sequenz ${status.epoch_sequence}, Trigger ${status.epoch_guard_trigger}` : 'nova_fencing_status nicht lesbar',
    })
    const notGranted = V5_RPCS.filter(name => facts.rpcs[name] !== 'granted')
    checks.push({
        id: 'app-role-execute', ok: notGranted.length === 0,
        evidence: notGranted.length
            ? `App-Rolle ${facts.appRole} ohne belegtes EXECUTE auf ${notGranted.map(name => `${name} (${facts.rpcs[name]})`).join(', ')} — 403-Gefahr wie 30.09.`
            : `App-Rolle ${facts.appRole} darf alle ${V5_RPCS.length} v5-RPCs ausführen`,
    })
    checks.push({
        id: 'lease-table-locked', ok: Boolean(status && status.lease_table_anon_writable === false && Number(status.lease_write_policies ?? 1) === 0),
        evidence: status ? `anon schreibbar: ${status.lease_table_anon_writable}, Schreib-Policies: ${status.lease_write_policies ?? '?'}` : 'unbekannt',
    })
    checks.push({ id: 'lease-protocol-v2', ok: facts.leaseProtocol === 'v2', evidence: `Lease-RPC dieses Prozesses: ${facts.leaseProtocol || 'unbekannt'}` })

    const active = facts.nodes.filter(node => node.status !== 'offline')
    const tooOld = active.filter(node => { try { return compareUpdateVersions(node.version, minVersion) < 0 } catch { return true } })
    checks.push({
        id: 'node-versions', ok: active.length > 0 && tooOld.length === 0,
        evidence: !active.length ? 'keine aktiven Knoten bekannt' : tooOld.length
            ? `unter ${minVersion} oder unbekannt: ${tooOld.map(n => `${n.nodeId}=${n.version}`).join(', ')}`
            : `${active.length} aktive Knoten ≥ ${minVersion}`,
    })

    const problems: string[] = []
    const services = Object.keys(facts.currentEpochs)
    if (!services.length) problems.push('keine Koordinator-Epochen gelesen')
    for (const service of services) if (!Number.isSafeInteger(facts.currentEpochs[service])) problems.push(`Epoche ${service} unbekannt`)
    for (const node of active) {
        const marks = facts.highWater[node.nodeId]
        if (!marks) { problems.push(`${node.nodeId}: Hochwasser unbekannt`); continue }
        for (const [service, mark] of Object.entries(marks)) {
            const current = facts.currentEpochs[service]
            if (Number.isSafeInteger(current) && mark > Number(current)) problems.push(`${node.nodeId}: ${service} Hochwasser ${mark} > Koordinator ${current}`)
        }
    }
    checks.push({ id: 'highwater-consistent', ok: problems.length === 0, evidence: problems.length ? problems.join('; ') : `Hochwasser ≤ Koordinator-Epoche (${services.map(s => `${s}@${facts.currentEpochs[s]}`).join(', ')})` })
    return { safe: checks.every(check => check.ok), checks }
}

type Fetch = typeof fetch
export interface PostgrestProbeOptions { url: string; key: string; appRole: string; fetcher?: Fetch; timeoutMs?: number }

/** Read-only probe against the coordinator with the app's own key. GET only. */
export function createPostgrestFencingProbe(options: PostgrestProbeOptions) {
    const base = options.url.replace(/\/+$/, '')
    const fetcher = options.fetcher || fetch
    const get = (path: string, accept = 'application/json') => fetcher(`${base}${path}`, {
        method: 'GET', redirect: 'error',
        headers: { accept, apikey: options.key, Authorization: `Bearer ${options.key}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    })
    const classify = (status: number): RpcAccess => status >= 200 && status < 300 ? 'granted' : status === 401 || status === 403 ? 'denied' : status === 404 ? 'absent' : 'unknown'
    return {
        async collect(input: { services: string[] }): Promise<Pick<FencingFacts, 'appRole' | 'rpcs' | 'coordinator' | 'currentEpochs'>> {
            const rpcs = Object.fromEntries(V5_RPCS.map(name => [name, 'unknown'])) as FencingFacts['rpcs']
            try {
                const response = await get('/', 'application/openapi+json')
                if (response.ok) {
                    const paths = ((await response.json()) as { paths?: Record<string, unknown> })?.paths || {}
                    for (const name of V5_RPCS) rpcs[name] = Object.hasOwn(paths, `/rpc/${name}`) ? 'granted' : 'denied'
                } else await response.body?.cancel()
            } catch { /* OpenAPI unavailable: stays unknown */ }
            let coordinator: CoordinatorFencingStatus | null = null
            try {
                const response = await get('/rpc/nova_fencing_status')
                rpcs.nova_fencing_status = classify(response.status)
                if (response.ok) coordinator = await response.json() as CoordinatorFencingStatus
                else await response.body?.cancel()
            } catch { rpcs.nova_fencing_status = 'unknown' }
            const currentEpochs: Record<string, number | null> = {}
            for (const service of input.services) {
                currentEpochs[service] = null
                try {
                    const query = new URLSearchParams({ p_service: service, p_epoch: '0', p_holder_node_id: 'fencing-readiness-probe' })
                    const response = await get(`/rpc/nova_check_fence?${query}`)
                    const access = classify(response.status)
                    if (rpcs.nova_check_fence !== 'denied' && rpcs.nova_check_fence !== 'absent') rpcs.nova_check_fence = access
                    if (response.ok) {
                        const value = await response.json() as { epoch?: unknown }
                        currentEpochs[service] = Number.isSafeInteger(Number(value?.epoch)) && value?.epoch !== null ? Number(value.epoch) : null
                    } else await response.body?.cancel()
                } catch { /* stays null */ }
            }
            return { appRole: options.appRole, rpcs, coordinator, currentEpochs }
        },
    }
}

/** Evaluate and emit one result thought. Never toggles NOVA_FENCING_MODE. */
export async function reportFencingEnforceReadiness(facts: FencingFacts, sink: ThoughtSink, now = Date.now()): Promise<FencingReadinessReport & { thought: Thought }> {
    const report = evaluateFencingEnforceReadiness(facts)
    const failing = report.checks.filter(check => !check.ok)
    const thought = makeThought({
        source: 'self-update', kind: 'fencing-readiness',
        importance: report.safe ? 'normal' : 'hoch',
        permission: report.safe ? 'fragen' : 'selbst',
        title: report.safe ? 'Fencing enforce: sicher' : 'Fencing enforce: nicht sicher',
        text: report.safe
            ? 'Fencing enforce wäre sicher: alle Prüfungen bestanden. Umschalten nur nach Freigabe und Rollout-Plan; nichts wurde geändert.'
            : `Fencing enforce ist nicht sicher: ${failing.map(check => `${check.id} — ${check.evidence}`).join(' | ')}. Modus bleibt unverändert.`,
        evidence: report.checks.map(check => `${check.ok ? 'ok' : 'FEHLT'} ${check.id}: ${check.evidence}`),
        ...(report.safe ? { proposal: { action: 'fencing.enforce.review', params: { checks: report.checks.map(c => c.id) } } } : {}),
        dedupeKey: `fencing-readiness:${report.safe ? 'safe' : failing.map(c => c.id).join(',')}`,
    }, now)
    await sink.emit(thought)
    return { ...report, thought }
}
