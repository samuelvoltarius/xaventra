import { getOutcomeLedger } from './outcome-ledger.js'
import { getActiveMission, getMissionQueue } from './autonomous-executor.js'
import { getSessionContinuityStore } from '../memory/session-summarizer.js'
import { getMemoryGovernanceCoordinator } from '../memory/memory-governance.js'
import { getCapabilityGraph } from '../mesh/capability-graph.js'
import { discoverNodes, getLocalNodeId, getMeshMainAuthority } from '../mesh/mesh-registry.js'

export interface WorldEvidence<T> {
    value: T
    source: string
    verifiedAt: string
    expiresAt?: string
    confidence: number
}

export interface NovaWorldModel {
    version: 2
    generatedAt: string
    localNode: string
    main: WorldEvidence<{ nodeId: string; hostname?: string; epoch: number; services: string[] } | null>
    nodes: WorldEvidence<Array<{
        id: string; hostname: string; status: string; version: string; tools: number
        ramMb?: number; freeRamMb?: number; gpu?: string; vramMb?: number; runtimes: string[]
    }>>
    capabilities: WorldEvidence<{ nodes: number; runtimes: number; models: number; tombstones: number }>
    mission: WorldEvidence<{ id: string; goal: string; status: string; completed: number; total: number; ownerNode?: string; checkpointAt?: number } | null>
    memory: WorldEvidence<{ total: number; verified: number; canonical: number; conflicts: number; sessions: number; openGoals: number }>
    outcomes: WorldEvidence<{ total: number; running: number; completed: number; failed: number; validated: number; successRate: number }>
    personal: WorldEvidence<{
        principalId?: string
        projectContext: string
        openGoals: string[]
        decisions: string[]
        preferences: string[]
        uncertainties: string[]
        verifiedOutcomes: string[]
        workflowEpisodes: number
        proposedSkills: number
        activeSkills: number
        managedGoals: { total: number; active: number; blocked: number; completed: number }
        beliefs: number
        disputedBeliefs: number
        causalEvents: number
    }>
}

function ageConfidence(timestamp: string | number | undefined, ttlMs: number): number {
    const time = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp || '')
    if (!Number.isFinite(time)) return 0
    return Math.max(0, Math.min(1, 1 - (Date.now() - time) / ttlMs))
}

