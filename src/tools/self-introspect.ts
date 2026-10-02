import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'

export type IntrospectType = 'state' | 'goals' | 'skills' | 'performance' | 'memories' | 'prompt' | 'tools' | 'full'

export interface IntrospectOptions {
    /** Runner-injected requester; procedures are shown for this principal only. */
    userId?: string
}

/** Data root (NOVA_RUNTIME_ROOT or cwd), resolved per call. */
function dataDir(...parts: string[]): string {
    return getNovaDataDir(...parts)
}

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

    const instanceId = safeReadText(dataDir('instance-id.txt'))
    if (instanceId) lines.push(`- Instance ID: ${instanceId}`)

    const manifest = safeRead(dataDir('node-manifest.json')) as Record<string, unknown> | null
    if (manifest) {
        lines.push(`- Node: ${manifest.nodeId ?? '?'} (${manifest.role ?? '?'})`)
        lines.push(`- Started: ${manifest.startedAt ?? '?'}`)
        lines.push(`- Channels: ${Array.isArray(manifest.channels) ? manifest.channels.join(', ') : '?'}`)
    }

    const heartbeat = safeRead(dataDir('heartbeat-log.json')) as Array<Record<string, unknown>> | null
    if (Array.isArray(heartbeat) && heartbeat.length > 0) {
        const last = heartbeat[heartbeat.length - 1]
        lines.push(`- Last heartbeat: ${last.ts ?? '?'} (${last.status ?? '?'})`)
    }

    return lines.join('\n')
}

