/**
 * Nova Multi-Bot System
 * 
 * Spawn and manage multiple Nova instances with different personas.
 * Each bot can have its own configuration, memory, and channel.
 * 
 * Features:
 * - Spawn bots dynamically
 * - Per-bot configuration
 * - Inter-bot communication via Swarm
 * - Multi-user per bot support
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentSwarm } from './L7-learning.js'

// ============================================
// Types
// ============================================

export interface BotConfig {
    id: string
    name: string
    persona: string  // System prompt persona
    channel: 'telegram' | 'discord' | 'whatsapp' | 'cli'
    channelConfig: {
        token?: string
        botUsername?: string
    }
    model?: string
    provider?: string
    enabled: boolean
    allowedUsers?: string[]  // User IDs allowed to use this bot
    createdAt: number
    createdBy: string
}

export interface BotInstance {
    config: BotConfig
    status: 'stopped' | 'starting' | 'running' | 'error'
    agentId?: string  // Swarm agent ID
    startedAt?: number
    error?: string
    messageCount: number
    activeUsers: Set<string>
}

// ============================================
// Multi-Bot Manager
// ============================================

export class MultiBotManager {
    private bots: Map<string, BotInstance> = new Map()
    private configPath: string

    constructor(dataDir: string) {
        this.configPath = join(dataDir, 'bots.json')
        this.load()
    }

    // ============================================
    // Bot Management
    // ============================================

    createBot(config: Omit<BotConfig, 'id' | 'createdAt'>): BotConfig {
        const fullConfig: BotConfig = {
            ...config,
            id: crypto.randomUUID(),
            createdAt: Date.now(),
        }

        const instance: BotInstance = {
            config: fullConfig,
            status: 'stopped',
            messageCount: 0,
            activeUsers: new Set(),
        }

        this.bots.set(fullConfig.id, instance)
        this.save()

        console.log(`[MultiBots] Bot erstellt: ${config.name} (${config.channel})`)
        return fullConfig
    }

    async startBot(botId: string): Promise<void> {
        const instance = this.bots.get(botId)
        if (!instance) throw new Error(`Bot ${botId} nicht gefunden`)
        if (!instance.config.enabled) throw new Error(`Bot ${instance.config.name} ist deaktiviert`)

        instance.status = 'starting'

        try {
            // Register in swarm
            const swarm = getAgentSwarm()
            const agent = swarm.registerAgent({
                name: instance.config.name,
                role: instance.config.channel,
                channel: instance.config.channel,
            })

            instance.agentId = agent.id
            instance.status = 'running'
            instance.startedAt = Date.now()
            instance.error = undefined

            console.log(`[MultiBots] Bot gestartet: ${instance.config.name}`)
        } catch (err) {
            instance.status = 'error'
            instance.error = err instanceof Error ? err.message : String(err)
            throw err
        }
    }

    async stopBot(botId: string): Promise<void> {
        const instance = this.bots.get(botId)
        if (!instance) return

        if (instance.agentId) {
            getAgentSwarm().unregisterAgent(instance.agentId)
            instance.agentId = undefined
        }

        instance.status = 'stopped'
        instance.startedAt = undefined
        console.log(`[MultiBots] Bot gestoppt: ${instance.config.name}`)
    }

    deleteBot(botId: string): void {
        const instance = this.bots.get(botId)
        if (instance && instance.status === 'running') {
            this.stopBot(botId)
        }
        this.bots.delete(botId)
        this.save()
    }

    updateBot(botId: string, updates: Partial<BotConfig>): void {
        const instance = this.bots.get(botId)
        if (!instance) return

        Object.assign(instance.config, updates)
        this.save()
    }

    // ============================================
    // User Management
    // ============================================

    isUserAllowed(botId: string, userId: string): boolean {
        const instance = this.bots.get(botId)
        if (!instance) return false

        // No allowlist = everyone allowed
        if (!instance.config.allowedUsers || instance.config.allowedUsers.length === 0) {
            return true
        }

        return instance.config.allowedUsers.includes(userId)
    }

    addAllowedUser(botId: string, userId: string): void {
        const instance = this.bots.get(botId)
        if (!instance) return

        if (!instance.config.allowedUsers) {
            instance.config.allowedUsers = []
        }

        if (!instance.config.allowedUsers.includes(userId)) {
            instance.config.allowedUsers.push(userId)
            this.save()
        }
    }

    removeAllowedUser(botId: string, userId: string): void {
        const instance = this.bots.get(botId)
        if (!instance?.config.allowedUsers) return

        const index = instance.config.allowedUsers.indexOf(userId)
        if (index >= 0) {
            instance.config.allowedUsers.splice(index, 1)
            this.save()
        }
    }

    // Track active user
    trackUserActivity(botId: string, userId: string): void {
        const instance = this.bots.get(botId)
        if (instance) {
            instance.activeUsers.add(userId)
            instance.messageCount++
        }
    }

    // ============================================
    // Queries
    // ============================================

    getBot(botId: string): BotInstance | undefined {
        return this.bots.get(botId)
    }

    getBotByName(name: string): BotInstance | undefined {
        for (const instance of this.bots.values()) {
            if (instance.config.name.toLowerCase() === name.toLowerCase()) {
                return instance
            }
        }
        return undefined
    }

    getAllBots(): BotInstance[] {
        return Array.from(this.bots.values())
    }

    getRunningBots(): BotInstance[] {
        return this.getAllBots().filter(b => b.status === 'running')
    }

    getBotsByChannel(channel: string): BotInstance[] {
        return this.getAllBots().filter(b => b.config.channel === channel)
    }

    // ============================================
    // Persistence
    // ============================================

    private load(): void {
        if (!existsSync(this.configPath)) return

        try {
            const data = JSON.parse(readFileSync(this.configPath, 'utf-8')) as BotConfig[]
            for (const config of data) {
                this.bots.set(config.id, {
                    config,
                    status: 'stopped',
                    messageCount: 0,
                    activeUsers: new Set(),
                })
            }
            console.log(`[MultiBots] ${data.length} Bot(s) geladen`)
        } catch { /* ignore */ }
    }

    private save(): void {
        const dir = join(this.configPath, '..')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

        const configs = this.getAllBots().map(b => b.config)
        writeFileSync(this.configPath, JSON.stringify(configs, null, 2))
    }

    // ============================================
    // Stats
    // ============================================

    getStats() {
        const all = this.getAllBots()
        const running = this.getRunningBots()

        return {
            totalBots: all.length,
            runningBots: running.length,
            totalMessages: all.reduce((sum, b) => sum + b.messageCount, 0),
            totalActiveUsers: new Set(
                all.flatMap(b => Array.from(b.activeUsers))
            ).size,
        }
    }
}