export async function buildNovaWorldModel(principalId?: string): Promise<NovaWorldModel> {
    const generatedAt = new Date().toISOString()
    const [meshNodes, authority] = await Promise.all([
        discoverNodes({ activeOnly: true }),
        getMeshMainAuthority(),
    ])
    const graph = getCapabilityGraph().getSnapshot()
    const activeMission = getActiveMission()
    const governance = getMemoryGovernanceCoordinator()
    const governed = governance.list()
    const continuityStore = getSessionContinuityStore()
    const continuity = continuityStore.getStats()
    const personalSummary = principalId && typeof (continuityStore as any).getSummary === 'function'
        ? continuityStore.getSummary(principalId) : undefined
    let workflowEpisodes = 0
    let proposedSkills = 0
    let activeSkills = 0
    try {
        const [{ getWorkflowEpisodeStore }, { getPersonalSkillCompiler }] = await Promise.all([
            import('../memory/workflow-episode-store.js'),
            import('../learning/personal-skill-compiler.js'),
        ])
        workflowEpisodes = getWorkflowEpisodeStore().getStats(principalId).successful
        const skills = getPersonalSkillCompiler().list(principalId)
        proposedSkills = skills.filter(item => item.status === 'proposed').length
        activeSkills = skills.filter(item => item.status === 'active').length
    } catch { /* optional learning projections never block the world model */ }
    const [{ getGoalManager }, { getBeliefStore }, { getCausalMemory }] = await Promise.all([
        import('./goal-manager.js'), import('./belief-store.js'), import('./causal-memory.js'),
    ])
    const managedGoals = getGoalManager().getStats(principalId)
    const beliefs = principalId ? getBeliefStore().list(principalId) : []
    const causal = getCausalMemory().getStats(principalId)
    const runs = getOutcomeLedger().listRuns(500)
        .filter(run => run.channel !== 'benchmark' && !String(run.userId || '').startsWith('benchmark:'))
    const terminal = runs.filter(run => run.status === 'completed' || run.status === 'failed')
    const validated = terminal.filter(run => typeof run.validation?.success === 'boolean')
    const successful = validated.filter(run => run.status === 'completed' && run.validation?.success === true)

    const nodes = meshNodes.map(node => {
        const graphNode = graph.nodes.find(item => item.id === node.node_id || item.hostname === node.hostname)
        return {
            id: node.node_id,
            hostname: node.hostname,
            status: node.status,
            version: node.version,
            tools: node.tools_count,
            ramMb: node.hardware?.ram_gb != null ? Math.round(node.hardware.ram_gb * 1024) : undefined,
            freeRamMb: node.hardware?.ram_free_gb != null ? Math.round(node.hardware.ram_free_gb * 1024) : undefined,
            gpu: node.hardware?.gpu,
            vramMb: node.hardware?.gpu_vram_mb,
            runtimes: (graphNode?.runtimes || []).filter(runtime => runtime.status === 'running').map(runtime => `${runtime.name}:${runtime.models.join(',') || 'no-model'}`),
        }
    })
    const newestHeartbeat = Math.max(...meshNodes.map(node => Date.parse(node.last_heartbeat)).filter(Number.isFinite), 0)
    const memoryStats = governance.getStats()
    const activeRecords = governed.filter(record => record.status === 'verified' || record.status === 'canonical')
    const activeIds = new Set(activeRecords.map(record => record.id))
    const conflicts = activeRecords.filter(record => record.conflictIds.some(id => activeIds.has(id))).length

    return {
        version: 2,
        generatedAt,
        localNode: getLocalNodeId(),
        main: {
            value: authority ? { nodeId: authority.nodeId, hostname: authority.hostname, epoch: authority.epoch, services: authority.services } : null,
            source: 'mesh-lease-authority',
            verifiedAt: generatedAt,
            expiresAt: authority?.expiresAt,
            confidence: authority && Date.parse(authority.expiresAt) > Date.now() ? 1 : 0,
        },
        nodes: {
            value: nodes,
            source: 'mesh-registry+direct-mesh',
            verifiedAt: newestHeartbeat ? new Date(newestHeartbeat).toISOString() : generatedAt,
            expiresAt: newestHeartbeat ? new Date(newestHeartbeat + 75_000).toISOString() : undefined,
            confidence: ageConfidence(newestHeartbeat, 75_000),
        },
        capabilities: {
            value: {
                nodes: graph.nodes.length,
                runtimes: graph.nodes.reduce((sum, node) => sum + node.runtimes.length, 0),
                models: new Set(graph.nodes.flatMap(node => node.runtimes.flatMap(runtime => runtime.models))).size,
                tombstones: graph.tombstones?.length || 0,
            },
            source: 'capability-graph',
            verifiedAt: graph.updatedAt,
            confidence: ageConfidence(graph.updatedAt, 5 * 60_000),
        },
        mission: {
            value: activeMission ? {
                id: activeMission.id, goal: activeMission.goal, status: activeMission.status,
                completed: activeMission.steps.filter(step => step.status === 'done').length,
                total: activeMission.steps.length, ownerNode: activeMission.ownerNode,
                checkpointAt: activeMission.checkpointAt,
            } : null,
            source: 'mission-state-machine',
            verifiedAt: activeMission?.checkpointAt ? new Date(activeMission.checkpointAt).toISOString() : generatedAt,
            confidence: activeMission ? ageConfidence(activeMission.checkpointAt, 2 * 60_000) : 1,
        },
        memory: {
            value: {
                total: memoryStats.total, verified: memoryStats.verified, canonical: memoryStats.canonical,
                conflicts, sessions: continuity.sessions, openGoals: continuity.openGoals,
            },
            source: 'memory-governance+session-continuity',
            verifiedAt: generatedAt,
            confidence: 1,
        },
        outcomes: {
            value: {
                total: runs.length,
                running: runs.filter(run => run.status === 'running' || run.status === 'awaiting_approval').length,
                completed: terminal.filter(run => run.status === 'completed').length,
                failed: terminal.filter(run => run.status === 'failed').length,
                validated: validated.length,
                successRate: validated.length ? successful.length / validated.length : 0,
            },
            source: 'outcome-ledger',
            verifiedAt: runs[0]?.updatedAt || generatedAt,
            confidence: 1,
        },
        personal: {
            value: {
                principalId,
                projectContext: personalSummary?.projectContext || '',
                openGoals: personalSummary?.openGoals || [],
                decisions: personalSummary?.decisions || [],
                preferences: personalSummary?.preferences || [],
                uncertainties: personalSummary?.uncertainties || [],
                verifiedOutcomes: personalSummary?.verifiedOutcomes || [],
                workflowEpisodes,
                proposedSkills,
                activeSkills,
                managedGoals,
                beliefs: beliefs.length,
                disputedBeliefs: beliefs.filter(item => item.status === 'disputed' || item.status === 'uncertain').length,
                causalEvents: causal.events,
            },
            source: 'user-scoped-session-continuity+validated-workflow-memory',
            verifiedAt: personalSummary?.lastUpdated ? new Date(personalSummary.lastUpdated).toISOString() : generatedAt,
            confidence: 1,
        },
    }
}

