import { existsSync } from 'node:fs'

export interface FullSystemAuditOptions {
    userId: string
    channel: string
    sessionHistory?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
}

export interface FullSystemAuditResult {
    healthy: boolean
    health: any
    mission: any
    layers: {
        coreFacts: { available: boolean; count?: number }
        coldStorage: { available: boolean; userMdBytes?: number; memoryMdBytes?: number }
        sessionMemory: { available: boolean; hotMessages?: number; hasSummary?: boolean }
        graphRag: { available: boolean; nodes?: number; edges?: number }
        memoryGovernance: { available: boolean; canonical?: number; verified?: number; candidate?: number; lancedbEntries?: number }
        toolHealth: { available: boolean; broken?: number; degraded?: number }
        llm: { available: boolean; provider?: string; model?: string; internalModel?: string }
        channels: { available: boolean; active?: string[] }
    }
    toolExecutions: Array<{
        toolName: string
        params: Record<string, unknown>
        result: string
        success: boolean
        timestamp: number
    }>
}

function pushExecution(
    list: FullSystemAuditResult['toolExecutions'],
    toolName: string,
    params: Record<string, unknown>,
    result: unknown,
    success: boolean,
): void {
    list.push({
        toolName,
        params,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        success,
        timestamp: Date.now(),
    })
}

export function formatFullSystemAudit(audit: FullSystemAuditResult): string {
    const lines: string[] = ['Vollständiger System-Audit:']

    if (audit.health?.error) {
        lines.push(`- Health: Fehler (${audit.health.error})`)
    } else {
        lines.push(`- Health: ${audit.health?.healthy ? 'OK' : 'Warnungen vorhanden'}`)
        if (audit.health?.disk) lines.push(`  Disk: ${audit.health.disk.freeGB}GB frei / ${audit.health.disk.totalGB}GB`)
        if (audit.health?.memory) lines.push(`  RAM: ${audit.health.memory.usedPercent}% (${audit.health.memory.usedMB}MB)`)
        if (audit.health?.novaData) lines.push(`  .nova-data: ${audit.health.novaData.sizeMB}MB`)
    }

    if (audit.mission?.error) {
        lines.push(`- Mission: Fehler (${audit.mission.error})`)
    } else if (typeof audit.mission === 'string') {
        lines.push(`- Mission: ${audit.mission.replace(/\n+/g, ' ').trim()}`)
    } else if (audit.mission?.status) {
        lines.push(`- Mission: ${String(audit.mission.status).replace(/\n+/g, ' ').trim()}`)
    } else {
        lines.push('- Mission: Kein Status verfügbar')
    }

    const l = audit.layers
    lines.push(`- Core Facts: ${l.coreFacts.available ? `aktiv (${l.coreFacts.count || 0} Fakten)` : 'nicht verfügbar'}`)
    lines.push(`- Cold Storage: ${l.coldStorage.available ? `aktiv (USER.md ${l.coldStorage.userMdBytes || 0}B, MEMORY.md ${l.coldStorage.memoryMdBytes || 0}B)` : 'nicht verfügbar'}`)
    lines.push(`- Session-Memory: ${l.sessionMemory.available ? `aktiv (${l.sessionMemory.hotMessages || 0} Hot Messages${l.sessionMemory.hasSummary ? ', mit Summary' : ''})` : 'nicht verfügbar'}`)
    lines.push(`- GraphRAG: ${l.graphRag.available ? `aktiv (${l.graphRag.nodes || 0} Nodes, ${l.graphRag.edges || 0} Edges)` : 'nicht verfügbar'}`)
    lines.push(`- Memory-Governance: ${l.memoryGovernance.available ? `aktiv (${l.memoryGovernance.canonical || 0} kanonisch, ${l.memoryGovernance.verified || 0} verifiziert, ${l.memoryGovernance.candidate || 0} Kandidaten; LanceDB ${l.memoryGovernance.lancedbEntries ?? '?'} Einträge)` : 'nicht verfügbar'}`)
    lines.push(`- Tool-Health: ${l.toolHealth.available ? `${l.toolHealth.broken || 0} broken, ${l.toolHealth.degraded || 0} degraded` : 'nicht verfügbar'}`)
    lines.push(`- LLM: ${l.llm.available ? `${l.llm.provider || 'unbekannt'}/${l.llm.model || 'unbekannt'}${l.llm.internalModel ? ` | intern: ${l.llm.internalModel}` : ''}` : 'nicht verfügbar'}`)
    lines.push(`- Channels: ${l.channels.available ? `${l.channels.active?.join(', ') || 'keine aktiven Channels'}` : 'nicht verfügbar'}`)
    lines.push(`- Audit-Ergebnis: ${audit.healthy ? 'weitgehend gesund' : 'Auffälligkeiten vorhanden'}`)
    lines.push('Belastbar sind hier nur die Punkte aus den direkt ausgeführten Prüfungen.')

    return lines.join('\n')
}