async function inspectGoals(): Promise<string> {
    const lines: string[] = ['## Nova Goals']

    // P9: one goal store (goals.json); self-goals carry origin 'selbst'.
    const stored = safeRead(dataDir('goals.json')) as { goals?: Array<Record<string, unknown>> } | null
    const goals: Array<Record<string, unknown>> | null = Array.isArray(stored?.goals) ? stored!.goals.map(goal => ({ ...goal, goal: goal.title, description: goal.title })) : null
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

/**
 * 2.86 Punkt 9: "Was hast du gelernt?" from the real, current stores —
 * procedures, routine skills, self-built tools, the learning pulse and
 * decisions. The retired skills.json / patterns.json / tool-examples.json
 * are no longer read (learning/engine.ts RETIRED_FILES).
 */
async function inspectSkills(opts: IntrospectOptions = {}): Promise<string> {
    const lines: string[] = ['## Was ich gelernt habe (aktuelle Speicher)']
    const missing: string[] = []

    try {
        const { getProcedureStore, procedureStatus } = await import('../learning/procedure-store.js')
        const store = getProcedureStore()
        const stats = store.getStats()
        const entries = store.list(opts.userId)
        lines.push(`\n### Prozeduren (${stats.procedures} nutzbar${stats.suspended ? `, ${stats.suspended} ausgesetzt/aus` : ''}${stats.retracted ? `, ${stats.retracted} zurückgenommen` : ''})`)
        if (entries.length === 0) lines.push('- noch keine (entstehen aus zweimal verifizierten Werkzeug-Ergebnissen)')
        for (const [index, entry] of entries.slice(0, 10).entries()) {
            const uses = entry.uses || 0
            const ok = Math.max(0, uses - (entry.failures || 0))
            lines.push(`${index + 1}. ${entry.problem.slice(0, 80)} · ${entry.toolName || '–'} · ${uses}× (${ok} ok) · ${procedureStatus(entry)}`)
        }
        if (entries.length > 10) lines.push(`  … und ${entries.length - 10} weitere`)
    } catch { missing.push('Prozeduren') }

    try {
        const { getRoutineSkillStore } = await import('../learning/routine-skills.js')
        const skills = (getRoutineSkillStore()?.list() || []).filter(skill => skill.origin !== 'eingebaut')
        if (skills.length > 0) {
            lines.push(`\n### Routine-Skills (${skills.length})`)
            for (const skill of skills.slice(0, 8)) {
                lines.push(`- ${skill.name}: ${String(skill.trigger || '').slice(0, 80)} · ${skill.uses}× (${skill.successes} ok) · ${skill.enabled ? 'an' : 'aus'}`)
            }
        }
    } catch { missing.push('Routine-Skills') }

    try {
        const { getSkillProposals } = await import('./skill-builder.js')
        const tools = getSkillProposals(200).filter(tool => tool.origin !== 'altbestand')
        if (tools.length > 0) {
            lines.push(`\n### Selbst gebaute Werkzeuge (${tools.length})`)
            for (const tool of tools.slice(-8).reverse()) lines.push(`- ${tool.name}: ${String(tool.description || '').slice(0, 80)} · ${tool.status}`)
        }
    } catch { missing.push('Werkzeug-Schmiede') }

    try {
        const { learningFlow, learningFlowLines } = await import('../learning/learning-flow.js')
        const pulse = learningFlowLines(await learningFlow())
        if (pulse.length > 0) {
            lines.push('\n### Lern-Puls')
            for (const line of pulse) lines.push(`- ${line}`)
        }
    } catch { missing.push('Lern-Puls') }

    const decisions = safeRead(dataDir('decisions', 'decisions.json')) as { items?: Array<Record<string, unknown>> } | null
    const active = (decisions?.items || []).filter(item => item.status === 'aktiv' && item.bindend === true)
    if (active.length > 0) {
        lines.push(`\n### Entscheidungen (${active.length} gültig)`)
        for (const item of active.slice(-5)) {
            lines.push(`- [${item.id ?? '?'}] ${String(item.text ?? '').slice(0, 120)}`)
        }
    }

    if (missing.length > 0) lines.push(`\n(nicht lesbar: ${missing.join(', ')})`)
    return lines.join('\n')
}

async function inspectPerformance(): Promise<string> {
    const lines: string[] = ['## Nova Performance']

    const stats = safeRead(dataDir('usage-stats.json')) as Record<string, unknown> | null
    if (stats) {
        lines.push(`- Total LLM calls: ${stats.totalCalls ?? '?'}`)
        lines.push(`- Total tokens: ${stats.totalTokens ?? '?'}`)
        lines.push(`- Avg latency: ${stats.avgLatencyMs ? stats.avgLatencyMs + 'ms' : '?'}`)
        lines.push(`- Error rate: ${stats.errorRate !== undefined ? (Number(stats.errorRate) * 100).toFixed(1) + '%' : '?'}`)
        lines.push(`- Cache hit rate: ${stats.cacheHitRate !== undefined ? (Number(stats.cacheHitRate) * 100).toFixed(1) + '%' : '?'}`)
    }

    const toolHealth = safeRead(dataDir('tool-health.json')) as Record<string, unknown> | null
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

    const dataSizeBytes = dirSize(dataDir())
    lines.push(`\n- .nova-data size: ${(dataSizeBytes / 1024 / 1024).toFixed(2)} MB`)

    const lanceStatus = safeRead(dataDir('lancedb-status.json')) as Record<string, unknown> | null
    if (lanceStatus) {
        lines.push(`- Vector DB entries: ${lanceStatus.entryCount ?? '?'}`)
        lines.push(`- Vector DB size: ${lanceStatus.sizeMB ? lanceStatus.sizeMB + ' MB' : '?'}`)
    }

    return lines.join('\n')
}

async function inspectMemories(): Promise<string> {
    const lines: string[] = ['## Nova Memories']

    const observerDir = dataDir('observer')
    if (existsSync(observerDir)) {
        const files = readdirSync(observerDir).filter(f => f.endsWith('.json'))
        lines.push(`\n### Observer Notes (${files.length} files)`)
        for (const f of files.slice(0, 4)) {
            const data = safeRead(join(observerDir, f)) as Record<string, unknown> | null
            if (data) lines.push(`- ${f}: ${JSON.stringify(data).slice(0, 100)}`)
        }
    }

    const insights = safeRead(dataDir('insights.json')) as Array<Record<string, unknown>> | null
    if (Array.isArray(insights) && insights.length > 0) {
        lines.push(`\n### Insights (${insights.length})`)
        for (const i of insights.slice(0, 5)) {
            lines.push(`- [${i.type ?? '?'}] ${String(i.insight ?? i.content ?? '').slice(0, 100)}`)
        }
    }

    const consolidation = safeRead(dataDir('memory-consolidation.json')) as Record<string, unknown> | null
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

    const snapshot = safeReadText(dataDir('last-system-prompt.txt'))
    if (snapshot) {
        lines.push('(Last cached system prompt)')
        lines.push('')
        lines.push(snapshot.slice(0, 2000))
        if (snapshot.length > 2000) lines.push(`\n... [truncated, total ${snapshot.length} chars]`)
    } else {
        lines.push('No cached system prompt found.')
        lines.push('The system prompt is built dynamically from:')
        lines.push('- Nova core identity block')
        lines.push('- Entscheidungen (kausales Gedächtnis) und Prozeduren')
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

export async function selfIntrospect(type: IntrospectType = 'full', extra?: string, opts: IntrospectOptions = {}): Promise<string> {
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
                parts.push(await inspectSkills(opts))
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
                parts.push(await inspectSkills(opts))
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
