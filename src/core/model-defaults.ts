/**
 * Central Model Defaults — NO HARDCODED MODELS ANYWHERE ELSE!
 * 
 * All model references MUST use these functions.
 * Resolution order: ENV → config → discovery → fallback constant
 * 
 * The FALLBACK constant is the ONLY place a model name string exists.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


// Fallback: local LLM via Ollama or LM Studio, or OpenAI if API key is set
const ULTIMATE_FALLBACK = 'auto'

let _cachedConfigModel: string | null = null
let _cachedSubAgentModel: string | null = null

function readConfigModel(): string | null {
    if (_cachedConfigModel !== null) return _cachedConfigModel
    try {
        const configPath = resolveConfigPath()
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            _cachedConfigModel = config.llm?.model || config.model || null
            _cachedSubAgentModel = config.llm?.subAgentModel || config.subAgentModel || null
        }
    } catch { /* ok */ }
    return _cachedConfigModel
}

/**
 * Get the default model for main conversations.
 * Resolution: NOVA_MODEL env → config.llm.model → fallback
 */
export const getDefaultModel = (): string => {
    // Priority 1: ENV override
    if (process.env.NOVA_MODEL) return process.env.NOVA_MODEL
    // Priority 2: ACTUAL active model from runtime (set by llm-factory after model probe)
    try {
        const novaState = (globalThis as any).__novaState
        if (novaState?.activeModel) return novaState.activeModel
    } catch { /* ignore */ }
    // Priority 3: Config file
    return readConfigModel() || ULTIMATE_FALLBACK
}

/**
 * Get the model for sub-agents / internal tasks.
 * Resolution: NOVA_SUB_MODEL env → config.llm.subAgentModel → getDefaultModel()
 */
export const getSubAgentModel = (): string => {
    readConfigModel() // ensure cache is populated
    return process.env.NOVA_SUB_MODEL || _cachedSubAgentModel || getDefaultModel()
}

/**
 * Get a model for simple/cheap tasks (cost optimization).
 * Resolution: NOVA_SIMPLE_MODEL env → getDefaultModel()
 */
export const getSimpleModel = (): string => {
    return process.env.NOVA_SIMPLE_MODEL || getDefaultModel()
}

/**
 * Get a model for complex/reasoning tasks.
 * Resolution: NOVA_COMPLEX_MODEL env → config → getDefaultModel()
 */
export const getComplexModel = (): string => {
    readConfigModel()
    return process.env.NOVA_COMPLEX_MODEL || getDefaultModel()
}

/**
 * Reset cache (e.g. after config reload)
 */
export const resetModelCache = (): void => {
    _cachedConfigModel = null
    _cachedSubAgentModel = null
}

// ============================================
// Known Models (OpenAI / Anthropic / Local)
// ============================================

/**
 * Known models — OpenAI, Anthropic, and local (Ollama/LM Studio)
 */
export const KNOWN_MODELS = [
    'auto',
    'auto',
    'auto',
    'auto',
    'o3-mini',
    'o3',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-thinking',
    'claude-opus-4-5-thinking',
    'auto',  // local auto-detect
] as const

/** Default pro model */
export const DEFAULT_PRO_MODEL = 'auto'

/** High-tier pro model */
export const DEFAULT_PRO_HIGH_MODEL = 'auto'

// ============================================
// Context Windows
// ============================================

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-4': 8192,
    'o3-mini': 128000,
    'o3': 200000,
    'claude-sonnet-4-5': 200000,
    'claude-sonnet-4-5-thinking': 200000,
    'claude-opus-4-5-thinking': 200000,
}

export const getContextWindow = (modelId: string): number => {
    return MODEL_CONTEXT_WINDOWS[modelId] ?? 128000
}