export async function runFullSystemAudit(options: FullSystemAuditOptions): Promise<FullSystemAuditResult> {
    const { userId, channel, sessionHistory = [] } = options
    const { getToolRegistry } = await import('../tools/complete-registry.js')
    const registry = getToolRegistry()
    const toolExecutions: FullSystemAuditResult['toolExecutions'] = []

    let health: any = null
    let mission: any = null

    try {
        health = await registry.execute('health_status', { userId, channel })
        pushExecution(toolExecutions, 'health_status', { userId, channel }, health, !health?.error)
    } catch (err) {
        health = { error: String(err) }
        pushExecution(toolExecutions, 'health_status', { userId, channel }, String(err), false)
    }

    try {
        mission = await registry.execute('mission_status', { userId, channel })
        pushExecution(toolExecutions, 'mission_status', { userId, channel }, mission, !mission?.error)
    } catch (err) {
        mission = { error: String(err) }
        pushExecution(toolExecutions, 'mission_status', { userId, channel }, String(err), false)
    }

    const layers: FullSystemAuditResult['layers'] = {
        coreFacts: { available: false },
        coldStorage: { available: false },
        sessionMemory: { available: false },
        graphRag: { available: false },
        memoryGovernance: { available: false },
        toolHealth: { available: false },
        llm: { available: false },
        channels: { available: false },
    }

    try {
        const { getAutoObserver } = await import('../memory/auto-observer.js')
        const observer = getAutoObserver()
        const facts = observer.getUserFacts(userId)
        layers.coreFacts = { available: facts.length > 0, count: facts.length }
        pushExecution(toolExecutions, 'audit_core_facts', { userId, channel }, layers.coreFacts, true)
    } catch {
        pushExecution(toolExecutions, 'audit_core_facts', { userId, channel }, layers.coreFacts, false)
    }

    try {
        const { readUserMd, readMemoryMd } = await import('../layers/L6-cold-storage.js')
        const userMd = readUserMd()
        const memoryMd = readMemoryMd()
        layers.coldStorage = {
            available: true,
            userMdBytes: Buffer.byteLength(userMd || '', 'utf8'),
            memoryMdBytes: Buffer.byteLength(memoryMd || '', 'utf8'),
        }
        pushExecution(toolExecutions, 'audit_cold_storage', { userId, channel }, layers.coldStorage, true)
    } catch {
        pushExecution(toolExecutions, 'audit_cold_storage', { userId, channel }, layers.coldStorage, false)
    }

    try {
        const { processSessionForLLM } = await import('../layers/L6-session-summary.js')
        const { summaryMessage, hotMessages } = await processSessionForLLM(userId, channel, sessionHistory, 12000)
        layers.sessionMemory = {
            available: true,
            hotMessages: hotMessages.length,
            hasSummary: !!summaryMessage,
        }
        pushExecution(toolExecutions, 'audit_session_memory', { userId, channel }, layers.sessionMemory, true)
    } catch {
        pushExecution(toolExecutions, 'audit_session_memory', { userId, channel }, layers.sessionMemory, false)
    }

    try {
        const kg = await import('../memory/knowledge-graph.js')
        const stats = kg.getStats()
        layers.graphRag = { available: true, nodes: stats.nodes, edges: stats.edges }
        pushExecution(toolExecutions, 'audit_graphrag', { userId, channel }, layers.graphRag, true)
    } catch {
        pushExecution(toolExecutions, 'audit_graphrag', { userId, channel }, layers.graphRag, false)
    }

    try {
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        const stats = getMemoryGovernanceCoordinator().getStats()
        let lancedbEntries: number | undefined
        try {
            const lance = await import('../memory/lancedb-memory.js')
            lancedbEntries = (await lance.getStats()).totalEntries
        } catch { /* LanceDB is an optional projection */ }
        layers.memoryGovernance = { available: true, canonical: stats.canonical, verified: stats.verified, candidate: stats.candidate, lancedbEntries }
        pushExecution(toolExecutions, 'audit_memory_governance', { userId, channel }, layers.memoryGovernance, true)
    } catch {
        pushExecution(toolExecutions, 'audit_memory_governance', { userId, channel }, layers.memoryGovernance, false)
    }


    try {
        const { getToolHealthStatus } = await import('../layers/L15-self-check.js')
        const healthEntries = getToolHealthStatus()
        layers.toolHealth = {
            available: true,
            broken: healthEntries.filter((e: any) => e.status === 'broken').length,
            degraded: healthEntries.filter((e: any) => e.status === 'degraded').length,
        }
        pushExecution(toolExecutions, 'audit_tool_health', { userId, channel }, layers.toolHealth, true)
    } catch {
        pushExecution(toolExecutions, 'audit_tool_health', { userId, channel }, layers.toolHealth, false)
    }

    try {
        const state = (globalThis as any).__novaState
        layers.llm = {
            available: !!state?.llm,
            provider: state?.activeProvider || state?.llm?.provider,
            model: state?.llm?.modelId || state?.activeModel || state?.llm?.model,
            internalModel: state?.internalLlm?.model || state?.internalLlm?.provider,
        }
        pushExecution(toolExecutions, 'audit_llm', { userId, channel }, layers.llm, true)
    } catch {
        pushExecution(toolExecutions, 'audit_llm', { userId, channel }, layers.llm, false)
    }

    try {
        const state = (globalThis as any).__novaState
        const active: string[] = []
        if (state?.channels?.telegram) active.push('telegram')
        if (state?.channels?.discord) active.push('discord')
        if (state?.channels?.whatsapp) active.push('whatsapp')
        layers.channels = { available: true, active }
        pushExecution(toolExecutions, 'audit_channels', { userId, channel }, layers.channels, true)
    } catch {
        pushExecution(toolExecutions, 'audit_channels', { userId, channel }, layers.channels, false)
    }

    const healthy = !health?.error
        && !mission?.error
        && Object.values(layers).every((entry) => entry.available || entry === layers.toolHealth)
        && (layers.toolHealth.broken || 0) === 0
        && existsSync('.nova-data')

    return {
        healthy,
        health,
        mission,
        layers,
        toolExecutions,
    }
}
