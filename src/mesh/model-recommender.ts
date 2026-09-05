/**
 * Nova Model Recommender
 *
 * Recommends current, hardware-appropriate AI models for each node.
 * Detects stale/deprecated models and suggests fresh replacements.
 *
 * Catalog last updated: 2026-05-20
 * Hardware tiers based on available RAM + VRAM
 */

// ============================================
// Types
// ============================================

export interface ModelRecommendation {
    model: string          // ollama pull name
    family: string         // qwen3, llama4, gemma3, etc.
    params: string         // "7B", "14B", etc.
    type: 'chat' | 'code' | 'vision' | 'reasoning' | 'embedding'
    tier: 'nano' | 'small' | 'medium' | 'large' | 'xlarge'
    minRamGb: number       // minimum RAM to run comfortably
    minVramGb?: number     // minimum VRAM for GPU inference
    contextWindow: number  // max context tokens
    description: string
    pullCmd: string        // e.g. "ollama pull qwen3:7b"
    releasedAt: string     // ISO date
    tags: string[]         // 'recommended', 'vision', 'reasoning', etc.
}

export interface HardwareProfile {
    ramGb: number
    vramGb?: number
    cpuCores?: number
    hasGpu: boolean
    gpuType?: 'cuda' | 'metal' | 'rocm' | 'integrated'
    arch?: string
    isJetson?: boolean
    isRaspberryPi?: boolean
}

export interface RecommendationResult {
    node: string
    hardware: HardwareProfile
    tier: 'nano' | 'small' | 'medium' | 'large' | 'xlarge'
    recommended: ModelRecommendation[]
    alreadyInstalled: string[]
    toInstall: string[]
    deprecated: string[]
    listAge: string
    pullCommands: string[]
}

// ============================================
// Deprecated / Outdated Models
// ============================================

export const DEPRECATED_MODELS = [
    // Llama 1+2 (Llama 4 is current)
    'llama2', 'llama2:7b', 'llama2:13b', 'llama2:70b',
    'llama3', 'llama3:8b', 'llama3:70b',
    'llama3.1:8b', 'llama3.1:70b', 'llama3.2:1b', 'llama3.2:3b',
    'codellama', 'codellama:7b', 'codellama:13b', 'codellama:34b',
    // Qwen 1+2 (Qwen3 is current)
    'qwen', 'qwen:7b', 'qwen:14b', 'qwen:72b',
    'qwen2', 'qwen2:7b', 'qwen2:14b', 'qwen2:72b',
    'qwen2.5:0.5b', 'qwen2.5:1.5b', 'qwen2.5:3b',
    // Old Mistral (Mistral-Small 3 is current)
    'mistral:v0.1', 'mistral:v0.2', 'mistral:v0.3',
    'mistral:7b',   // plain 7b is old
    'mixtral:8x7b',
    // Phi 1+2+3 (Phi-4 is current)
    'phi', 'phi:2', 'phi:2.7b', 'phi3', 'phi3:3.8b', 'phi3:mini',
    // Gemma 1+2 (Gemma 3 is current)
    'gemma', 'gemma:2b', 'gemma:7b',
    'gemma2', 'gemma2:2b', 'gemma2:9b', 'gemma2:27b',
    // Misc old
    'vicuna', 'alpaca', 'orca-mini', 'neural-chat',
    'openhermes', 'openhermes:2.5-mistral-7b',
    'deepseek-coder:6.7b', 'deepseek-coder:33b',
    'stablelm', 'starling-lm',
]

// ============================================
// Model Catalog (2026-05-20)
// ============================================

// Catalog date — used to warn when the list is getting stale
export const CATALOG_DATE = '2026-05-20'

