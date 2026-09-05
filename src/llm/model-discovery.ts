/**
 * Nova - Dynamic Model Discovery
 * 
 * 3-Tier Fallback:
 *   1. Cloud API (OpenAI fetchAvailableModels)
 *   2. Local (Ollama / LMStudio / vLLM)
 *   3. Network (SSH to mesh hosts, scan for Ollama)
 * 
 * Results cached in .nova-data/discovered-models.json (30min TTL)
 * NO hardcoded model lists — everything is discovered at runtime.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

// ============================================
// Types
// ============================================

export interface DiscoveredModel {
    id: string
    name?: string
    provider: string
    source: 'cloud-api' | 'local' | 'mesh' | 'seed'
    sourceHost?: string     // e.g. 'Pi5' for mesh models
    available: boolean
    rateLimited?: boolean
    contextWindow?: number
    capabilities?: string[]
    lastSeen: string        // ISO timestamp
}

export interface DiscoveryCache {
    lastDiscovery: string
    models: DiscoveredModel[]
}

// ============================================
// Constants
// ============================================

const CACHE_TTL_MS = 30 * 60 * 1000  // 30 minutes
const CACHE_FILE = '.nova-data/discovered-models.json'
const HOSTS_FILE = '.nova-data/hosts.json'

// In-memory cache (faster than disk reads)
let memoryCache: DiscoveryCache | null = null
let memoryCacheTime = 0

// ============================================
// Cache Management
// ============================================

function getCachePath(): string {
    return join(process.cwd(), CACHE_FILE)
}

function loadCache(includeStale = false): DiscoveryCache | null {
    // Memory cache first
    if (memoryCache && Date.now() - memoryCacheTime < CACHE_TTL_MS) {
        return memoryCache
    }

    // Disk cache
    try {
        const path = getCachePath()
        if (existsSync(path)) {
            const data = JSON.parse(readFileSync(path, 'utf-8')) as DiscoveryCache
            const age = Date.now() - new Date(data.lastDiscovery).getTime()
            if (includeStale || age < CACHE_TTL_MS) {
                memoryCache = data
                memoryCacheTime = Date.now()
                return data
            }
        }
    } catch { /* cache corrupt or missing */ }
    return null
}

let discoveryInFlight: Promise<DiscoveredModel[]> | null = null

function saveCache(cache: DiscoveryCache): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        atomicWriteJsonSync(getCachePath(), cache)
        memoryCache = cache
        memoryCacheTime = Date.now()
    } catch (err) {
        console.log(`[ModelDiscovery] ⚠️ Cache write failed: ${err}`)
    }
}

// ============================================
// Tier 1: Cloud API Discovery
// ============================================

async function discoverCloudModels(): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = []

    try {
        // Load API keys from config
        const configPath = join(process.cwd(), 'nova.config.json')
        if (!existsSync(configPath)) {
            console.log('[ModelDiscovery] ☁️ No config — skipping cloud discovery')
            return models
        }

        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        const providers = config.providers || {}

        // OpenAI discovery
        const openaiKey = providers.openai?.apiKey
        if (openaiKey && providers.openai?.enabled !== false) {
            try {
                const resp = await fetch('https://api.openai.com/v1/models', {
                    headers: { 'Authorization': `Bearer ${openaiKey}` },
                    signal: AbortSignal.timeout(5000),
                })
                if (resp.ok) {
                    const data = await resp.json() as { data?: Array<{ id: string }> }
                    const gptModels = (data.data || [])
                        .filter(m => m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3') || m.id.startsWith('o4'))
                        .slice(0, 10)
                    for (const m of gptModels) {
                        models.push({
                            id: m.id,
                            provider: 'openai',
                            source: 'cloud-api',
                            available: true,
                            lastSeen: new Date().toISOString(),
                            capabilities: inferCapabilities(m.id),
                            contextWindow: inferContextWindow(m.id),
                        })
                    }
                }
            } catch { /* OpenAI unreachable */ }
        }

        // Anthropic discovery
        const anthropicKey = providers.anthropic?.apiKey
        if (anthropicKey && providers.anthropic?.enabled !== false) {
            try {
                const resp = await fetch('https://api.anthropic.com/v1/models', {
                    headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
                    signal: AbortSignal.timeout(5000),
                })
                if (resp.ok) {
                    const data = await resp.json() as { data?: Array<{ id: string }> }
                    const claudeModels = (data.data || [])
                        .filter((m: { id: string }) => m.id.startsWith('claude-'))
                        .slice(0, 10)
                    for (const m of claudeModels) {
                        models.push({
                            id: m.id,
                            provider: 'anthropic',
                            source: 'cloud-api',
                            available: true,
                            lastSeen: new Date().toISOString(),
                            capabilities: inferCapabilities(m.id),
                            contextWindow: inferContextWindow(m.id),
                        })
                    }
                }
            } catch { /* Anthropic unreachable */ }
        }

        console.log(`[ModelDiscovery] ☁️ Cloud: ${models.length} models discovered`)
    } catch (err) {
        console.log(`[ModelDiscovery] ☁️ Cloud discovery failed: ${err}`)
    }

    return models
}

