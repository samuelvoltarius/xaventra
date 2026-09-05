/**
 * Nova Brain Commands
 * ===================
 * Slash commands for managing the Brain (Graphiti + Neo4j).
 *
 * /brain              — show Brain status
 * /brain install      — start interactive Node selection + install
 * /brain install <node> — install on specific node
 * /brain status       — health check
 * /brain search <q>   — search Brain
 * /brain forget       — clear all Brain memories (with confirmation)
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NovaCommand } from './builtin.js'

const CONFIG_PATH = join(process.cwd(), 'nova.config.json')

// Pending install state: waiting for user to pick a node
const pendingInstalls = new Map<string, { nodes: any[]; userId: string; channel: string }>()

// ── Helper ────────────────────────────────────────────────────────────────────

function getBrainConfig(): { brainUrl?: string; node?: string; enabled?: boolean } {
    try {
        const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
        return cfg.brain || {}
    } catch { return {} }
}

async function pingBrain(brainUrl: string): Promise<boolean> {
    try {
        const { execAsync } = await import('../installer/brain-installer.js').then(m => ({
            execAsync: (url: string) => fetch(url, { signal: AbortSignal.timeout(4000) }).then(r => r.json())
        }))
        const data = await execAsync(`${brainUrl}/health`)
        return (data as any)?.ok === true
    } catch { return false }
}

// ── Commands ──────────────────────────────────────────────────────────────────

export const BRAIN_COMMANDS: NovaCommand[] = [
    {
        name: 'brain',
        aliases: ['brain-status', 'memory'],
        description: 'Brain (Graphiti Memory) — Status, Install, Search',
        handler: async (args) => {
            const sub = args[0]?.toLowerCase()

            // /brain install [node-name]
            if (sub === 'install') {
                const { installBrain, findCapableNodes } = await import('../installer/brain-installer.js')
                const force = args.includes('--force')
                const nodeName = args.find(a => !a.startsWith('--') && a !== 'install')

                if (nodeName) {
                    // Direct install on named node
                    return installBrain({
                        selectedNodeName: nodeName,
                        force,
                        onProgress: msg => console.log(`[Brain] ${msg}`),
                    })
                }

                // Show node selection
                const nodes = await findCapableNodes()
                if (nodes.length === 0) {
                    return '❌ Keine kompatiblen Nodes im Tailscale-Netz gefunden.\n\nBrain benötigt: Linux/macOS, ≥4GB RAM, Python 3.10+'
                }

                // Store pending state (keyed by timestamp — real sessions would use userId)
                const key = `install:${Date.now()}`
                pendingInstalls.set(key, { nodes, userId: 'user', channel: 'default' })

                const lines = [
                    '🧠 **Brain — Node auswählen**',
                    '',
                    'Auf welchem Node soll Graphiti + Neo4j installiert werden?',
                    '',
                ]
                for (let i = 0; i < nodes.length; i++) {
                    const n = nodes[i]
                    const docker = n.hasDocker ? '🐳' : '⚠️ '
                    const tag = i === 0 ? ' ← empfohlen' : ''
                    lines.push(`**${i + 1}. ${n.name}**${tag}`)
                    lines.push(`   ${n.ramGb}GB RAM  ${docker}Docker: ${n.hasDocker ? 'ja' : 'nein'}  OS: ${n.os}`)
                    lines.push('')
                }
                lines.push('👉 `/brain install <Name>` — z.B. `/brain install mac-mini`')
                lines.push('   Oder schreibe einfach die Nummer: `1`')
                return lines.join('\n')
            }

            // /brain status
            if (sub === 'status' || !sub) {
                const cfg = getBrainConfig()
                if (!cfg.brainUrl) {
                    return [
                        '🧠 **Brain nicht installiert**',
                        '',
                        'Nova hat noch kein Langzeit-Gedächtnis (Graphiti + Neo4j).',
                        '',
                        '👉 `/brain install` — jetzt auf einem Tailscale-Node installieren',
                    ].join('\n')
                }

                const online = await pingBrain(cfg.brainUrl)
                const icon = online ? '🟢' : '🔴'
                return [
                    `🧠 **Brain Status**`,
                    '',
                    `${icon} ${online ? 'Online' : 'Offline'} — ${cfg.brainUrl}`,
                    `📍 Node: ${cfg.node || 'unbekannt'}`,
                    '',
                    online ? '`/brain search <query>` — Gedächtnis durchsuchen' : '⚠️  Brain nicht erreichbar. Läuft Docker auf dem Node?',
                ].join('\n')
            }

            // /brain search <query>
            if (sub === 'search' || sub === 'suche') {
                const query = args.slice(1).join(' ')
                if (!query) return '❌ Suchbegriff fehlt. Beispiel: `/brain search Tailscale`'

                const cfg = getBrainConfig()
                if (!cfg.brainUrl) return '❌ Brain nicht installiert. `/brain install`'

                try {
                    const resp = await fetch(`${cfg.brainUrl}/search`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query, limit: 5 }),
                        signal: AbortSignal.timeout(8000),
                    })
                    const results = await resp.json() as any[]
                    if (!results.length) return `🔍 Keine Ergebnisse für: "${query}"`

                    const lines = [`🔍 **Brain Search: "${query}"**`, '']
                    for (const r of results) {
                        const score = (r.score * 100).toFixed(0)
                        lines.push(`• [${score}%] ${r.content.slice(0, 200)}`)
                    }
                    return lines.join('\n')
                } catch (e: any) {
                    return `❌ Brain Search fehlgeschlagen: ${e.message}`
                }
            }

            // /brain forget
            if (sub === 'forget' || sub === 'reset') {
                const cfg = getBrainConfig()
                if (!cfg.brainUrl) return '❌ Brain nicht installiert.'
                return [
                    '⚠️  **Brain zurücksetzen?**',
                    '',
                    'Das löscht ALLE gespeicherten Erinnerungen (Neo4j Datenbank).',
                    '',
                    '👉 Bestätige mit: `/brain forget --confirm`',
                ].join('\n')
            }

            if (sub === 'forget' && args.includes('--confirm')) {
                const cfg = getBrainConfig()
                if (!cfg.brainUrl) return '❌ Brain nicht installiert.'
                try {
                    const resp = await fetch(`${cfg.brainUrl}/reset`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (resp.ok) {
                        return '🗑️ **Brain zurückgesetzt** — alle Erinnerungen gelöscht.'
                    }
                    // Fallback: brain_api may not have /reset → try Cypher via /query
                    const fallback = await fetch(`${cfg.brainUrl}/query`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query: 'MATCH (n) DETACH DELETE n' }),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (fallback.ok) {
                        return '🗑️ **Brain zurückgesetzt** (via Cypher) — alle Erinnerungen gelöscht.'
                    }
                    return `❌ Reset fehlgeschlagen (HTTP ${resp.status}). Manuell: \`MATCH (n) DETACH DELETE n\` in Neo4j Browser.`
                } catch (err: any) {
                    return `❌ Verbindungsfehler: ${err.message}\nManuell: \`MATCH (n) DETACH DELETE n\` in Neo4j Browser.`
                }
            }

            // /brain nodes — show candidate nodes
            if (sub === 'nodes') {
                const { findCapableNodes } = await import('../installer/brain-installer.js')
                const nodes = await findCapableNodes()
                if (!nodes.length) return '❌ Keine kompatiblen Nodes gefunden.'
                const lines = ['🌐 **Kompatible Nodes für Brain:**', '']
                for (const n of nodes) {
                    lines.push(`• **${n.name}** (${n.host}) — ${n.ramGb}GB RAM, Docker: ${n.hasDocker ? '✅' : '❌'}`)
                }
                return lines.join('\n')
            }

            // Default: show help
            return [
                '🧠 **Brain Commands**',
                '',
                '`/brain` oder `/brain status` — Status',
                '`/brain install` — Node auswählen & installieren',
                '`/brain install <node>` — direkt auf Node installieren',
                '`/brain nodes` — verfügbare Nodes anzeigen',
                '`/brain search <query>` — Gedächtnis durchsuchen',
                '`/brain forget` — alles löschen (mit Bestätigung)',
            ].join('\n')
        }
    }
]

/**
 * Handle a plain-text reply that might be a node selection number.
 * Returns install result or null if not a selection reply.
 */
export async function handlePossibleNodeSelection(
    text: string,
    userId: string
): Promise<string | null> {
    // Look for pending install for this user
    const entry = [...pendingInstalls.values()].find(e => e.userId === userId)
    if (!entry) return null

    const trimmed = text.trim()
    const num = parseInt(trimmed)

    let selectedNode = null
    if (!isNaN(num) && num >= 1 && num <= entry.nodes.length) {
        selectedNode = entry.nodes[num - 1]
    } else {
        // Try matching by name
        selectedNode = entry.nodes.find(n =>
            n.name.toLowerCase().includes(trimmed.toLowerCase())
        )
    }

    if (!selectedNode) return null

    // Clear pending
    for (const [k, v] of pendingInstalls) {
        if (v.userId === userId) pendingInstalls.delete(k)
    }

    const { installBrain } = await import('../installer/brain-installer.js')
    return installBrain({
        selectedNodeName: selectedNode.name,
        onProgress: msg => console.log(`[Brain] ${msg}`),
    })
}

export default { BRAIN_COMMANDS, handlePossibleNodeSelection }
