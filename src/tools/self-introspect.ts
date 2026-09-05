import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type IntrospectType = 'state' | 'goals' | 'skills' | 'performance' | 'memories' | 'prompt' | 'tools' | 'full'

const DATA_DIR = join(process.cwd(), '.nova-data')

function safeRead(path: string): unknown {
    try {
        if (!existsSync(path)) return null
        const raw = readFileSync(path, 'utf-8').trim()
        if (!raw) return null
        return JSON.parse(raw)
    } catch {
        return null
    }
}

function safeReadText(path: string): string | null {
    try {
        if (!existsSync(path)) return null
        return readFileSync(path, 'utf-8').trim() || null
    } catch {
        return null
    }
}

function dirSize(dir: string): number {
    try {
        let total = 0
        for (const f of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, f.name)
            if (f.isDirectory()) total += dirSize(p)
            else total += statSync(p).size
        }
        return total
    } catch {
        return 0
    }
}

async function inspectState(): Promise<string> {
    const lines: string[] = ['## Nova Live State']

    const gs = (globalThis as Record<string, unknown>).__novaState as Record<string, unknown> | undefined
    if (gs) {
        lines.push(`- Version: ${gs.version ?? '?'}`)
        lines.push(`- Uptime: ${gs.uptime ? Math.round(Number(gs.uptime) / 1000) + 's' : '?'}`)
        lines.push(`- Active sessions: ${gs.activeSessions ?? '?'}`)
        lines.push(`- Total messages processed: ${gs.totalMessages ?? '?'}`)
    }

    const instanceId = safeReadText(join(DATA_DIR, 'instance-id.txt'))
    if (instanceId) lines.push(`- Instance ID: ${instanceId}`)

    const manifest = safeRead(join(DATA_DIR, 'node-manifest.json')) as Record<string, unknown> | null
    if (manifest) {
        lines.push(`- Node: ${manifest.nodeId ?? '?'} (${manifest.role ?? '?'})`)
        lines.push(`- Started: ${manifest.startedAt ?? '?'}`)
        lines.push(`- Channels: ${Array.isArray(manifest.channels) ? manifest.channels.join(', ') : '?'}`)
    }

    const heartbeat = safeRead(join(DATA_DIR, 'heartbeat-log.json')) as Array<Record<string, unknown>> | null
    if (Array.isArray(heartbeat) && heartbeat.length > 0) {
        const last = heartbeat[heartbeat.length - 1]
        lines.push(`- Last heartbeat: ${last.ts ?? '?'} (${last.status ?? '?'})`)
    }

    return lines.join('\n')
}

async function inspectGoals(): Promise<string> {
    const lines: string[] = ['## Nova Goals']

    const goals = safeRead(join(DATA_DIR, 'self-goals.json')) as Array<Record<string, unknown>> | null
    if (!Array.isArray(goals) || goals.length === 0) {
        lines.push('No goals found.')
        return lines.join('\n')
    }

    const byStatus: Record<string, Array<Record<string, unknown>>> = {}
    for (const g of goals) {
        const s = String(g.status ?? 'unknown')
        ;(byStatus[s] ??= []).push(g)
    }

    for (const [status, items] of Object.entries(byStatus)) {
        lines.push(`\n### ${status} (${items.length})`)
        for (const g of items.slice(0, 5)) {
            lines.push(`- [${g.priority ?? '?'}] ${g.description ?? g.goal ?? JSON.stringify(g)}`)
        }
        if (items.length > 5) lines.push(`  ... and ${items.length - 5} more`)
    }

    return lines.join('\n')
}

