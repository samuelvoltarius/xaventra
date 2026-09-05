/**
 * Team Coordinator — Grok-Style Multi-Agent Orchestration
 *
 * Nova sends a complex query → Captain decomposes → Specialists execute in parallel
 * → Captain aggregates + consensus → User gets one final answer.
 *
 * Flow:
 * 1. User: /bot team "How can we improve performance?"
 * 2. Captain decomposes: [research benchmarks, analyze code, check architecture]
 * 3. Parallel: Research agent + Coder agent + Analyst agent work simultaneously
 * 4. Captain: aggregates results, resolves conflicts, builds final answer
 * 5. User: gets structured response with contributions from all agents
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
    type AgentRole,
    type TeamConfig,
    BUILT_IN_ROLES,
    TEAM_PRESETS,
    getRole,
} from './agent-roles.js'

const DATA_DIR = join(process.cwd(), '.nova-data', 'teams')

// ============================================
// Types
// ============================================

interface AgentResult {
    roleId: string
    roleName: string
    emoji: string
    content: string
    durationMs: number
    model?: string
    node?: string
    error?: string
}

interface TeamRun {
    id: string
    teamId: string
    query: string
    status: 'decomposing' | 'executing' | 'aggregating' | 'completed' | 'failed'
    startedAt: number
    completedAt?: number
    subtasks: string[]
    results: AgentResult[]
    finalAnswer?: string
    onProgress?: (status: string) => Promise<void>
}

// ============================================
// State
// ============================================

let customTeams: TeamConfig[] = []
const activeRuns = new Map<string, TeamRun>()

// ============================================
// Team CRUD
// ============================================

export function createTeam(
    name: string,
    roles: string[],
    description: string,
    createdBy: string
): TeamConfig {
    const team: TeamConfig = {
        id: randomUUID().slice(0, 8),
        name,
        description,
        roles,
        createdAt: Date.now(),
        createdBy,
    }
    customTeams.push(team)
    saveTeams()
    return team
}

export function deleteTeam(teamId: string): boolean {
    const idx = customTeams.findIndex(t => t.id === teamId || t.name.toLowerCase() === teamId.toLowerCase())
    if (idx === -1) return false
    customTeams.splice(idx, 1)
    saveTeams()
    return true
}

export function getTeam(teamId: string): TeamConfig | undefined {
    // Check custom teams first
    const custom = customTeams.find(t => t.id === teamId || t.name.toLowerCase() === teamId.toLowerCase())
    if (custom) return custom
    // Check presets
    const preset = TEAM_PRESETS[teamId]
    if (preset) return { id: teamId, ...preset, createdAt: 0, createdBy: 'system' }
    return undefined
}

export function listTeams(): string {
    const presets = Object.entries(TEAM_PRESETS).map(([id, p]) => {
        const emojis = p.roles.map(r => BUILT_IN_ROLES[r]?.emoji || '?').join('')
        return `📦 **${p.name}** (${id}) — ${emojis}\n   ${p.description}`
    })

    const custom = customTeams.map(t => {
        const emojis = t.roles.map(r => BUILT_IN_ROLES[r]?.emoji || '?').join('')
        return `⭐ **${t.name}** (${t.id}) — ${emojis}\n   ${t.description}`
    })

    let result = '🤖 **Teams**\n\n'
    result += '**Presets:**\n' + presets.join('\n') + '\n'
    if (custom.length > 0) {
        result += '\n**Custom Teams:**\n' + custom.join('\n')
    }
    return result
}

// ============================================
// Core: Run a Team
// ============================================

export async function runTeam(
    teamIdOrRoles: string | string[],
    query: string,
    onProgress?: (status: string) => Promise<void>
): Promise<string> {
    // Resolve team roles
    let roles: AgentRole[]
    let teamName: string

    if (typeof teamIdOrRoles === 'string') {
        const team = getTeam(teamIdOrRoles)
        if (!team) {
            // Default team
            const defaultTeam = TEAM_PRESETS.default
            roles = defaultTeam.roles.map(r => getRole(r)).filter(Boolean) as AgentRole[]
            teamName = defaultTeam.name
        } else {
            roles = team.roles.map(r => getRole(r)).filter(Boolean) as AgentRole[]
            teamName = team.name
        }
    } else {
        roles = teamIdOrRoles.map(r => getRole(r)).filter(Boolean) as AgentRole[]
        teamName = 'Custom Team'
    }

    if (roles.length === 0) {
        return '❌ Keine gültigen Rollen gefunden.'
    }

    // Find captain
    const captain = roles.find(r => r.id === 'captain')
    const specialists = roles.filter(r => r.id !== 'captain')

    if (specialists.length === 0) {
        return '❌ Mindestens ein Spezialist nötig (neben Captain).'
    }

    // Create run tracking
    const run: TeamRun = {
        id: randomUUID().slice(0, 8),
        teamId: teamName,
        query,
        status: 'decomposing',
        startedAt: Date.now(),
        subtasks: [],
        results: [],
        onProgress,
    }
    activeRuns.set(run.id, run)

    try {
        const teamEmojis = roles.map(r => r.emoji).join('')
        await onProgress?.(`${teamEmojis} **${teamName}** gestartet...\n\n🎯 Query: _${query.slice(0, 100)}_`)

        // ==============================
        // Step 1: Captain decomposes (or skip if no captain)
        // ==============================
        let subtasks: string[] = []

        if (captain) {
            run.status = 'decomposing'
            await onProgress?.('🎯 Captain zerlegt die Aufgabe...')

            const decomposePrompt = `Zerlege diese Aufgabe in ${specialists.length} Sub-Tasks, eine für jeden Spezialisten:
${specialists.map(s => `- ${s.emoji} ${s.name}: ${s.description}`).join('\n')}

User-Anfrage: "${query}"

Antworte NUR mit einer nummerierten Liste der Sub-Tasks, eine pro Spezialist. Format:
1. [Rollenname]: [Konkrete Aufgabe]`

            const decomposition = await callLLM(captain, decomposePrompt)
            subtasks = decomposition.split('\n').filter(l => l.trim().match(/^\d/))
            run.subtasks = subtasks

            if (subtasks.length > 0) {
                await onProgress?.(`🎯 Captain hat ${subtasks.length} Sub-Tasks verteilt:\n${subtasks.map(s => `  ${s}`).join('\n')}`)
            }
        }

        // If no subtasks from captain, each specialist gets the original query
        if (subtasks.length === 0) {
            subtasks = specialists.map((s, i) => `${i + 1}. ${s.name}: ${query}`)
        }

        // ==============================
        // Step 2: Specialists execute in parallel
        // ==============================
        run.status = 'executing'
        const specialistEmojis = specialists.map(s => s.emoji).join(' ')
        await onProgress?.(`⚡ ${specialistEmojis} Spezialisten arbeiten parallel...`)

        const promises = specialists.map(async (specialist, idx) => {
            const subtask = subtasks[idx] || query
            const startTime = Date.now()

            try {
                const taskPrompt = `Kontext: Du bist Teil eines Agent-Teams. Deine spezifische Aufgabe:

${subtask}

Original-Anfrage des Users: "${query}"

Erledige DEINE Aufgabe gruendlich. Antworte strukturiert und praegnant.`

                const content = await callLLM(specialist, taskPrompt)

                const result: AgentResult = {
                    roleId: specialist.id,
                    roleName: specialist.name,
                    emoji: specialist.emoji,
                    content,
                    durationMs: Date.now() - startTime,
                }

                await onProgress?.(`${specialist.emoji} ${specialist.name} fertig (${((Date.now() - startTime) / 1000).toFixed(1)}s)`)
                return result
            } catch (err: any) {
                return {
                    roleId: specialist.id,
                    roleName: specialist.name,
                    emoji: specialist.emoji,
                    content: '',
                    durationMs: Date.now() - startTime,
                    error: err.message?.slice(0, 100),
                } as AgentResult
            }
        })

        // Execute all in parallel!
        const results = await Promise.allSettled(promises)
        run.results = results.map(r => r.status === 'fulfilled' ? r.value : {
            roleId: 'unknown', roleName: 'Unknown', emoji: '❓',
            content: '', durationMs: 0, error: 'Promise rejected',
        })

        // ==============================
        // Step 3: Captain aggregates (or simple merge)
        // ==============================
        run.status = 'aggregating'

        const validResults = run.results.filter(r => r.content && !r.error)

        if (validResults.length === 0) {
            run.status = 'failed'
            run.completedAt = Date.now()
            return '❌ Kein Agent konnte ein Ergebnis liefern.'
        }

        let finalAnswer: string

        if (captain && validResults.length > 1) {
            await onProgress?.('🎯 Captain aggregiert die Ergebnisse...')

            const aggregatePrompt = `Du bist der Captain. Hier sind die Ergebnisse deines Teams:

${validResults.map(r => `### ${r.emoji} ${r.roleName} (${(r.durationMs / 1000).toFixed(1)}s):\n${r.content}`).join('\n\n---\n\n')}

Original-Frage: "${query}"

Erstelle eine FINALE Antwort die:
1. Die besten Erkenntnisse aller Agents zusammenfasst
2. Widersprueche kennzeichnet
3. Konkrete Handlungsempfehlungen gibt
4. Auf Deutsch ist, strukturiert mit Ueberschriften

Beginne NICHT mit "Als Captain..." — schreib direkt die Antwort.`

            finalAnswer = await callLLM(captain, aggregatePrompt)
        } else {
            // No captain or only one result — use directly
            finalAnswer = validResults.map(r =>
                `${r.emoji} **${r.roleName}:**\n${r.content}`
            ).join('\n\n---\n\n')
        }

        // ==============================
        // Build final response
        // ==============================
        const totalDuration = Date.now() - run.startedAt
        const teamFooter = `\n\n---\n_${teamEmojis} ${teamName} • ${validResults.length}/${specialists.length} Agents • ${(totalDuration / 1000).toFixed(1)}s_`

        run.finalAnswer = finalAnswer + teamFooter
        run.status = 'completed'
        run.completedAt = Date.now()
        activeRuns.delete(run.id)

        return run.finalAnswer

    } catch (err: any) {
        run.status = 'failed'
        run.completedAt = Date.now()
        activeRuns.delete(run.id)
        console.error(`[TeamCoord] Team run failed: ${err}`)
        return `❌ Team-Ausführung fehlgeschlagen: ${err.message?.slice(0, 100)}`
    }
}

// ============================================
// Single SubAgent
// ============================================

export async function runSubAgent(
    roleId: string,
    query: string,
    onProgress?: (status: string) => Promise<void>
): Promise<string> {
    const role = getRole(roleId) || BUILT_IN_ROLES.analyst // Fallback: analyst
    const startTime = Date.now()

    await onProgress?.(`${role.emoji} **${role.name}** gestartet...`)

    try {
        const result = await callLLM(role, query)
        const duration = ((Date.now() - startTime) / 1000).toFixed(1)
        return `${role.emoji} **${role.name}** (${duration}s):\n\n${result}`
    } catch (err: any) {
        return `❌ ${role.name} fehlgeschlagen: ${err.message?.slice(0, 100)}`
    }
}

// ============================================
// LLM Call (uses best available)
// ============================================

async function callLLM(role: AgentRole, prompt: string): Promise<string> {
    // Try 1: Use mesh LLM proxy (can route to nodes)
    try {
        const { proxyLLMRequest } = await import('../mesh/mesh-llm-proxy.js')
        const result = await proxyLLMRequest({
            prompt: `${role.systemPrompt}\n\n---\n\n${prompt}`,
            model: role.preferredModel,
            maxTokens: role.maxTokens || 1500,
            temperature: role.temperature || 0.5,
            preferLocal: role.preferredNode !== 'master',
        })
        if (result && !result.includes('Kein LLM verfuegbar')) return result
    } catch { }

    // Try 2: Direct OpenAI API
    const apiKey = process.env.OPENAI_API_KEY
    if (apiKey) {
        try {
            const model = role.preferredModel || 'auto'
            const resp = await fetch(
                ``,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: `${role.systemPrompt}\n\n---\n\n${prompt}` }] }],
                        generationConfig: {
                            maxOutputTokens: role.maxTokens || 1500,
                            temperature: role.temperature || 0.5,
                        },
                    }),
                    signal: AbortSignal.timeout(45000),
                }
            )
            if (resp.ok) {
                const data = await resp.json() as any
                return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Keine Antwort generiert.'
            }
        } catch { }
    }

    // Try 3: Nova's own LLM client
    try {
        const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
        const llm = await createNovaLLMClient({})
        const response = await llm.complete([
            { role: 'system', content: role.systemPrompt },
            { role: 'user', content: prompt },
        ] as any)
        return response.content || 'Keine Antwort generiert.'
    } catch { }

    throw new Error('Kein LLM verfuegbar')
}

// ============================================
// Status
// ============================================

export function getActiveRuns(): TeamRun[] {
    return Array.from(activeRuns.values())
}

export function getRunStatus(runId: string): TeamRun | undefined {
    return activeRuns.get(runId)
}

// ============================================
// Persistence
// ============================================

function loadTeams(): void {
    try {
        const path = join(DATA_DIR, 'custom-teams.json')
        if (existsSync(path)) {
            customTeams = JSON.parse(readFileSync(path, 'utf-8'))
        }
    } catch { }
}

function saveTeams(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'custom-teams.json'), JSON.stringify(customTeams, null, 2))
    } catch { }
}

// ============================================
// Init
// ============================================

export function initTeamCoordinator(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    loadTeams()
    console.log(`[TeamCoord] ✅ Initialized: ${Object.keys(TEAM_PRESETS).length} presets, ${customTeams.length} custom teams, ${Object.keys(BUILT_IN_ROLES).length} roles`)
}