const CATALOG: ModelRecommendation[] = [
    // ===== NANO (≤4GB RAM — RPi, Jetson Nano, weak VPS) =====
    {
        model: 'gemma3:1b',
        family: 'gemma3', params: '1B', type: 'chat', tier: 'nano',
        minRamGb: 2, contextWindow: 32768,
        description: 'Google Gemma 3 1B — ultra-kompakt, ideal für Raspberry Pi & Nano-Boards',
        pullCmd: 'ollama pull gemma3:1b',
        releasedAt: '2025-03-12',
        tags: ['compact', 'fast', 'raspberry-pi', 'jetson-nano'],
    },
    {
        model: 'qwen3:1.7b',
        family: 'qwen3', params: '1.7B', type: 'chat', tier: 'nano',
        minRamGb: 2, contextWindow: 32768,
        description: 'Qwen3 1.7B — Alibaba, sehr effizient, multilingual, Hybrid-Reasoning',
        pullCmd: 'ollama pull qwen3:1.7b',
        releasedAt: '2025-04-28',
        tags: ['compact', 'multilingual', 'fast', 'recommended'],
    },
    {
        model: 'phi4-mini:3.8b',
        family: 'phi4-mini', params: '3.8B', type: 'reasoning', tier: 'nano',
        minRamGb: 3, contextWindow: 16384,
        description: 'Microsoft Phi-4 Mini — starkes Reasoning für kleine Hardware',
        pullCmd: 'ollama pull phi4-mini:3.8b',
        releasedAt: '2025-02-15',
        tags: ['reasoning', 'microsoft', 'compact'],
    },
    {
        model: 'moondream:1.8b',
        family: 'moondream', params: '1.8B', type: 'vision', tier: 'nano',
        minRamGb: 2, contextWindow: 4096,
        description: 'Moondream 1.8B — Vision-Modell für Edge-Devices (Bildanalyse, OCR)',
        pullCmd: 'ollama pull moondream:1.8b',
        releasedAt: '2025-01-20',
        tags: ['vision', 'image-analysis', 'compact'],
    },

    // ===== SMALL (4-8GB RAM/VRAM) =====
    {
        model: 'qwen3:7b',
        family: 'qwen3', params: '7B', type: 'chat', tier: 'small',
        minRamGb: 5, contextWindow: 32768,
        description: 'Qwen3 7B — Top-Performer der 7B-Klasse, multilingual, Hybrid-Reasoning',
        pullCmd: 'ollama pull qwen3:7b',
        releasedAt: '2025-04-28',
        tags: ['multilingual', 'reasoning', 'recommended'],
    },
    {
        model: 'llama4:scout',
        family: 'llama4', params: '17B-MoE', type: 'chat', tier: 'small',
        minRamGb: 5, contextWindow: 1048576,
        description: 'Llama 4 Scout — Meta MoE, extremer 1M-Token-Context, sehr effizient',
        pullCmd: 'ollama pull llama4:scout',
        releasedAt: '2025-04-05',
        tags: ['meta', 'moe', 'long-context', 'recommended'],
    },
    {
        model: 'gemma3:4b',
        family: 'gemma3', params: '4B', type: 'chat', tier: 'small',
        minRamGb: 4, contextWindow: 32768,
        description: 'Google Gemma 3 4B — ausgeglichen, gut für allgemeine Aufgaben & Vision',
        pullCmd: 'ollama pull gemma3:4b',
        releasedAt: '2025-03-12',
        tags: ['google', 'balanced', 'vision'],
    },
    {
        model: 'deepseek-r1:7b',
        family: 'deepseek-r1', params: '7B', type: 'reasoning', tier: 'small',
        minRamGb: 5, contextWindow: 65536,
        description: 'DeepSeek R1 7B — Chain-of-Thought Reasoning, Mathematik & Code',
        pullCmd: 'ollama pull deepseek-r1:7b',
        releasedAt: '2025-01-20',
        tags: ['reasoning', 'cot', 'math', 'code'],
    },
    {
        model: 'nomic-embed-text:v1.5',
        family: 'nomic-embed', params: '137M', type: 'embedding', tier: 'small',
        minRamGb: 1, contextWindow: 8192,
        description: 'Nomic Embed v1.5 — bestes Open-Source Embedding-Modell für RAG/Suche',
        pullCmd: 'ollama pull nomic-embed-text:v1.5',
        releasedAt: '2024-06-01',
        tags: ['embedding', 'rag', 'vector-search', 'required'],
    },

    // ===== MEDIUM (8-16GB RAM/VRAM) =====
    {
        model: 'qwen3:14b',
        family: 'qwen3', params: '14B', type: 'chat', tier: 'medium',
        minRamGb: 9, contextWindow: 32768,
        description: 'Qwen3 14B — exzellente Qualität, sehr effizient, multilingual',
        pullCmd: 'ollama pull qwen3:14b',
        releasedAt: '2025-04-28',
        tags: ['multilingual', 'reasoning', 'recommended'],
    },
    {
        model: 'deepseek-r1:14b',
        family: 'deepseek-r1', params: '14B', type: 'reasoning', tier: 'medium',
        minRamGb: 10, contextWindow: 65536,
        description: 'DeepSeek R1 14B — bestes Reasoning-Modell für mittlere Hardware',
        pullCmd: 'ollama pull deepseek-r1:14b',
        releasedAt: '2025-01-20',
        tags: ['reasoning', 'math', 'code', 'recommended'],
    },
    {
        model: 'llama4:maverick',
        family: 'llama4', params: '400B-MoE-A17B', type: 'chat', tier: 'medium',
        minRamGb: 8, contextWindow: 1048576,
        description: 'Llama 4 Maverick — Meta MoE, sehr langer Context, besser als viele 70B',
        pullCmd: 'ollama pull llama4:maverick',
        releasedAt: '2025-04-05',
        tags: ['meta', 'moe', 'long-context'],
    },
    {
        model: 'gemma3:12b',
        family: 'gemma3', params: '12B', type: 'chat', tier: 'medium',
        minRamGb: 8, contextWindow: 32768,
        description: 'Google Gemma 3 12B — Vision + Text, sehr starke Leistung',
        pullCmd: 'ollama pull gemma3:12b',
        releasedAt: '2025-03-12',
        tags: ['google', 'vision', 'balanced'],
    },
    {
        model: 'mxbai-embed-large:v1',
        family: 'mxbai-embed', params: '335M', type: 'embedding', tier: 'medium',
        minRamGb: 1, contextWindow: 512,
        description: 'MixedBread Embed Large — beste Qualität für Embeddings & semantische Suche',
        pullCmd: 'ollama pull mxbai-embed-large:v1',
        releasedAt: '2024-03-01',
        tags: ['embedding', 'rag', 'high-quality'],
    },

    // ===== LARGE (16-32GB RAM/VRAM) =====
    {
        model: 'qwen3:30b-a3b',
        family: 'qwen3', params: '30B-MoE-A3B', type: 'chat', tier: 'large',
        minRamGb: 14, contextWindow: 32768,
        description: 'Qwen3 30B-A3B — MoE mit nur 3B aktiven Params, läuft wie ein 7B!',
        pullCmd: 'ollama pull qwen3:30b-a3b',
        releasedAt: '2025-04-28',
        tags: ['moe', 'efficient', 'recommended'],
    },
    {
        model: 'qwen3:32b',
        family: 'qwen3', params: '32B', type: 'chat', tier: 'large',
        minRamGb: 20, contextWindow: 32768,
        description: 'Qwen3 32B — Dense-Modell, top Qualität für 20GB+ Hardware',
        pullCmd: 'ollama pull qwen3:32b',
        releasedAt: '2025-04-28',
        tags: ['dense', 'high-quality', 'multilingual'],
    },
    {
        model: 'deepseek-r1:32b',
        family: 'deepseek-r1', params: '32B', type: 'reasoning', tier: 'large',
        minRamGb: 20, contextWindow: 65536,
        description: 'DeepSeek R1 32B — bestes Reasoning unter 70B, GPT-4o-Niveau',
        pullCmd: 'ollama pull deepseek-r1:32b',
        releasedAt: '2025-01-20',
        tags: ['reasoning', 'math', 'code'],
    },
    {
        model: 'gemma3:27b',
        family: 'gemma3', params: '27B', type: 'chat', tier: 'large',
        minRamGb: 18, contextWindow: 131072,
        description: 'Google Gemma 3 27B — Vision + langer Context (128K)',
        pullCmd: 'ollama pull gemma3:27b',
        releasedAt: '2025-03-12',
        tags: ['google', 'vision', 'long-context'],
    },

    // ===== XLARGE (32GB+ VRAM — High-End Server/Workstation) =====
    {
        model: 'qwen3:72b',
        family: 'qwen3', params: '72B', type: 'chat', tier: 'xlarge',
        minRamGb: 45, minVramGb: 40, contextWindow: 32768,
        description: 'Qwen3 72B — state-of-the-art open-weights, mehrsprachig & Reasoning',
        pullCmd: 'ollama pull qwen3:72b',
        releasedAt: '2025-04-28',
        tags: ['flagship', 'multilingual', 'reasoning'],
    },
    {
        model: 'deepseek-r1:70b',
        family: 'deepseek-r1', params: '70B', type: 'reasoning', tier: 'xlarge',
        minRamGb: 45, minVramGb: 40, contextWindow: 65536,
        description: 'DeepSeek R1 70B — GPT-4-Niveau Reasoning, open-weights Flaggschiff',
        pullCmd: 'ollama pull deepseek-r1:70b',
        releasedAt: '2025-01-20',
        tags: ['reasoning', 'flagship', 'gpt4-level'],
    },
]