function pct(value: number): string { return `${Math.round(value * 100)}%` }

export function formatNovaWorldModel(model: NovaWorldModel): string {
    const main = model.main.value
    const mission = model.mission.value
    const nodeLines = model.nodes.value.length
        ? model.nodes.value.map(node => `- ${node.id}${node.id === main?.nodeId ? ' (Main)' : ''}: ${node.status}, v${node.version}, ${node.tools} Tools${node.gpu ? `, GPU ${node.gpu}` : ''}${node.runtimes.length ? `, AI ${node.runtimes.join('; ')}` : ''}`)
        : ['- Keine aktiven Nodes mit frischer Evidence gefunden.']
    return [
        `🌍 Nova-Lagebild — ${model.generatedAt}`,
        '',
        `Main: ${main ? `${main.hostname || main.nodeId} (Epoch ${main.epoch}, Lease bis ${model.main.expiresAt})` : 'nicht verifiziert'} [${model.main.source}, ${pct(model.main.confidence)}]`,
        `Lokaler Node: ${model.localNode}`,
        '',
        ...nodeLines,
        '',
        `Capabilities: ${model.capabilities.value.nodes} Nodes, ${model.capabilities.value.runtimes} Runtimes, ${model.capabilities.value.models} Modelle, ${model.capabilities.value.tombstones} Tombstones [${pct(model.capabilities.confidence)} frisch]`,
        `Mission: ${mission ? `${mission.status} — ${mission.completed}/${mission.total} — ${mission.goal}` : `keine aktive (${getMissionQueue().length} in Warteschlange)`}`,
        `Memory: ${model.memory.value.canonical} kanonisch, ${model.memory.value.verified} verifiziert, ${model.memory.value.conflicts} aktive Konflikte, ${model.memory.value.openGoals} offene Ziele`,
        `Outcomes: ${model.outcomes.value.validated}/${model.outcomes.value.total} validiert, Erfolgsrate ${pct(model.outcomes.value.successRate)}, ${model.outcomes.value.running} offen`,
        ...(model.personal.value.principalId ? [
            `Persönlicher Kontext: ${model.personal.value.openGoals.length} offene Ziele, ${model.personal.value.decisions.length} Entscheidungen, ${model.personal.value.preferences.length} Präferenzen, ${model.personal.value.uncertainties.length} offene Klärungen`,
            `Erlernte Abläufe: ${model.personal.value.workflowEpisodes} validierte Episoden, ${model.personal.value.proposedSkills} Skill-Vorschläge, ${model.personal.value.activeSkills} aktive Skills`,
            `Goal Manager: ${model.personal.value.managedGoals.active} aktiv, ${model.personal.value.managedGoals.blocked} blockiert, ${model.personal.value.managedGoals.completed} abgeschlossen`,
            `Beliefs/Kausalität: ${model.personal.value.beliefs} Beliefs (${model.personal.value.disputedBeliefs} ungeklärt), ${model.personal.value.causalEvents} verifizierte Ereignisse`,
        ] : []),
        '',
        'Jede Zahl stammt aus einem kanonischen Store; unbekannte oder abgelaufene Zustände werden nicht erraten.',
    ].join('\n')
}
