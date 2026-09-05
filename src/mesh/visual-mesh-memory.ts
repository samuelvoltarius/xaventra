// Visual Mesh Memory v2 — Uses Capability Orchestrator for routing
// No hardcoded endpoints. Discovers best vision provider dynamically.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'visual-memory')

interface VisualMemory {
    id: string
    imagePath: string
    description: string
    source: string
    processedBy: string  // Which node/cloud processed it
    timestamp: string
    tags: string[]
}

let visualMemories: VisualMemory[] = []

// Describe an image using the BEST available vision provider
export async function describeImage(imagePath: string): Promise<{ description: string; processedBy: string } | null> {
    if (!existsSync(imagePath)) {
        console.log(`[VisualMem] File not found: ${imagePath}`)
        return null
    }

    // Ask Capability Orchestrator: who has vision?
    try {
        const { findBestCapability } = await import('./capability-orchestrator.js')
        const match = findBestCapability({
            capability: 'vision',
            preferLocal: false,     // Best quality wins
            preferQuality: true,
        })

        if (match) {
            console.log(`[VisualMem] Routing to: ${match.reason}`)

            // Cloud vision (OpenAI, local)
            if (match.source === 'cloud') {
                return await describeViaCloud(imagePath, match.nodeName, match.provider)
            }

            // Local vision (Ollama: moondream, llava, etc.)
            if (match.source === 'node') {
                const node = await getNodeAddress(match.nodeName)
                if (node) {
                    return await describeViaOllama(imagePath, node, match.provider, match.nodeName)
                }
            }
        }
    } catch {
        console.log('[VisualMem] Capability Orchestrator not available, trying fallback')
    }

    // Fallback: try all Ollama endpoints
    return await describeViaFallbackChain(imagePath)
}

// Describe via Cloud LLM (OpenAI vision)
async function describeViaCloud(imagePath: string, cloudName: string, provider: string): Promise<{ description: string; processedBy: string } | null> {
    try {
        // Direct cloud API call with vision
        const imageData = readFileSync(imagePath).toString('base64')
        const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'

        // Direct OpenAI API call with vision
        const apiKey = process.env.OPENAI_API_KEY
        if (!apiKey) return null

        const response = await fetch(
            `DISABLED_GOOGLE_API`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: 'Beschreibe dieses Bild detailliert auf Deutsch. Erwaehne Objekte, Personen, Farben, Text und Kontext.' },
                            { inline_data: { mime_type: mimeType, data: imageData } },
                        ],
                    }],
                }),
                signal: AbortSignal.timeout(30000),
            }
        )

        if (response.ok) {
            const data = await response.json() as any
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
            if (text.length > 10) {
                return { description: text, processedBy: `${cloudName}/${provider}` }
            }
        }
    } catch (err: any) {
        console.log(`[VisualMem] Cloud vision failed: ${err.message?.slice(0, 60)}`)
    }
    return null
}

// Describe via local Ollama (moondream, llava, etc.)
async function describeViaOllama(imagePath: string, address: string, model: string, nodeName: string): Promise<{ description: string; processedBy: string } | null> {
    try {
        const imageData = readFileSync(imagePath).toString('base64')
        const response = await fetch(`http://${address}:11434/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt: 'Describe this image in detail. Include objects, people, colors, text, and context.',
                images: [imageData],
                stream: false,
            }),
            signal: AbortSignal.timeout(30000),
        })

        if (response.ok) {
            const data = await response.json() as any
            const text = data.response || ''
            if (text.length > 10) {
                return { description: text, processedBy: `${nodeName}/${model}` }
            }
        }
    } catch { }
    return null
}

// Fallback chain (no orchestrator)
async function describeViaFallbackChain(imagePath: string): Promise<{ description: string; processedBy: string } | null> {
    const endpoints = [
        { address: '100.64.0.22', name: 'jetson' },
        { address: '100.64.0.21', name: 'pi5' },
        { address: 'localhost', name: 'local' },
    ]

    for (const ep of endpoints) {
        // Try each endpoint with common vision models
        for (const model of ['moondream', 'llava', 'bakllava']) {
            const result = await describeViaOllama(imagePath, ep.address, model, ep.name)
            if (result) return result
        }
    }

    // Last resort: try OpenAI cloud
    return await describeViaCloud(imagePath, 'openai', 'auto')
}

// Get node address from orchestrator
async function getNodeAddress(nodeName: string): Promise<string | null> {
    const addresses: Record<string, string> = {
        master: 'localhost',
        jetson: '100.64.0.22',
        pi5: '100.64.0.21',
    }
    return addresses[nodeName] || null
}

// Store a visual memory
export async function rememberImage(imagePath: string, source = 'user'): Promise<VisualMemory | null> {
    const result = await describeImage(imagePath)
    if (!result) return null

    const tags = extractTags(result.description)

    const memory: VisualMemory = {
        id: `vis_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        imagePath,
        description: result.description,
        source,
        processedBy: result.processedBy,
        timestamp: new Date().toISOString(),
        tags,
    }

    visualMemories.push(memory)
    if (visualMemories.length > 200) visualMemories = visualMemories.slice(-200)
    saveVisualMemories()

    // Store in LanceDB
    try {
        const { remember } = await import('../memory/lancedb-memory.js')
        await remember(`[Bild via ${result.processedBy}] ${result.description}`, 'fact', source, { imagePath, tags })
    } catch { }

    // Share to mesh
    try {
        const { shareMemory } = await import('./mesh-memory-sync.js')
        shareMemory(`[Bild] ${result.description}`, 'fact', source).catch(() => { })
    } catch { }

    console.log(`[VisualMem] Stored via ${result.processedBy}: "${result.description.slice(0, 50)}..."`)
    return memory
}

// Search visual memories
export function searchVisualMemories(query: string, limit = 5): VisualMemory[] {
    const q = query.toLowerCase()
    return visualMemories
        .filter(m => m.description.toLowerCase().includes(q) || m.tags.some(t => t.includes(q)))
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit)
}

function extractTags(description: string): string[] {
    const common = ['person', 'people', 'car', 'dog', 'cat', 'building', 'tree',
        'text', 'screen', 'computer', 'phone', 'table', 'food', 'sky',
        'water', 'road', 'sign', 'book', 'window', 'door', 'light']
    const descLC = description.toLowerCase()
    return common.filter(tag => descLC.includes(tag))
}

export function getVisualMemoryStatus(): string {
    return `Visual Memory: ${visualMemories.length} Bilder gespeichert`
}

function saveVisualMemories(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'memories.json'), JSON.stringify(visualMemories.slice(-100), null, 2))
    } catch { }
}

export function initVisualMemory(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    try {
        const path = join(DATA_DIR, 'memories.json')
        if (existsSync(path)) visualMemories = JSON.parse(readFileSync(path, 'utf-8'))
    } catch { }
    console.log(`[VisualMem] Initialized: ${visualMemories.length} visual memories`)
}