// ============================================
// Tier 2: Local Discovery
// ============================================

async function discoverLocalModels(): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = []

    try {
        const { detectLocalLLMs } = await import('./local-llm.js')
        const localServers = await detectLocalLLMs()

        for (const server of localServers) {
            for (const modelId of server.models) {
                models.push({
                    id: modelId,
                    name: modelId,
                    provider: 'ollama',
                    source: 'local',
                    available: true,
                    lastSeen: new Date().toISOString(),
                    capabilities: ['chat'],
                })
            }
        }

        if (models.length > 0) {
            console.log(`[ModelDiscovery] 🖥️ Local: ${models.length} models found`)
        } else {
            console.log('[ModelDiscovery] 🖥️ Local: No local LLM servers running')
        }
    } catch (err) {
        console.log(`[ModelDiscovery] 🖥️ Local discovery failed: ${err}`)
    }

    return models
}

// ============================================
// Tier 3: Network Mesh Discovery
// ============================================

async function discoverMeshModels(): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = []

    // === PRIMARY: Supabase-based discovery (no SSH needed) ===
    try {
        const configPath = join(process.cwd(), 'nova.config.json')
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            const supabaseUrl = config.supabase?.meshUrl || process.env.NOVA_MESH_SUPABASE_URL
            const supabaseKey = config.supabase?.meshKey || process.env.NOVA_MESH_SUPABASE_KEY

            if (supabaseUrl && supabaseKey) {
                const resp = await fetch(`${supabaseUrl}/nova_mesh_nodes?select=hostname,ip,software,hardware,status,capabilities&status=eq.online`, {
                    headers: {
                        'apikey': supabaseKey,
                        'Authorization': `Bearer ${supabaseKey}`,
                    },
                    signal: AbortSignal.timeout(10000),
                })

                if (resp.ok) {
                    const nodes = await resp.json() as Array<{
                        hostname: string
                        ip: string
                        software?: { ollama?: string; pip_packages?: string[]; llama_cpp?: boolean }
                        hardware?: { gpu?: string; ram_gb?: number; platform?: string }
                        capabilities?: { ollama_models?: string[] }
                    }>

                    for (const node of nodes) {
                        const hostName = node.hostname || node.ip

                        // Ollama models from capabilities
                        if (node.capabilities?.ollama_models) {
                            for (const modelName of node.capabilities.ollama_models) {
                                models.push({
                                    id: modelName,
                                    name: `${modelName} (${hostName})`,
                                    provider: 'ollama',
                                    source: 'mesh',
                                    sourceHost: hostName,
                                    available: true,
                                    lastSeen: new Date().toISOString(),
                                    capabilities: inferCapabilities(modelName),
                                    contextWindow: inferContextWindow(modelName),
                                })
                            }
                        }

                        // Llama-cpp detection
                        if (node.software?.llama_cpp) {
                            models.push({
                                id: `llama-cpp@${hostName}`,
                                name: `llama.cpp (${hostName})`,
                                provider: 'llama-cpp',
                                source: 'mesh',
                                sourceHost: hostName,
                                available: true,
                                lastSeen: new Date().toISOString(),
                                capabilities: ['chat'],
                            })
                        }

                        // AI pip packages → potential model servers
                        const aiPackages = node.software?.pip_packages?.filter(p =>
                            ['torch', 'transformers', 'vllm', 'text-generation-webui', 'faster-whisper'].includes(p)
                        ) || []
                        if (aiPackages.length > 0 && !node.software?.ollama) {
                            models.push({
                                id: `ai-runtime@${hostName}`,
                                name: `AI Runtime (${hostName}: ${aiPackages.slice(0, 3).join(', ')})`,
                                provider: 'custom',
                                source: 'mesh',
                                sourceHost: hostName,
                                available: true,
                                lastSeen: new Date().toISOString(),
                                capabilities: aiPackages.includes('faster-whisper') ? ['stt'] : ['chat'],
                            })
                        }
                    }

                    if (models.length > 0) {
                        console.log(`[ModelDiscovery] 🌐 Supabase: ${models.length} mesh models from ${nodes.length} nodes`)
                    }
                    return models  // Supabase success — skip SSH
                }
            }
        }
    } catch (err) {
        console.log(`[ModelDiscovery] 🌐 Supabase mesh discovery failed: ${err}`)
    }

    // === FALLBACK: SSH-based discovery ===
    try {
        const hostsPath = join(process.cwd(), HOSTS_FILE)
        if (!existsSync(hostsPath)) return models

        const hosts = JSON.parse(readFileSync(hostsPath, 'utf-8')) as Array<{
            host: string; hostname?: string; user?: string; name?: string
        }>
        if (!Array.isArray(hosts) || hosts.length === 0) return models

        const { exec } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execAsync = promisify(exec)

        for (const host of hosts) {
            const hostName = host.hostname || host.name || host.host
            const user = host.user || 'xaventra'
            const ip = host.host
            if (ip === '127.0.0.1' || ip === 'localhost') continue

            try {
                const { stdout } = await execAsync(
                    `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${user}@${ip} "curl -s http://localhost:11434/api/tags 2>/dev/null || echo '{}'"`,
                    { timeout: 15000 }
                )
                const data = JSON.parse(stdout.trim()) as { models?: Array<{ name: string }> }
                if (data.models && data.models.length > 0) {
                    for (const m of data.models) {
                        models.push({
                            id: m.name,
                            name: m.name,
                            provider: 'ollama',
                            source: 'mesh',
                            sourceHost: hostName,
                            available: true,
                            lastSeen: new Date().toISOString(),
                            capabilities: ['chat'],
                        })
                    }
                }
            } catch {
                console.log(`[ModelDiscovery] 🌐 Mesh/${hostName}: unreachable`)
            }
        }
    } catch (err) {
        console.log(`[ModelDiscovery] 🌐 SSH mesh discovery failed: ${err}`)
    }

    return models
}