// ============================================
// Tier Detection
// ============================================

export function detectHardwareTier(hw: HardwareProfile): 'nano' | 'small' | 'medium' | 'large' | 'xlarge' {
    const vram = hw.vramGb || 0
    const ram = hw.ramGb

    // Special edge-device detection
    if (hw.isJetson || hw.isRaspberryPi || ram <= 4) return 'nano'

    // GPU-accelerated tiering — VRAM is the bottleneck
    if (hw.hasGpu && vram >= 4) {
        if (vram < 6) return 'nano'
        if (vram < 10) return 'small'
        if (vram < 18) return 'medium'
        if (vram < 36) return 'large'
        return 'xlarge'
    }

    // CPU/RAM tiering (CPU inference)
    if (ram <= 6) return 'nano'
    if (ram <= 12) return 'small'
    if (ram <= 24) return 'medium'
    if (ram <= 48) return 'large'
    return 'xlarge'
}

// ============================================
// Core Recommendation Engine
// ============================================

export function getRecommendations(
    nodeName: string,
    hw: HardwareProfile,
    installedModels: string[] = []
): RecommendationResult {
    const tier = detectHardwareTier(hw)
    const tierOrder: Array<'nano' | 'small' | 'medium' | 'large' | 'xlarge'> = ['nano', 'small', 'medium', 'large', 'xlarge']
    const tierIdx = tierOrder.indexOf(tier)

    // Include current tier + one tier below for flexibility
    const recommended = CATALOG.filter(m => {
        const mTierIdx = tierOrder.indexOf(m.tier)
        if (mTierIdx > tierIdx) return false           // too large for this hardware
        if (m.type === 'embedding') return true        // embeddings are always small
        return mTierIdx >= Math.max(0, tierIdx - 1)   // current tier + one below
    }).sort((a, b) => {
        const aTierIdx = tierOrder.indexOf(a.tier)
        const bTierIdx = tierOrder.indexOf(b.tier)
        if (aTierIdx !== bTierIdx) return bTierIdx - aTierIdx  // current tier first
        // Within same tier: 'recommended' tag first
        return (b.tags.includes('recommended') ? 1 : 0) - (a.tags.includes('recommended') ? 1 : 0)
    }).slice(0, 8)

    // Find deprecated installed models
    const deprecated = installedModels.filter(installed =>
        DEPRECATED_MODELS.some(dep =>
            installed === dep ||
            installed.startsWith(dep + ':') ||
            dep.startsWith(installed + ':')
        )
    )

    // Find what's recommended but not installed
    const alreadyInstalled = installedModels.filter(installed =>
        recommended.some(r =>
            installed === r.model ||
            installed.startsWith(r.family + ':')
        )
    )

    const toInstall = recommended
        .filter(r => !installedModels.some(installed =>
            installed === r.model ||
            installed.startsWith(r.family + ':')
        ))
        .filter(r => r.type !== 'embedding' || r.tags.includes('required'))
        .map(r => r.model)

    // How stale is our catalog?
    const daysSinceCatalog = Math.round(
        (Date.now() - new Date(CATALOG_DATE).getTime()) / (1000 * 60 * 60 * 24)
    )
    const listAge = daysSinceCatalog <= 30
        ? 'aktuell'
        : daysSinceCatalog <= 90
            ? `${daysSinceCatalog} Tage alt`
            : `⚠️ ${daysSinceCatalog} Tage alt — prüfe ollama.com für neue Modelle`

    const pullCommands = toInstall.map(modelName => {
        const rec = recommended.find(r => r.model === modelName)
        return rec?.pullCmd ?? `ollama pull ${modelName}`
    })

    return {
        node: nodeName,
        hardware: hw,
        tier,
        recommended,
        alreadyInstalled,
        toInstall,
        deprecated,
        listAge,
        pullCommands,
    }
}

