/**
 * Nova Centralized Configuration Service
 *
 * Single source of truth for ALL environment variables and configuration.
 * Loads once at boot time, validates required values, provides typed access.
 *
 * Usage:
 *   import { config } from './core/config-service.js'
 *   const key = config.apiKeys.openai  // typed, validated
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ============================================
// Config Interface
// ============================================

export interface NovaConfig {
    // === API Keys ===
    apiKeys: {
        openai: string
        anthropic: string
        openrouter: string
        deepgram: string
        elevenlabs: string
        stability: string
        newsapi: string
        openweather: string
        tavily: string
    }

    // === OAuth / Auth ===
    auth: {
        oauthApiKey: string
        authJsonPath: string
    }

    // === Supabase (Mesh + Learning) ===
    supabase: {
        meshUrl: string
        meshKey: string
        learningUrl: string
        learningKey: string
    }

    // === TTS (Text-to-Speech) ===
    tts: {
        openaiModel: string
        openaiVoice: string
        openaiBaseUrl: string
        elevenlabsVoiceId: string
        elevenlabsModelId: string
        edgeVoice: string
        edgeLang: string
    }

    // === Paths ===
    paths: {
        home: string
        dataDir: string
        pythonPath: string
        whisperModel: string
    }

    // === Scheduler ===
    scheduler: {
        newsCountry: string
        weatherCity: string
    }

    // === Debug & Runtime ===
    debug: boolean
    noColor: boolean
    nodeEnv: string
    pm2Home: string
}

// ============================================
// Default Values
// ============================================

const DEFAULTS: NovaConfig = {
    apiKeys: {
        openai: '',
        anthropic: '',
        openrouter: '',
        deepgram: '',
        elevenlabs: '',
        stability: '',
        newsapi: '',
        openweather: '',
        tavily: '',
    },
    auth: {
        oauthApiKey: '',
        authJsonPath: join(homedir(), '.pi', 'agent', 'auth.json'),
    },
    supabase: {
        meshUrl: 'http://192.0.2.12:3002',
        meshKey: '',
        learningUrl: 'http://192.0.2.12:3002',
        learningKey: '',
    },
    tts: {
        openaiModel: 'tts-1',
        openaiVoice: 'nova',
        openaiBaseUrl: '',
        elevenlabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
        elevenlabsModelId: 'eleven_multilingual_v2',
        edgeVoice: 'de-DE-ConradNeural',
        edgeLang: 'de-DE',
    },
    paths: {
        home: homedir(),
        dataDir: join(process.cwd(), '.nova-data'),
        pythonPath: '',
        whisperModel: '',
    },
    scheduler: {
        newsCountry: 'de',
        weatherCity: 'Berlin',
    },
    debug: false,
    noColor: false,
    nodeEnv: 'production',
    pm2Home: '',
}

// ============================================
// Singleton Instance
// ============================================

let _config: NovaConfig | null = null

/**
 * Load config from environment variables + nova.config.json (if present).
 * Config file values override defaults, env vars override config file.
 */