async function inspectSkills(): Promise<string> {
    const lines: string[] = ['## Nova Skills & Learned Rules']

    const skills = safeRead(join(DATA_DIR, 'skills', 'skills.json')) as Array<Record<string, unknown>> | null
    if (Array.isArray(skills) && skills.length > 0) {
        lines.push(`\n### Skills (${skills.length})`)
        for (const s of skills.slice(0, 8)) {
            lines.push(`- ${s.name ?? s.id ?? '?'}: ${String(s.description ?? '').slice(0, 80)}`)
        }
        if (skills.length > 8) lines.push(`  ... and ${skills.length - 8} more`)
    }

    const patterns = safeRead(join(DATA_DIR, 'patterns.json')) as Array<Record<string, unknown>> | null
    if (Array.isArray(patterns) && patterns.length > 0) {
        lines.push(`\n### Learned Patterns (${patterns.length})`)
        for (const p of patterns.slice(0, 5)) {
            lines.push(`- [conf:${p.confidence ?? '?'}] ${p.pattern ?? p.description ?? JSON.stringify(p).slice(0, 80)}`)
        }
    }

    const rules = safeRead(join(DATA_DIR, 'self-rules.json')) as Array<Record<string, unknown>> | null
    if (Array.isArray(rules) && rules.length > 0) {
        lines.push(`\n### Self-Rules (${rules.length})`)
        for (const r of rules.slice(0, 5)) {
            lines.push(`- [applied:${r.appliedCount ?? 0}, conf:${r.confidence ?? '?'}] ${r.rule ?? r.description ?? JSON.stringify(r).slice(0, 80)}`)
        }
    }

    const toolEx = safeRead(join(DATA_DIR, 'tool-examples.json')) as Record<string, unknown> | null
    if (toolEx && typeof toolEx === 'object') {
        const toolNames = Object.keys(toolEx)
        lines.push(`\n### Tool Usage Examples (${toolNames.length} tools tracked)`)
        for (const t of toolNames.slice(0, 6)) {
            const examples = toolEx[t] as unknown[]
            lines.push(`- ${t}: ${Array.isArray(examples) ? examples.length : '?'} examples`)
        }
    }

    return lines.join('\n')
}

async function inspectPerformance(): Promise<string> {
    const lines: string[] = ['## Nova Performance']

    const stats = safeRead(join(DATA_DIR, 'usage-stats.json')) as Record<string, unknown> | null
    if (stats) {
        lines.push(`- Total LLM calls: ${stats.totalCalls ?? '?'}`)
        lines.push(`- Total tokens: ${stats.totalTokens ?? '?'}`)
        lines.push(`- Avg latency: ${stats.avgLatencyMs ? stats.avgLatencyMs + 'ms' : '?'}`)
        lines.push(`- Error rate: ${stats.errorRate !== undefined ? (Number(stats.errorRate) * 100).toFixed(1) + '%' : '?'}`)
        lines.push(`- Cache hit rate: ${stats.cacheHitRate !== undefined ? (Number(stats.cacheHitRate) * 100).toFixed(1) + '%' : '?'}`)
    }

    const toolHealth = safeRead(join(DATA_DIR, 'tool-health.json')) as Record<string, unknown> | null
    if (toolHealth && typeof toolHealth === 'object') {
        const tools = Object.entries(toolHealth as Record<string, Record<string, unknown>>)
        lines.push(`\n### Tool Health (${tools.length} tools)`)
        const degraded = tools.filter(([, v]) => Number(v.errorRate ?? 0) > 0.1)
        if (degraded.length > 0) {
            lines.push('Degraded tools:')
            for (const [name, v] of degraded) {
                lines.push(`  - ${name}: ${(Number(v.errorRate) * 100).toFixed(0)}% error rate`)
            }
        } else {
            lines.push('All tools healthy.')
        }
    }

    const dataSizeBytes = dirSize(DATA_DIR)
    lines.push(`\n- .nova-data size: ${(dataSizeBytes / 1024 / 1024).toFixed(2)} MB`)

    const lanceStatus = safeRead(join(DATA_DIR, 'lancedb-status.json')) as Record<string, unknown> | null
    if (lanceStatus) {
        lines.push(`- Vector DB entries: ${lanceStatus.entryCount ?? '?'}`)
        lines.push(`- Vector DB size: ${lanceStatus.sizeMB ? lanceStatus.sizeMB + ' MB' : '?'}`)
    }

    return lines.join('\n')
}

async function inspectMemories(): Promise<string> {
    const lines: string[] = ['## Nova Memories']

    const observerDir = join(DATA_DIR, 'observer')
    if (existsSync(observerDir)) {
        const files = readdirSync(observerDir).filter(f => f.endsWith('.json'))
        lines.push(`\n### Observer Notes (${files.length} files)`)
        for (const f of files.slice(0, 4)) {
            const data = safeRead(join(observerDir, f)) as Record<string, unknown> | null
            if (data) lines.push(`- ${f}: ${JSON.stringify(data).slice(0, 100)}`)
        }
    }

    const insights = safeRead(join(DATA_DIR, 'insights.json')) as Array<Record<string, unknown>> | null
    if (Array.isArray(insights) && insights.length > 0) {
        lines.push(`\n### Insights (${insights.length})`)
        for (const i of insights.slice(0, 5)) {
            lines.push(`- [${i.type ?? '?'}] ${String(i.insight ?? i.content ?? '').slice(0, 100)}`)
        }
    }

    const consolidation = safeRead(join(DATA_DIR, 'memory-consolidation.json')) as Record<string, unknown> | null
    if (consolidation) {
        lines.push(`\n### Memory Consolidation`)
        lines.push(`- Last run: ${consolidation.lastRun ?? '?'}`)
        lines.push(`- Episodes consolidated: ${consolidation.episodesConsolidated ?? '?'}`)
        lines.push(`- Semantic clusters: ${consolidation.clusters ?? '?'}`)
    }

    return lines.join('\n')
}