// ============================================
// Formatters
// ============================================

export function formatRecommendations(result: RecommendationResult): string {
    const tierEmoji: Record<string, string> = {
        nano: '🔵', small: '🟢', medium: '🟡', large: '🟠', xlarge: '🔴',
    }
    const tierName: Record<string, string> = {
        nano: 'Nano (≤4GB)',
        small: 'Small (4-8GB)',
        medium: 'Medium (8-16GB)',
        large: 'Large (16-32GB)',
        xlarge: 'XLarge (32GB+)',
    }

    const hw = result.hardware
    let msg = `🤖 **Modell-Empfehlungen: ${result.node}**\n\n`
    msg += `${tierEmoji[result.tier]} Tier: **${tierName[result.tier]}**\n`
    msg += `💻 Hardware: ${hw.ramGb}GB RAM`
    if (hw.vramGb) msg += ` + ${hw.vramGb}GB VRAM`
    if (hw.hasGpu && hw.gpuType) msg += ` (${hw.gpuType.toUpperCase()})`
    msg += `\n📅 Katalog: ${result.listAge}\n\n`

    if (result.recommended.length > 0) {
        msg += `**📦 Empfohlene Modelle:**\n`
        for (const m of result.recommended) {
            const installed = result.alreadyInstalled.some(i =>
                i === m.model || i.startsWith(m.family + ':')
            )
            const icon = installed ? '✅' : '⬇️'
            const typeTag = m.type !== 'chat' ? ` [${m.type}]` : ''
            msg += `${icon} \`${m.model}\`${typeTag} — ${m.description}\n`
        }
        msg += '\n'
    }

    if (result.toInstall.length > 0) {
        msg += `**⬇️ Noch zu installieren:**\n`
        msg += `\`\`\`bash\n${result.pullCommands.join('\n')}\n\`\`\`\n\n`
    } else {
        msg += `✅ Alle empfohlenen Modelle sind bereits installiert!\n\n`
    }

    if (result.deprecated.length > 0) {
        msg += `**⚠️ Veraltete Modelle (können entfernt werden):**\n`
        for (const m of result.deprecated) {
            msg += `  • \`${m}\`\n`
        }
        msg += `\nEntfernen: \`ollama rm <model>\`\n\n`
    }

    msg += `_Quelle: Nova Model Catalog ${CATALOG_DATE} — für neueste Modelle: ollama.com/library_`
    return msg
}