export function loadConfig(forceReload = false): NovaConfig {
    if (_config && !forceReload) return _config

    // Start with defaults
    const cfg: NovaConfig = JSON.parse(JSON.stringify(DEFAULTS))

    // Layer 1: Load from nova.config.json
    try {
        const configPath = join(process.cwd(), 'nova.config.json')
        if (existsSync(configPath)) {
            const file = JSON.parse(readFileSync(configPath, 'utf-8'))

            // Merge supabase config
            if (file.supabase) {
                if (file.supabase.meshUrl) cfg.supabase.meshUrl = file.supabase.meshUrl
                if (file.supabase.meshKey) cfg.supabase.meshKey = file.supabase.meshKey
                if (file.supabase.learningUrl) cfg.supabase.learningUrl = file.supabase.learningUrl
                if (file.supabase.learningKey) cfg.supabase.learningKey = file.supabase.learningKey
            }

            // Merge scheduler config
            if (file.scheduler) {
                if (file.scheduler.newsCountry) cfg.scheduler.newsCountry = file.scheduler.newsCountry
                if (file.scheduler.weatherCity) cfg.scheduler.weatherCity = file.scheduler.weatherCity
            }

            // Merge TTS config
            if (file.tts) {
                if (file.tts.openaiModel) cfg.tts.openaiModel = file.tts.openaiModel
                if (file.tts.openaiVoice) cfg.tts.openaiVoice = file.tts.openaiVoice
                if (file.tts.edgeVoice) cfg.tts.edgeVoice = file.tts.edgeVoice
                if (file.tts.edgeLang) cfg.tts.edgeLang = file.tts.edgeLang
            }

            // Merge paths
            if (file.paths) {
                if (file.paths.pythonPath) cfg.paths.pythonPath = file.paths.pythonPath
                if (file.paths.whisperModel) cfg.paths.whisperModel = file.paths.whisperModel
            }
        }
    } catch { /* config file optional */ }

    // Layer 2: Environment variables override everything
    const env = process.env

    // API Keys
    cfg.apiKeys.openai = env.OPENAI_API_KEY || cfg.apiKeys.openai
    cfg.apiKeys.openai = env.OPENAI_API_KEY || cfg.apiKeys.openai
    cfg.apiKeys.anthropic = env.ANTHROPIC_API_KEY || cfg.apiKeys.anthropic
    cfg.apiKeys.openrouter = env.OPENROUTER_API_KEY || cfg.apiKeys.openrouter
    cfg.apiKeys.deepgram = env.DEEPGRAM_API_KEY || cfg.apiKeys.deepgram
    cfg.apiKeys.elevenlabs = env.ELEVENLABS_API_KEY || cfg.apiKeys.elevenlabs
    cfg.apiKeys.stability = env.STABILITY_API_KEY || cfg.apiKeys.stability
    cfg.apiKeys.newsapi = env.NEWSAPI_KEY || cfg.apiKeys.newsapi
    cfg.apiKeys.openweather = env.OPENWEATHER_API_KEY || cfg.apiKeys.openweather
    cfg.apiKeys.tavily = env.TAVILY_API_KEY || cfg.apiKeys.tavily

    // Auth
    cfg.auth.oauthApiKey = env.NOVA_OAUTH_API_KEY || cfg.auth.oauthApiKey

    // Supabase (env overrides config file)
    cfg.supabase.meshUrl = env.NOVA_MESH_SUPABASE_URL || cfg.supabase.meshUrl
    cfg.supabase.meshKey = env.NOVA_MESH_SUPABASE_KEY || cfg.supabase.meshKey
    cfg.supabase.learningUrl = env.NOVA_LEARNING_SUPABASE_URL || cfg.supabase.learningUrl
    cfg.supabase.learningKey = env.NOVA_LEARNING_SUPABASE_KEY || cfg.supabase.learningKey

    // TTS
    cfg.tts.openaiModel = env.OPENAI_TTS_MODEL || cfg.tts.openaiModel
    cfg.tts.openaiVoice = env.OPENAI_TTS_VOICE || cfg.tts.openaiVoice
    cfg.tts.openaiBaseUrl = env.OPENAI_TTS_BASE_URL || cfg.tts.openaiBaseUrl
    cfg.tts.elevenlabsVoiceId = env.ELEVENLABS_VOICE_ID || cfg.tts.elevenlabsVoiceId
    cfg.tts.elevenlabsModelId = env.ELEVENLABS_MODEL_ID || cfg.tts.elevenlabsModelId
    cfg.tts.edgeVoice = env.EDGE_TTS_VOICE || cfg.tts.edgeVoice
    cfg.tts.edgeLang = env.EDGE_TTS_LANG || cfg.tts.edgeLang

    // Paths
    cfg.paths.home = env.USERPROFILE || env.HOME || cfg.paths.home
    cfg.paths.pythonPath = env.PYTHON_PATH || cfg.paths.pythonPath
    cfg.paths.whisperModel = env.WHISPER_CPP_MODEL || cfg.paths.whisperModel

    // Scheduler
    cfg.scheduler.newsCountry = env.NEWS_COUNTRY || cfg.scheduler.newsCountry
    cfg.scheduler.weatherCity = env.WEATHER_CITY || cfg.scheduler.weatherCity

    // Debug & Runtime
    cfg.debug = env.NOVA_DEBUG === 'true'
    cfg.noColor = Boolean(env.NO_COLOR)
    cfg.nodeEnv = env.NODE_ENV || cfg.nodeEnv
    cfg.pm2Home = env.PM2_HOME || cfg.pm2Home

    _config = cfg

    // Log what was loaded (redact secrets)
    const keyCount = Object.values(cfg.apiKeys).filter(k => k.length > 0).length
    console.log(`[ConfigService] ✅ Loaded: ${keyCount} API keys, debug=${cfg.debug}, env=${cfg.nodeEnv}`)

    return cfg
}

/**
 * Get the current config (loads if needed).
 * This is the primary access point — use this everywhere.
 */
export const config: NovaConfig = new Proxy({} as NovaConfig, {
    get(_target, prop) {
        const cfg = loadConfig()
        return (cfg as unknown as Record<string | symbol, unknown>)[prop]
    },
})

/**
 * Check if a specific API key is available.
 */
export function hasApiKey(provider: keyof NovaConfig['apiKeys']): boolean {
    return loadConfig().apiKeys[provider].length > 0
}

/**
 * Get a specific API key, throwing if not set.
 */
export function requireApiKey(provider: keyof NovaConfig['apiKeys']): string {
    const key = loadConfig().apiKeys[provider]
    if (!key) {
        throw new Error(`API key für ${provider} nicht gesetzt. Setze ${getEnvVarName(provider)} als Umgebungsvariable.`)
    }
    return key
}

/**
 * Map provider names to env var names for error messages.
 */
function getEnvVarName(provider: string): string {
    const map: Record<string, string> = {
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        deepgram: 'DEEPGRAM_API_KEY',
        elevenlabs: 'ELEVENLABS_API_KEY',
        stability: 'STABILITY_API_KEY',
        newsapi: 'NEWSAPI_KEY',
        openweather: 'OPENWEATHER_API_KEY',
        tavily: 'TAVILY_API_KEY',
    }
    return map[provider] || `${provider.toUpperCase()}_API_KEY`
}

/**
 * Set a runtime config value (e.g. after OAuth refresh).
 * Does NOT persist to disk — only for in-memory overrides.
 */
export function setConfigValue<K extends keyof NovaConfig>(
    section: K,
    key: keyof NovaConfig[K],
    value: NovaConfig[K][keyof NovaConfig[K]]
): void {
    const cfg = loadConfig()
        ; (cfg[section] as Record<string | number | symbol, unknown>)[key] = value
}