async function inspectPrompt(): Promise<string> {
    const lines: string[] = ['## Nova System Prompt Snapshot']

    const snapshot = safeReadText(join(DATA_DIR, 'last-system-prompt.txt'))
    if (snapshot) {
        lines.push('(Last cached system prompt)')
        lines.push('')
        lines.push(snapshot.slice(0, 2000))
        if (snapshot.length > 2000) lines.push(`\n... [truncated, total ${snapshot.length} chars]`)
    } else {
        lines.push('No cached system prompt found.')
        lines.push('The system prompt is built dynamically from:')
        lines.push('- Nova core identity block')
        lines.push('- L20 self-improvement rules (buildPromptBlock)')
        lines.push('- Admin-Berechtigungen block (for known hosts from hosts.json)')
        lines.push('- Tool descriptions (injected by nova-runner)')
        lines.push('- L7 few-shot tool examples (injected on self-healing retries)')
    }

    return lines.join('\n')
}

async function inspectTools(searchTopic?: string): Promise<string> {
    const lines: string[] = ['## Nova Tool Inventory']

    try {
        const { getToolRegistry } = await import('./complete-registry.js')
        const registry = getToolRegistry()
        const allTools = registry.getAll()

        // Group by category
        const byCategory: Record<string, typeof allTools> = {}
        for (const tool of allTools) {
            const cat = tool.category ?? 'other'
            ;(byCategory[cat] ??= []).push(tool)
        }

        // If searching for a topic, filter
        if (searchTopic) {
            const q = searchTopic.toLowerCase()
            const matches = allTools.filter(t =>
                t.name.toLowerCase().includes(q) ||
                t.description.toLowerCase().includes(q) ||
                (t.category ?? '').toLowerCase().includes(q)
            )
            lines.push(`\n### Matches for "${searchTopic}" (${matches.length})`)
            for (const t of matches) {
                lines.push(`- **${t.name}** [${t.category}]: ${t.description}`)
            }
            return lines.join('\n')
        }

        lines.push(`\nTotal tools: ${allTools.length}`)
        lines.push('')

        for (const [cat, tools] of Object.entries(byCategory).sort()) {
            lines.push(`### ${cat} (${tools.length})`)
            for (const t of tools) {
                lines.push(`- **${t.name}**: ${t.description.slice(0, 100)}`)
            }
            lines.push('')
        }
    } catch (err) {
        lines.push(`[Tool inventory error: ${err instanceof Error ? err.message : String(err)}]`)
    }

    return lines.join('\n')
}

export async function selfIntrospect(type: IntrospectType = 'full', extra?: string): Promise<string> {
    const parts: string[] = [`# Nova Self-Introspection — ${type}\n`]

    try {
        switch (type) {
            case 'state':
                parts.push(await inspectState())
                break
            case 'goals':
                parts.push(await inspectGoals())
                break
            case 'skills':
                parts.push(await inspectSkills())
                break
            case 'performance':
                parts.push(await inspectPerformance())
                break
            case 'memories':
                parts.push(await inspectMemories())
                break
            case 'prompt':
                parts.push(await inspectPrompt())
                break
            case 'tools':
                parts.push(await inspectTools(extra))
                break
            case 'full':
                parts.push(await inspectState())
                parts.push('')
                parts.push(await inspectGoals())
                parts.push('')
                parts.push(await inspectSkills())
                parts.push('')
                parts.push(await inspectPerformance())
                parts.push('')
                parts.push(await inspectMemories())
                break
        }
    } catch (err) {
        parts.push(`\n[Introspection error: ${err instanceof Error ? err.message : String(err)}]`)
    }

    return parts.join('\n')
}