// ============================================
// Main Discovery Function
// ============================================

/**
 * Discover ALL available models across all tiers.
 * Uses cache if fresh enough, otherwise performs full scan.
 */
async function runDiscovery(forceRefresh = false): Promise<DiscoveredModel[]> {
    // Check cache first
    if (!forceRefresh) {
        const cached = loadCache()
        if (cached) {
            console.log(`[ModelDiscovery] 📦 Using cached models (${cached.models.length} models, age: ${Math.round((Date.now() - new Date(cached.lastDiscovery).getTime()) / 60000)}min)`)
            return cached.models
        }
    }

    console.log('[ModelDiscovery] 🔄 Starting full model scan...')
    const allModels: DiscoveredModel[] = []
    const seen = new Set<string>()

    // Tier 1: Cloud API — highest priority
    const cloudPromise = discoverCloudModels()
    const localPromise = discoverLocalModels()
    const meshPromise = discoverMeshModels()
    const cloudModels = await cloudPromise
    for (const m of cloudModels) {
        const key = `${m.provider}:${m.id}`
        if (!seen.has(key)) {
            seen.add(key)
            allModels.push(m)
        }
    }

    // Tier 2: Local models
    const localModels = await localPromise
    for (const m of localModels) {
        const key = `${m.provider}:${m.id}`
        if (!seen.has(key)) {
            seen.add(key)
            allModels.push(m)
        }
    }

    // Tier 3: Network mesh (async, non-blocking for startup)
    try {
        const meshModels = await meshPromise
        for (const m of meshModels) {
            const key = `${m.provider}:${m.id}:${m.sourceHost}`
            if (!seen.has(key)) {
                seen.add(key)
                allModels.push(m)
            }
        }
    } catch (err) {
        console.log(`[ModelDiscovery] 🌐 Mesh scan deferred: ${err}`)
    }

    // Save to cache
    const cache: DiscoveryCache = {
        lastDiscovery: new Date().toISOString(),
        models: allModels,
    }
    saveCache(cache)

    console.log(`[ModelDiscovery] ✅ Discovery complete: ${allModels.length} models total`)
    return allModels
}

export async function discoverAllModels(forceRefresh = false): Promise<DiscoveredModel[]> {
    if (!forceRefresh) {
        const fresh = loadCache()
        if (fresh) return fresh.models
        const stale = loadCache(true)
        if (stale?.models.length) {
            if (!discoveryInFlight) discoveryInFlight = runDiscovery(true).finally(() => { discoveryInFlight = null })
            console.log(`[ModelDiscovery] Using stale cache immediately (${stale.models.length} models); refreshing in background`)
            return stale.models
        }
    }
    if (discoveryInFlight) return discoveryInFlight
    discoveryInFlight = runDiscovery(forceRefresh).finally(() => { discoveryInFlight = null })
    return discoveryInFlight
}

// ============================================
// Accessors — used by other modules
// ============================================

/**
 * Get discovered models (from cache, no scan).
 * Falls back to empty array if no discovery has run yet.
 */
export function getDiscoveredModels(): DiscoveredModel[] {
    const cached = loadCache(true)
    return cached?.models ?? []
}

