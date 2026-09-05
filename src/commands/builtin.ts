/**
 * Nova - Built-in Commands
 * 
 * Core commands that Nova understands natively.
 */

import { getDefaultModel } from '../core/model-defaults.js'
import { BRAIN_COMMANDS, handlePossibleNodeSelection } from './brain-commands.js'
import { resolveConfigPath } from '../config/config-path.js'


export interface NovaCommand {
    name: string
    aliases: string[]
    description: string
    handler: (args: string[]) => Promise<string>
}

interface BotInfo {
    name: string
    version: string
    model: string
    provider: string
    emoji: string
    selfLearning?: boolean
}

let botInfo: BotInfo = {
    name: 'Nova',
    version: '2.58.0',
    model: 'auto',  // Will be updated dynamically
    provider: 'local',
    emoji: '✨',
    selfLearning: true,
}

// Dynamic model getter — always returns current runtime model
function getCurrentModelInfo(): { model: string; provider: string } {
    try {
        // Try model-router first (reflects /model switches)
        const { getCurrentModel } = require('../intelligence/model-router.js')
        const model = getCurrentModel()
        if (model && model !== 'unknown') {
            return { model, provider: botInfo.provider }
        }
    } catch { /* fallback */ }
    try {
        // Fallback: read from config file
        const { readFileSync } = require('node:fs')
        const { join } = require('node:path')
        const cfg = JSON.parse(readFileSync(resolveConfigPath(), 'utf-8'))
        return { model: cfg.model || 'unknown', provider: cfg.provider || 'local' }
    } catch { /* fallback */ }
    return { model: botInfo.model, provider: botInfo.provider }
}

export const BUILTIN_COMMANDS: NovaCommand[] = [
    ...BRAIN_COMMANDS,
    {
        name: 'help',
        aliases: ['?', 'hilfe'],
        description: 'Shows available commands',
        handler: async () => {
            const lines = ['📚 **Nova Commands**\n']
            for (const cmd of BUILTIN_COMMANDS) {
                lines.push(`• **/${cmd.name}** - ${cmd.description}`)
            }
            return lines.join('\n')
        }
    },
    {
        name: 'status',
        aliases: ['ping', 'health'],
        description: 'Shows Nova status',
        handler: async () => {
            const uptime = Math.floor(process.uptime())
            const memory = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024)
            const { model } = getCurrentModelInfo()
            return `✅ **Nova Status**\n• Uptime: ${uptime}s\n• Memory: ${memory}MB\n• Model: ${model}`
        }
    },
    {
        name: 'clear',
        aliases: ['reset', 'new'],
        description: 'Clears conversation context',
        handler: async () => {
            return '🧹 Kontext gelöscht. Neue Unterhaltung gestartet.'
        }
    },
    {
        name: 'model',
        aliases: ['llm'],
        description: 'Shows current LLM model',
        handler: async () => {
            const { model, provider } = getCurrentModelInfo()
            return `🤖 **Aktuelles Modell**: ${model} (${provider})`
        }
    },
    {
        name: 'distill',
        aliases: ['memorize', 'digest'],
        description: 'Manually trigger nightly memory distillation',
        handler: async (args) => {
            try {
                const { runDistillation, getDistillerLlm } = await import('../layers/memory-distiller.js')
                const targetDate = args[0] || undefined  // optional YYYY-MM-DD arg

                // Use the LLM that was set by daemon.ts (may be null → fallback mode)
                const llm = getDistillerLlm()

                const result = await runDistillation(llm, targetDate)
                if (!result) {
                    return '📔 Distillation: Keine Journal-Daten für dieses Datum gefunden.'
                }
                return [
                    `🌙 **Memory Distillation abgeschlossen** (${result.date})`,
                    '',
                    `📖 ${result.diaryText}`,
                    '',
                    result.userFacts.length     ? `👤 User-Fakten: ${result.userFacts.length}` : '',
                    result.learnings.length     ? `🎓 Learnings: ${result.learnings.length}` : '',
                    result.decisions.length     ? `✅ Entscheidungen: ${result.decisions.length}` : '',
                    result.openQuestions.length ? `❓ Offene Fragen: ${result.openQuestions.length}` : '',
                    '',
                    `📁 Diary: \`.nova-data/memories/diary/${result.date}.md\``,
                ].filter(Boolean).join('\n')
            } catch (e: any) {
                return `❌ Distillation fehlgeschlagen: ${e.message}`
            }
        }
    },
    {
        name: 'doctor',
        aliases: ['diagnose', 'debug'],
        description: 'Diagnose an error with Nova Doctor | /doctor status | /doctor <error>',
        handler: async (args) => {
            try {
                const { getDoctorInfo } = await import('../llm/llama-engine.js')
                const info = getDoctorInfo()

                // /doctor status — show hardware + available models
                if (args[0] === 'status' || args[0] === 'info') {
                    const modelList = info.models.length > 0
                        ? info.models.map(m => `  • ${m}`).join('\n')
                        : '  (keine GGUFs in models/)'
                    return [
                        '🏥 **Nova Doctor Status**',
                        '',
                        `🖥️ RAM: ${info.ramGB} GB | CPU Threads: ${info.cpuThreads}`,
                        `🤖 Aktives Modell: ${info.modelName ?? '—'}`,
                        `📦 Verfügbare Modelle:\n${modelList}`,
                        '',
                        info.available
                            ? '✅ Nova Doctor ist online'
                            : '⚠️ Kein GGUF gefunden — lege Modelle in `models/` ab',
                    ].join('\n')
                }

                // /doctor <error text> — diagnose
                const errorText = args.join(' ')
                if (!errorText) {
                    return [
                        '🏥 **Nova Doctor**',
                        '',
                        'Nutzung:',
                        '  `/doctor <fehlermeldung>` — Fehler diagnostizieren',
                        '  `/doctor status`          — Hardware & Modell-Info',
                        '',
                        `Modell: ${info.modelName ?? 'nicht verfügbar'}`,
                        `RAM: ${info.ramGB} GB, CPU Threads: ${info.cpuThreads}`,
                    ].join('\n')
                }

                const { diagnose } = await import('../intelligence/doctor-client.js')
                const result = await diagnose({ error: errorText })
                const confidence = { high: '🟢', medium: '🟡', low: '🔴' }[result.confidence] ?? '❓'
                const source = result.fromModel ? `🤖 ${info.modelName}` : '📐 Regelbasiert'
                return [
                    `🏥 **Nova Doctor** ${confidence} (${source})`,
                    '',
                    `**Diagnose:** ${result.diagnosis}`,
                    '',
                    `**Fix:** ${result.fix}`,
                    '',
                    result.autoApply ? '✅ Sicher für automatische Anwendung' : '⚠️ Bitte manuell prüfen',
                ].join('\n')
            } catch (e: any) {
                return `❌ Nova Doctor Fehler: ${e.message}`
            }
        }
    },
]

