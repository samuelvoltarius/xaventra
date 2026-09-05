/**
 * Nova - Configuration Loader
 * 
 * Loads configuration from JSON/YAML files like nova
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
// Nova's mature config schemas intentionally retain Zod 3 semantics while the
// optional OpenAI Agents backend uses the package's Zod 4 root export.
import { z } from 'zod/v3'
import { atomicWriteJson } from './atomic-storage.js'

// ============================================
// Config Schema (Complete)
// ============================================

export const NovaConfigSchema = z.object({
    // Identity
    name: z.string().default('Nova'),
    emoji: z.string().default('✨'),
    version: z.string().default('0.1.0'),

    // Stable identity mapping. Keys may be raw IDs or "channel:raw-id".
    // Display aliases are intentionally separate and never used as data keys.
    userPrincipals: z.record(z.string(), z.string()).default({}),
    userAliases: z.record(z.string(), z.string()).default({}),

    // Provider & Model — all real providers incl. minimax + openai-codex
    provider: z.enum([
        'local',
        'openai',
        'openai-codex',
        'anthropic',
        'minimax',
        'qwen',
        'ollama',
        'groq',
        'openrouter',
    ]).default('local'),

    model: z.string().default('auto'),

    // Internal model for self-repair, idle-learning, self-check (local, free)
    internalModel: z.string().default('auto'),
    learningModel: z.string().default('auto'),
    repairModel: z.string().default('auto'),

    // Nova Doctor: local GGUF model for autonomous diagnostics
    // 'auto' = pick best model that fits available RAM (default)
    // 'off'  = disable Nova Doctor entirely
    // '1.5b-q5km' | '1.5b-q4km' | '1.5b-q2k' | '0.5b-q5km' | '0.5b-q4km' | '0.5b-q2k' = explicit
    doctorModel: z.string().default('auto'),

    fallbackModels: z.array(z.string()).default([
        'auto',
        'auto',
        'auto',
    ]),

    // Per-role model overrides (set to 'auto' for auto-detection)
    models: z.object({
        chat: z.string().default('auto'),
        vision: z.string().default('auto'),
        embedding: z.string().default('nomic-embed-text'),
        code: z.string().default('auto'),
        reasoning: z.string().default('auto'),
        small: z.string().default('auto'),
    }).default({}),

    // Auth
    auth: z.object({
        // OpenAI
        openaiApiKey: z.string().optional(),
        openaiProjectId: z.string().optional(),

        // Anthropic
        anthropicApiKey: z.string().optional(),

        // Groq
        groqApiKey: z.string().optional(),

        // OpenRouter
        openrouterApiKey: z.string().optional(),

        // Tokens (loaded from file or env)
        tokenFile: z.string().default('.nova-tokens.json'),
        // Fallback: IDE shared tokens (readonly)
        ideTokenFile: z.string().default('~/.pi/agent/auth.json'),
    }).default({}),

    // Channels
    channels: z.object({
        whatsapp: z.object({
            enabled: z.boolean().default(false),
            authPath: z.string().default('.nova-whatsapp-auth'),
            allowFrom: z.array(z.string()).default([]),
        }).default({}),

        telegram: z.object({
            enabled: z.boolean().default(false),
            token: z.string().optional(),
            allowFrom: z.array(z.string()).default([]),
        }).default({}),

        discord: z.object({
            enabled: z.boolean().default(false),
            token: z.string().optional(),
        }).default({}),

        matrix: z.object({
            enabled: z.boolean().default(false),
            homeserverUrl: z.string().optional(),
            userId: z.string().optional(),
            accessToken: z.string().optional(),
        }).default({}),

        signal: z.object({
            enabled: z.boolean().default(false),
            apiUrl: z.string().default('http://localhost:8080'),
            phoneNumber: z.string().optional(),
        }).default({}),

        slack: z.object({
            enabled: z.boolean().default(false),
            botToken: z.string().optional(),
            appToken: z.string().optional(),
        }).default({}),

        voip: z.object({
            enabled: z.boolean().default(false),
            ariUrl: z.string().default('http://localhost:8088/ari'),
            username: z.string().optional(),
            password: z.string().optional(),
            appName: z.string().default('nova'),
        }).default({}),
    }).default({}),

    // Memory
    memory: z.object({
        enabled: z.boolean().default(true),
        dbPath: z.string().default('.nova-memory'),
        autoRecall: z.boolean().default(true),
        autoCapture: z.boolean().default(true),
    }).default({}),

    // Learning
    learning: z.object({
        enabled: z.boolean().default(true),
        dataDir: z.string().default('.nova-learning'),
        autoLearnThreshold: z.number().default(3),
    }).default({}),

    // Resilience (Layer 0)
    resilience: z.object({
        enabled: z.boolean().default(true),
        strictQuality: z.boolean().default(true),
        fallbackTimeout: z.number().default(30000), // 30s before Layer 0 takes over
        healthCheckInterval: z.number().default(30000),
    }).default({}),

    // APIs for search and other services
    apis: z.object({
        brave_search_key: z.string().optional(),
        tavily_key: z.string().optional(),
        perplexity_key: z.string().optional(),
    }).default({}),

    // Server
    server: z.object({
        enabled: z.boolean().default(false),
        port: z.number().default(18789),
        host: z.string().default('0.0.0.0'),
    }).default({}),

    // ChatGPT-managed Codex OAuth. Credentials are owned by Codex in a
    // node-local CODEX_HOME scoped to canonical user x node.
    codex: z.object({
        enabled: z.boolean().default(false),
        preferWhenAuthenticated: z.boolean().default(true),
        model: z.string().default('gpt-5.4'),
        fallbackModel: z.string().default('auto'),
        fallbackEndpoint: z.string().optional(),
    }).default({}),

    performance: z.object({
        preloadProfile: z.enum(['off', 'minimal', 'full']).default('minimal'),
        maxConcurrentRequests: z.number().int().min(1).max(64).default(4),
        maxRequestQueue: z.number().int().min(1).max(1000).default(100),
    }).default({}),

    runtime: z.object({
        profile: z.enum(['home', 'server', 'nas', 'worker', 'developer']).default('home'),
        bundles: z.array(z.string()).default([]),
        hotReload: z.boolean().default(false),
        acpEnabled: z.boolean().default(false),
    }).default({}),
}).passthrough()

export type NovaConfig = z.infer<typeof NovaConfigSchema>

// ============================================
// Config Loader
// ============================================

const CONFIG_FILENAMES = [
    'nova.config.json',
    'nova.json',
    '.novarc',
    '.novarc.json',
]

export async function loadConfig(configPath?: string): Promise<NovaConfig> {
    let configFile: string | null = null
    let configData: Record<string, unknown> = {}

    // Try to find config file
    if (configPath) {
        if (existsSync(configPath)) {
            configFile = configPath
        }
    } else {
        // Search in current directory
        for (const filename of CONFIG_FILENAMES) {
            const fullPath = join(process.cwd(), filename)
            if (existsSync(fullPath)) {
                configFile = fullPath
                break
            }
        }
    }

    // Load config file if found
    if (configFile) {
        try {
            const content = await readFile(configFile, 'utf-8')
            configData = JSON.parse(content)
            console.log(`[Nova Config] Loaded from: ${configFile}`)
        } catch (err) {
            console.error(`[Nova Config] Failed to load ${configFile}:`, err)
        }
    } else {
        console.log('[Nova Config] No config file found, using defaults')
    }

    // Override with environment variables
    configData = applyEnvOverrides(configData)

    // Parse and validate
    const result = NovaConfigSchema.safeParse(configData)

    if (!result.success) {
        console.error('[Nova Config] Validation errors:', result.error.flatten())
        // Return defaults on error
        return NovaConfigSchema.parse({})
    }

    return result.data
}

// ============================================
// Environment Overrides
// ============================================

function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
    const env = process.env

    // Direct mappings
    if (env.NOVA_NAME) config.name = env.NOVA_NAME
    if (env.NOVA_PROVIDER) config.provider = env.NOVA_PROVIDER
    if (env.NOVA_MODEL) config.model = env.NOVA_MODEL

    // Auth
    const auth = (config.auth as Record<string, unknown>) ?? {}
    if (env.OPENAI_API_KEY) auth.openaiApiKey = env.OPENAI_API_KEY
    if (env.ANTHROPIC_API_KEY) auth.anthropicApiKey = env.ANTHROPIC_API_KEY
    if (env.OPENAI_PROJECT_ID) auth.openaiProjectId = env.OPENAI_PROJECT_ID
    config.auth = auth

    // Channels
    const channels = (config.channels as Record<string, unknown>) ?? {}

    if (env.TELEGRAM_BOT_TOKEN) {
        channels.telegram = { ...((channels.telegram as object) ?? {}), enabled: true, token: env.TELEGRAM_BOT_TOKEN }
    }
    if (env.DISCORD_BOT_TOKEN) {
        channels.discord = { ...((channels.discord as object) ?? {}), enabled: true, token: env.DISCORD_BOT_TOKEN }
    }
    if (env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN) {
        channels.slack = {
            ...((channels.slack as object) ?? {}),
            enabled: true,
            botToken: env.SLACK_BOT_TOKEN,
            appToken: env.SLACK_APP_TOKEN,
        }
    }

    config.channels = channels

    return config
}

// ============================================
// Save Config
// ============================================

export async function saveConfig(config: NovaConfig, path?: string): Promise<void> {
    const filePath = path ?? join(process.cwd(), 'nova.config.json')
    await atomicWriteJson(filePath, config)

    console.log(`[Nova Config] Saved to: ${filePath}`)
}

// ============================================
// Singleton Getter (for tools)
// ============================================

let cachedConfig: NovaConfig | null = null

export function getNovaConfig(): NovaConfig {
    if (!cachedConfig) {
        // Return defaults if not yet loaded
        cachedConfig = NovaConfigSchema.parse({})
    }
    return cachedConfig
}

export function setNovaConfig(config: NovaConfig): void {
    cachedConfig = config
    // NOTE: Do NOT auto-persist on read — setNovaConfig is called at startup just to
    // populate the singleton. Auto-saving would overwrite user edits with schema defaults.
    // Only persist explicitly via saveConfig() when the user actually changes something.
}

// ============================================
// Export
// ============================================

export default {
    NovaConfigSchema,
    loadConfig,
    saveConfig,
    getNovaConfig,
    setNovaConfig,
}