/**
 * Get available models only (filtered for available=true)
 */
export function getAvailableModels(): DiscoveredModel[] {
    return getDiscoveredModels().filter(m => m.available)
}

/**
 * Get the best model for a given need, using discovery results.
 * Priority: cloud > local > mesh
 */
export function getBestModel(capability?: string): DiscoveredModel | null {
    const models = getAvailableModels()
    if (models.length === 0) return null

    // Filter by capability if requested
    const filtered = capability
        ? models.filter(m => m.capabilities?.includes(capability))
        : models

    if (filtered.length === 0) return models[0] // fallback to any available

    // Priority: local > mesh > cloud-api > seed (local models preferred)
    const sourceOrder = ['local', 'mesh', 'cloud-api', 'seed']
    filtered.sort((a, b) => {
        const ai = sourceOrder.indexOf(a.source)
        const bi = sourceOrder.indexOf(b.source)
        return ai - bi
    })

    // Within same source: prefer vLLM/large models over small local models
    const modelPriority = (m: DiscoveredModel): number => {
        const id = m.id.toLowerCase()
        if (id.includes('122b') || id.includes('70b') || id.includes('34b')) return 0 // vLLM / large local
        if (id.includes('qwen3.5') && !id.includes('27b')) return 1 // qwen3.5 small
        if (id.includes('qwen3.5:27b')) return 2 // qwen3.5:27b (smaller)
        if (id.includes('qwen3.6:27b')) return 3 // qwen3.6:27b (different)
        if (id.includes('llama3') || id.includes('gemma3')) return 4 // smaller local models
        if (id.includes('minicpm') || id.includes('phi') || id.includes('mistral')) return 5 // smallest
        return 6 // unknown
    }
    filtered.sort((a, b) => {
        const ai = modelPriority(a)
        const bi = modelPriority(b)
        return ai - bi
    })

    return filtered[0]
}

/**
 * Build dynamic fallback chain from discovery results.
 * Priority: local vLLM → local Ollama → cloud API → seed
 * Local models come first — cloud is the fallback, not the default.
 */
export function buildFallbackChain(): Array<{ provider: string; model: string }> {
    const models = getAvailableModels()

    // Custom priority: local first (vLLM > ollama), then cloud, then seed
    const sourcePriority = (m: DiscoveredModel): number => {
        if (m.source === 'local') {
            // vLLM/large models rank higher within local
            const isLarge = /122b|70b|34b|32b|27b|26b|35b/i.test(m.id)
            return isLarge ? 0 : 1
        }
        if (m.source === 'mesh') return 2
        if (m.source === 'cloud-api') return 3
        return 4 // seed
    }

    return models
        .filter(m => {
            // Exclude embedding models from fallback chain
            return !/embed|nomic|bge|mxbai|e5-|gte-|instructor|minilm/i.test(m.id)
        })
        .sort((a, b) => sourcePriority(a) - sourcePriority(b))
        .map(m => ({ provider: m.provider, model: m.id }))
}

/**
 * Get the default model — first available cloud model, or first local.
 */
export function getDefaultModel(): string {
    const best = getBestModel()
    if (best?.id) return best.id
    // Ultimate safety net — use the central fallback
    try {
        const { getDefaultModel: centralDefault } = require('../core/model-defaults.js')
        return centralDefault()
    } catch {
        return 'auto' // absolute last resort if nothing is loaded
    }
}

/**
 * Invalidate cache — forces next call to re-discover.
 */
export function invalidateCache(): void {
    memoryCache = null
    memoryCacheTime = 0
    try {
        const { unlinkSync } = require('node:fs')
        const path = getCachePath()
        if (existsSync(path)) unlinkSync(path)
    } catch { /* ok */ }
}

// ============================================
// Helpers
// ============================================

function inferCapabilities(modelId: string): string[] {
    const caps = ['chat']
    const lower = modelId.toLowerCase()

    if (lower.includes('pro') || lower.includes('flash') || lower.includes('gpt')) {
        caps.push('vision', 'tools')
    }
    if (lower.includes('thinking') || lower.includes('pro')) {
        caps.push('reasoning')
    }
    if (lower.includes('coder') || lower.includes('code')) {
        caps.push('code')
    }
    return caps
}

function inferContextWindow(modelId: string): number {
    const lower = modelId.toLowerCase()
    if (lower.includes('gpt-5') || lower.includes('gpt-4')) return 1048576
    if (lower.includes('gpt')) return 1000000 
    if (lower.includes('claude')) return 200000
    if (lower.includes('gpt')) return 128000
    return 128000 // reasonable default
}

export default {
    discoverAllModels,
    getDiscoveredModels,
    getAvailableModels,
    getBestModel,
    buildFallbackChain,
    getDefaultModel,
    invalidateCache,
}
