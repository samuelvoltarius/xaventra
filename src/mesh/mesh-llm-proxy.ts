// Mesh LLM Proxy — Bidirectional LLM access across all nodes
//
// Problem: OAuth/API keys are only on Master. Ollama GPU is only on Jetson.
// Solution: Proxy LLM requests through the mesh.
//
// Flow 1: Node needs Cloud LLM
//   Jetson → mesh:llm_request → Master → OpenAI API → mesh:llm_response → Jetson
//
// Flow 2: Master needs local LLM
//   Master → mesh:llm_request → Jetson → Ollama → mesh:llm_response → Master

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'llm-proxy')

// ============================================
// Types
// ============================================

interface LLMProxyRequest {
    prompt: string
    model?: string         // Optional: specific model
    maxTokens?: number
    temperature?: number
    images?: string[]      // Base64 images for vision
    preferLocal?: boolean  // Prefer local Ollama over cloud
}

interface LLMProxyStats {
    totalProxied: number
    cloudViaNode: number    // Nodes using Master's cloud
    localViaMaster: number  // Master using Node's Ollama
    errors: number
}

// ============================================
// State
// ============================================

let stats: LLMProxyStats = {
    totalProxied: 0,
    cloudViaNode: 0,
    localViaMaster: 0,
    errors: 0,
}

// ============================================
// Core — LLM Proxy complete call
// ============================================

// Call the best available LLM (local or remote)
export async function proxyLLMRequest(request: LLMProxyRequest): Promise<string> {
    const myName = process.env.NOVA_NODE_NAME || 'master'

    // Step 1: Try local LLM first (if available)
    if (request.preferLocal || myName !== 'master') {
        const localResult = await tryLocalOllama(request)
        if (localResult) return localResult
    }

    // Step 2: If we're master, use cloud directly
    if (myName === 'master') {
        const cloudResult = await tryCloudLLM(request)
        if (cloudResult) return cloudResult
    }

    // Step 3: If we're a node, proxy through master for cloud
    if (myName !== 'master') {
        const proxiedResult = await proxyThroughMaster(request)
        if (proxiedResult) {
            stats.cloudViaNode++
            stats.totalProxied++
            return proxiedResult
        }
    }

    // Step 4: If we're master, try any node with Ollama
    if (myName === 'master') {
        const nodeResult = await proxyThroughNode(request)
        if (nodeResult) {
            stats.localViaMaster++
            stats.totalProxied++
            return nodeResult
        }
    }

    stats.errors++
    return 'Kein LLM verfuegbar (weder lokal noch remote)'
}

// ============================================
// Local Ollama
// ============================================

async function tryLocalOllama(request: LLMProxyRequest): Promise<string | null> {
    try {
        const model = request.model || 'gemma3:4b'
        const body: any = {
            model,
            prompt: request.prompt,
            stream: false,
        }

        if (request.images && request.images.length > 0) {
            body.images = request.images
        }

        const resp = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
        })

        if (resp.ok) {
            const data = await resp.json() as any
            return data.response || null
        }
    } catch { }
    return null
}

// ============================================
// Cloud LLM (Master only — has API keys)
// ============================================

async function tryCloudLLM(request: LLMProxyRequest): Promise<string | null> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return null

    try {
        const model = request.model || 'auto'
        const parts: any[] = [{ text: request.prompt }]

        // Add images for vision
        if (request.images && request.images.length > 0) {
            for (const img of request.images) {
                parts.push({ inline_data: { mime_type: 'image/jpeg', data: img } })
            }
        }

        const resp = await fetch(
            `DISABLED_GOOGLE_API`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: {
                        maxOutputTokens: request.maxTokens || 1000,
                        temperature: request.temperature || 0.7,
                    },
                }),
                signal: AbortSignal.timeout(30000),
            }
        )

        if (resp.ok) {
            const data = await resp.json() as any
            return data.candidates?.[0]?.content?.parts?.[0]?.text || null
        }
    } catch { }
    return null
}

// ============================================
// Proxy through Master (for nodes needing cloud)
// ============================================

async function proxyThroughMaster(request: LLMProxyRequest): Promise<string | null> {
    try {
        const { remoteExec } = await import('./mesh-remote-exec.js')
        const response = await remoteExec('master', 'llm', request, 60000)
        if (response.success) {
            return response.result as string
        }
    } catch (err: any) {
        console.log(`[LLMProxy] Master proxy failed: ${err.message?.slice(0, 60)}`)
    }
    return null
}

// ============================================
// Proxy through Node (for master needing local)
// ============================================

async function proxyThroughNode(request: LLMProxyRequest): Promise<string | null> {
    // Try Jetson first (GPU), then Pi5
    const nodeOrder = ['jetson', 'pi5']

    for (const nodeName of nodeOrder) {
        try {
            const { remoteExec } = await import('./mesh-remote-exec.js')
            const response = await remoteExec(nodeName, 'ollama', request, 60000)
            if (response.success) {
                console.log(`[LLMProxy] Got response from ${nodeName}`)
                return response.result as string
            }
        } catch { }
    }

    return null
}

// ============================================
// Register as remote exec handlers
// ============================================

export async function registerLLMHandlers(): Promise<void> {
    try {
        const { registerHandler } = await import('./mesh-remote-exec.js')

        // Handle cloud LLM requests (master processes these)
        registerHandler('llm', async (payload: LLMProxyRequest) => {
            const result = await tryCloudLLM(payload)
            if (!result) throw new Error('Cloud LLM not available')
            return result
        })

        // Handle local Ollama requests (nodes process these)
        registerHandler('ollama', async (payload: LLMProxyRequest) => {
            const result = await tryLocalOllama(payload)
            if (!result) throw new Error('Local Ollama not available')
            return result
        })

        console.log('[LLMProxy] ✅ Handlers registered (llm + ollama)')
    } catch (err) {
        console.log(`[LLMProxy] ⚠️ Failed to register handlers: ${err}`)
    }
}

// ============================================
// Status
// ============================================

export function getLLMProxyStats(): string {
    return `LLM Proxy: ${stats.totalProxied} proxied (${stats.cloudViaNode} cloud-via-node, ${stats.localViaMaster} local-via-master, ${stats.errors} errors)`
}

// ============================================
// Persistence
// ============================================

function saveStats(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'stats.json'), JSON.stringify(stats, null, 2))
    } catch { }
}

export function initLLMProxy(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    try {
        const path = join(DATA_DIR, 'stats.json')
        if (existsSync(path)) stats = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { }

    // Auto-save stats every 5 minutes
    setInterval(saveStats, 5 * 60 * 1000)

    console.log(`[LLMProxy] ✅ Initialized (${stats.totalProxied} total proxied)`)
}
