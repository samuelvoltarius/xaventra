import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getActiveMission } from '../core/autonomous-executor.js'
import { isHaStateAvailable } from '../core/ha-state.js'
import { discoverNodes, getMeshMainAuthority, type MeshMainAuthority, type MeshNode } from './mesh-registry.js'
import { getPreferredTakeoverNode } from './leader-election.js'

export interface ReadinessGate { id: string; ok: boolean; evidence: string }
export interface FailoverReadiness {
    mode: 'standalone' | 'direct' | 'ha'
    ready: boolean
    checkedAt: string
    estimatedRtoMs: number
    gates: ReadinessGate[]
    main?: string
    standby?: string
}

export function evaluateFailoverReadiness(input: {
    mode: 'standalone' | 'direct' | 'ha'
    nodes: MeshNode[]
    authority: MeshMainAuthority | null
    standby?: { nodeId: string } | null
    haStateAvailable: boolean
    mission?: { status: string; checkpointAt?: number; ownerNode?: string } | null
    now?: number
}): FailoverReadiness {
    const now = input.now ?? Date.now()
    const active = input.nodes.filter(node => node.status === 'online' || node.status === 'busy')
    const authorityFresh = Boolean(input.authority && Date.parse(input.authority.expiresAt) > now && input.authority.epoch > 0)
    const mainActive = Boolean(input.authority && active.some(node => node.node_id === input.authority!.nodeId))
    const telegramFenced = Boolean(input.authority?.services.includes('nova-main') && input.authority.services.includes('telegram'))
    const missionCheckpointReady = !input.mission || input.mission.status !== 'active'
        || Boolean(input.mission.checkpointAt && now - input.mission.checkpointAt <= 120_000 && input.mission.ownerNode)
    const gates: ReadinessGate[] = [
        { id: 'active-nodes', ok: active.length >= 2, evidence: `${active.length} active node(s)` },
        { id: 'lease-authority', ok: input.mode !== 'ha' || authorityFresh, evidence: input.authority ? `epoch ${input.authority.epoch}, expires ${input.authority.expiresAt}` : 'no live authority' },
        { id: 'main-visible', ok: input.mode !== 'ha' || mainActive, evidence: input.authority?.nodeId || 'unknown main' },
        { id: 'telegram-exactly-once', ok: input.mode !== 'ha' || telegramFenced, evidence: input.authority?.services.join(', ') || 'no fenced services' },
        { id: 'standby', ok: Boolean(input.standby && input.standby.nodeId !== input.authority?.nodeId), evidence: input.standby?.nodeId || 'no eligible standby' },
        { id: 'shared-state', ok: input.mode !== 'ha' || input.haStateAvailable, evidence: input.haStateAvailable ? 'encrypted HA state reachable' : 'HA state unavailable' },
        { id: 'mission-checkpoint', ok: missionCheckpointReady, evidence: input.mission?.checkpointAt ? `checkpoint ${new Date(input.mission.checkpointAt).toISOString()}` : 'no active mission' },
    ]
    // 75s node expiry + 15s recovery watcher + 15s service startup margin.
    const estimatedRtoMs = 105_000
    return {
        mode: input.mode,
        ready: input.mode === 'standalone' ? true : gates.every(gate => gate.ok),
        checkedAt: new Date(now).toISOString(),
        estimatedRtoMs,
        gates,
        main: input.authority?.nodeId,
        standby: input.standby?.nodeId,
    }
}

function configuredMode(): 'standalone' | 'direct' | 'ha' {
    try {
        const path = join(process.cwd(), 'nova.config.json')
        if (!existsSync(path)) return 'standalone'
        const config = JSON.parse(readFileSync(path, 'utf8'))
        return ['standalone', 'direct', 'ha'].includes(config.mesh?.mode) ? config.mesh.mode : 'standalone'
    } catch { return 'standalone' }
}

export async function inspectFailoverReadiness(): Promise<FailoverReadiness> {
    const [nodes, authority, standby, haStateAvailable] = await Promise.all([
        discoverNodes({ activeOnly: true }),
        getMeshMainAuthority(),
        getPreferredTakeoverNode(),
        isHaStateAvailable(),
    ])
    return evaluateFailoverReadiness({
        mode: configuredMode(), nodes, authority, standby, haStateAvailable,
        mission: getActiveMission(),
    })
}

export function formatFailoverReadiness(report: FailoverReadiness): string {
    return [
        `${report.ready ? '✅' : '⚠️'} Failover ${report.ready ? 'bereit' : 'nicht vollständig bereit'} (${report.mode})`,
        `Main: ${report.main || 'nicht verifiziert'} | Standby: ${report.standby || 'keiner'} | RTO-Ziel: ${Math.round(report.estimatedRtoMs / 1000)}s`,
        ...report.gates.map(gate => `${gate.ok ? '✅' : '❌'} ${gate.id}: ${gate.evidence}`),
    ].join('\n')
}
