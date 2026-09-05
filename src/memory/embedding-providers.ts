/**
 * Multi-Provider Embedding System
 *
 * Supports multiple embedding providers with automatic fallback:
 * 1. Ollama (local, free)
 * 2. OpenAI API
 * 3. OpenRouter API (multi-model gateway)
 * 4. Hash-based fallback (offline)
 *
 * Config-driven: Each provider can be enabled/disabled via nova config.
 */

// ============================================
// Types
// ============================================

export type EmbeddingProvider = 'ollama' | 'openai' | 'openrouter' | 'hash'

export interface EmbeddingConfig {
    /** Preferred provider order. Falls through on failure. */
    providers: EmbeddingProvider[]
    /** Target embedding dimension. Default: 768 */
    dimension: number
    /** Ollama embedding model. Default: auto-resolved */
    ollamaModel?: string
    /** OpenAI API key */
    openaiApiKey?: string
    /** OpenAI embedding model. Default: text-embedding-3-small */
    openaiModel?: string
    /** OpenRouter API key */
    openrouterApiKey?: string
    /** OpenRouter embedding model. Default: openai/text-embedding-3-small */
    openrouterModel?: string
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
    providers: ['ollama', 'openai', 'openrouter', 'hash'],
    dimension: 768,
    openaiModel: 'text-embedding-3-small',
    openrouterModel: 'openai/text-embedding-3-small',
}

// ============================================
// Provider Implementations
// ============================================

async function embedWithOllama(text: string, config: EmbeddingConfig): Promise<number[] | null> {
    try {
        let model = config.ollamaModel
        if (!model) {
            const { resolveModelId } = await import('../core/model-resolver.js')
            model = await resolveModelId('embedding')
        }

        const response = await fetch('http://localhost:11434/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt: text.slice(0, 2048),
            }),
            signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) return null

        const data = await response.json() as { embedding?: number[] }
        if (data.embedding && data.embedding.length > 0) {
            return normalizeToSize(data.embedding, config.dimension)
        }
    } catch { /* Ollama not available */ }
    return null
}

async function embedWithOpenAI(text: string, config: EmbeddingConfig): Promise<number[] | null> {
    const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY
    if (!apiKey) return null

    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: config.openaiModel || 'text-embedding-3-small',
                input: text.slice(0, 8192),
            }),
            signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) return null

        const data = await response.json() as { data?: Array<{ embedding?: number[] }> }
        if (data.data?.[0]?.embedding) {
            return normalizeToSize(data.data[0].embedding, config.dimension)
        }
    } catch { /* OpenAI not available */ }
    return null
}

async function embedWithOpenRouter(text: string, config: EmbeddingConfig): Promise<number[] | null> {
    const apiKey = config.openrouterApiKey || process.env.OPENROUTER_API_KEY
    if (!apiKey) return null

    try {
        const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://nova-ai.local',
                'X-Title': 'Nova Memory',
            },
            body: JSON.stringify({
                model: config.openrouterModel || 'openai/text-embedding-3-small',
                input: text.slice(0, 8192),
            }),
            signal: AbortSignal.timeout(15000),
        })

        if (!response.ok) return null

        const data = await response.json() as { data?: Array<{ embedding?: number[] }> }
        if (data.data?.[0]?.embedding) {
            return normalizeToSize(data.data[0].embedding, config.dimension)
        }
    } catch { /* OpenRouter not available */ }
    return null
}

function embedWithHash(text: string, dimension: number): number[] {
    if (!text || typeof text !== 'string') text = ''

    const embedding = new Array(dimension).fill(0)

    for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i)
        const idx = (charCode * (i + 1)) % dimension
        embedding[idx] += Math.sin(charCode + i) * 0.1
    }

    const magnitude = Math.sqrt(embedding.reduce((sum: number, val: number) => sum + val * val, 0))
    return embedding.map((val: number) => val / (magnitude || 1))
}

// ============================================
// Utilities
// ============================================

function normalizeToSize(embedding: number[], targetSize: number): number[] {
    if (embedding.length === targetSize) return embedding
    if (embedding.length > targetSize) return embedding.slice(0, targetSize)

    // Pad with zeros if too short
    const padded = [...embedding]
    while (padded.length < targetSize) padded.push(0)
    return padded
}

// ============================================
// Main Function
// ============================================

let activeProvider: EmbeddingProvider | null = null

/**
 * Generate embedding using the first available provider.
 * Remembers which provider worked and starts with it next time.
 */
export async function getEmbedding(
    text: string,
    config: Partial<EmbeddingConfig> = {}
): Promise<number[]> {
    const fullConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config }

    if (!text || typeof text !== 'string') {
        console.warn('[Embeddings] Called with invalid text, using empty string')
        text = ''
    }

    // If we found a working provider, try it first
    const providers = activeProvider
        ? [activeProvider, ...fullConfig.providers.filter(p => p !== activeProvider)]
        : fullConfig.providers

    for (const provider of providers) {
        let result: number[] | null = null

        switch (provider) {
            case 'ollama':
                result = await embedWithOllama(text, fullConfig)
                break
            case 'openai':
                result = await embedWithOpenAI(text, fullConfig)
                break
            case 'openrouter':
                result = await embedWithOpenRouter(text, fullConfig)
                break
            case 'hash':
                result = embedWithHash(text, fullConfig.dimension)
                break
        }

        if (result && result.length > 0) {
            if (activeProvider !== provider) {
                activeProvider = provider
                console.log(`[Embeddings] Using provider: ${provider}`)
            }
            return result
        }
    }

    // Ultimate fallback
    console.warn('[Embeddings] All providers failed, using hash fallback')
    return embedWithHash(text, fullConfig.dimension)
}

/**
 * Batch embed multiple texts efficiently.
 * Uses the same provider for all texts in the batch.
 */
export async function batchEmbed(
    texts: string[],
    config: Partial<EmbeddingConfig> = {}
): Promise<number[][]> {
    // For now, sequential embedding. Could be optimized with batch APIs.
    return Promise.all(texts.map(text => getEmbedding(text, config)))
}

/**
 * Get the current active embedding provider.
 */
export function getActiveProvider(): EmbeddingProvider | null {
    return activeProvider
}

export default {
    getEmbedding,
    batchEmbed,
    getActiveProvider,
    DEFAULT_EMBEDDING_CONFIG,
}