// Initialize commands
export function initBuiltinCommands(): void {
    console.log(`[Nova] Loaded ${BUILTIN_COMMANDS.length} built-in commands`)
}

// Get all commands
export function getBuiltinCommands(): NovaCommand[] {
    return BUILTIN_COMMANDS
}

export function getAllCommands(): NovaCommand[] {
    return BUILTIN_COMMANDS
}

// Find a command
export function findCommand(input: string): NovaCommand | undefined {
    const normalized = input.toLowerCase().replace(/^\//, '')
    return BUILTIN_COMMANDS.find(cmd =>
        cmd.name === normalized || cmd.aliases.includes(normalized)
    )
}

// Execute a command
export async function executeCommand(input: string): Promise<string | null> {
    const parts = input.replace(/^\//, '').split(' ')
    const cmd = findCommand(parts[0])
    if (!cmd) return null

    const args = parts.slice(1)
    return cmd.handler(args)
}

// Handle node-selection replies (for interactive Brain install flow)
export { handlePossibleNodeSelection }

// Process command (accepts string or message object)
export async function processCommand(input: string | { content?: string }): Promise<string | null> {
    const text = typeof input === 'string' ? input : (input.content || '')
    return executeCommand(text)
}

// Bot info management
export function setBotInfo(info: Partial<BotInfo>): void {
    botInfo = { ...botInfo, ...info }
}

export function getBotInfo(): BotInfo {
    return botInfo
}

export default {
    BUILTIN_COMMANDS,
    initBuiltinCommands,
    getBuiltinCommands,
    getAllCommands,
    findCommand,
    executeCommand,
    processCommand,
    setBotInfo,
    getBotInfo,
}