// ============================================
// Preset Bot Templates
// ============================================

export const BOT_TEMPLATES = {
    assistant: {
        name: 'Nova Assistant',
        persona: 'Du bist Nova ✨, ein freundlicher und hilfreicher KI-Assistent. Antworte immer auf Deutsch.',
        channel: 'telegram' as const,
    },
    coder: {
        name: 'Nova Coder',
        persona: 'Du bist Nova Code ✨, ein Experte für Programmierung. Du schreibst sauberen, gut kommentierten Code und erklärst deine Lösungen.',
        channel: 'telegram' as const,
    },
    researcher: {
        name: 'Nova Researcher',
        persona: 'Du bist Nova Search ✨, ein Recherche-Spezialist. Du suchst im Internet und fasst Informationen präzise zusammen.',
        channel: 'telegram' as const,
    },
    translator: {
        name: 'Nova Translator',
        persona: 'Du bist Nova Trans ✨, ein Übersetzungs-Experte. Du übersetzt zwischen allen Sprachen und erklärst kulturelle Nuancen.',
        channel: 'telegram' as const,
    },
}

// ============================================
// Global Instance
// ============================================

let botManager: MultiBotManager | null = null

export function getMultiBotManager(dataDir?: string): MultiBotManager {
    if (!botManager) {
        const dir = dataDir || join(process.cwd(), '.nova-bots')
        botManager = new MultiBotManager(dir)
    }
    return botManager
}

export default {
    MultiBotManager,
    BOT_TEMPLATES,
    getMultiBotManager,
}