export function formatNodeTopology(nodes: Array<{
    name: string
    status: string
    isLocal?: boolean
    models: string[]
    hardware?: {
        ramGb: number
        vramGb?: number
        gpu?: string
        gpuType?: string
        cores?: number
    }
    services?: string[]  // other running AI services (tts, stt, etc.)
}>): string {
    let msg = `🗺️ **Nova LLM Topology**\n\n`

    const totalModels = nodes.reduce((acc, n) => acc + n.models.length, 0)
    const onlineNodes = nodes.filter(n => n.status !== 'offline').length
    msg += `${onlineNodes}/${nodes.length} Nodes online — ${totalModels} Modelle gesamt\n\n`

    for (const node of nodes) {
        const statusIcon = node.status === 'online' ? '🟢' : node.status === 'busy' ? '🟡' : '🔴'
        msg += `${statusIcon} **${node.name}**${node.isLocal ? ' (dieser Node)' : ''}`

        if (node.hardware) {
            const hw = node.hardware
            msg += ` — ${hw.ramGb}GB RAM`
            if (hw.vramGb) msg += ` + ${hw.vramGb}GB VRAM`
            if (hw.gpu) msg += ` [${hw.gpu}]`
        }
        msg += '\n'

        if (node.models.length === 0) {
            msg += '   _Keine LLMs installiert_\n'
        } else {
            for (const m of node.models) {
                const isDeprecated = DEPRECATED_MODELS.some(dep =>
                    m === dep || m.startsWith(dep) || m.startsWith(dep + ':')
                )
                const icon = isDeprecated ? '⚠️' : '  •'
                msg += `${icon} \`${m}\`${isDeprecated ? ' *(veraltet)*' : ''}\n`
            }
        }

        if (node.services && node.services.length > 0) {
            msg += `   🔧 ${node.services.join(' · ')}\n`
        }

        msg += '\n'
    }

    msg += `_/nodes recommend <name> für Hardware-spezifische Modell-Empfehlungen_\n`
    msg += `_/nodes scan für Live-Service-Scan aller Nodes_`
    return msg
}

// ============================================
// Check a hardware profile for a given node
// from mesh registry data
// ============================================

export function hardwareFromMeshNode(node: {
    hardware?: {
        ram_gb?: number
        gpu_vram_mb?: number
        gpu?: string
        cores?: number
        arch?: string
        os_name?: string
    }
    capabilities?: string[]
    software?: { ollama?: string }
}): HardwareProfile {
    const hw = node.hardware || {}
    const caps = node.capabilities || []

    return {
        ramGb: hw.ram_gb || 0,
        vramGb: hw.gpu_vram_mb ? Math.round(hw.gpu_vram_mb / 1024) : undefined,
        cpuCores: hw.cores,
        hasGpu: caps.includes('gpu') || caps.includes('cuda') || caps.includes('nvidia'),
        gpuType: caps.includes('cuda') || caps.includes('nvidia') ? 'cuda'
            : caps.includes('metal') ? 'metal'
                : caps.includes('rocm') ? 'rocm'
                    : undefined,
        arch: hw.arch,
        isJetson: caps.includes('jetson') || (hw.os_name || '').includes('Jetson'),
        isRaspberryPi: caps.includes('raspberry-pi') || (hw.os_name || '').includes('Raspberry'),
    }
}

export default {
    getRecommendations,
    formatRecommendations,
    formatNodeTopology,
    detectHardwareTier,
    hardwareFromMeshNode,
    CATALOG,
    CATALOG_DATE,
    DEPRECATED_MODELS,
}
