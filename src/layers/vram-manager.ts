/**
 * VRAM Manager — Smart GPU Memory Management
 * 
 * Manages GPU memory across ALL devices (Windows GPU, Jetson, Pi5, any Ollama host).
 * Before loading a new model, checks available VRAM and unloads idle models.
 * 
 * Prevents OOM crashes when switching between models (e.g. gemma3:12b → moondream).
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'vram')

/**
 * NVIDIA Grace/Blackwell SoCs expose shared system memory instead of a
 * dedicated VRAM counter. nvidia-smi consequently reports "[N/A]" even
 * though CUDA is usable. Keep headroom for the OS and other Spark services.
 */
export function deriveUnifiedNvidiaMemory(gpuName: string, systemMemoryBytes: number): number | null {
    if (!Number.isFinite(systemMemoryBytes) || systemMemoryBytes <= 0) return null
    if (/\bGB10\b/i.test(gpuName)) return Math.floor(systemMemoryBytes * 0.75)
    if (/\b(?:Tegra|Jetson)\b/i.test(gpuName)) return Math.floor(systemMemoryBytes * 0.5)
    return null
}

// ============================================
// Types
// ============================================

interface LoadedModel {
    name: string
    sizeBytes: number
    loadedAt: number
    lastUsedAt: number
    ollamaHost: string
}

interface VRAMStatus {
    totalBytes: number
    freeBytes: number
    usedBytes: number
    loadedModels: LoadedModel[]
}

// ============================================
// Model size estimates (when Ollama doesn't report)
// ============================================

const MODEL_SIZE_ESTIMATES: Record<string, number> = {
    // Format: bytes
    'gemma3:4b': 2.5e9,      // ~2.5 GB
    'gemma3:12b': 7.5e9,     // ~7.5 GB
    'gemma3:27b': 16e9,      // ~16 GB
    'llama3.2:3b': 2e9,      // ~2 GB
    'llama3.2:8b': 5e9,      // ~5 GB
    'mistral:7b': 4.5e9,     // ~4.5 GB
    'moondream:latest': 1.7e9, // ~1.7 GB
    'nomic-embed-text:latest': 0.5e9, // ~500 MB
}

function estimateModelSize(name: string): number {
    // Exact match
    if (MODEL_SIZE_ESTIMATES[name]) return MODEL_SIZE_ESTIMATES[name]

    // Partial match (e.g. 'gemma3:12b-instruct' → 'gemma3:12b')
    for (const [key, size] of Object.entries(MODEL_SIZE_ESTIMATES)) {
        if (name.startsWith(key.split(':')[0]) && name.includes(key.split(':')[1]?.split('-')[0] || '')) {
            return size
        }
    }

    // Default: assume 4 GB
    return 4e9
}

// ============================================
// Ollama API helpers
// ============================================

async function ollamaRequest(host: string, path: string, method = 'GET', body?: unknown): Promise<any> {
    const url = `${host}${path}`
    try {
        const response = await fetch(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) return null
        return await response.json()
    } catch {
        return null
    }
}

/**
 * Get currently loaded models from Ollama
 */
async function getLoadedModels(host: string): Promise<LoadedModel[]> {
    const data = await ollamaRequest(host, '/api/ps')
    if (!data?.models) return []

    return data.models.map((m: any) => ({
        name: m.name,
        sizeBytes: m.size || estimateModelSize(m.name),
        loadedAt: new Date(m.expires_at || Date.now()).getTime() - (m.size_vram || 0),
        lastUsedAt: Date.now(),
        ollamaHost: host,
    }))
}

/**
 * Unload a specific model from Ollama
 */
async function unloadModel(host: string, modelName: string): Promise<boolean> {
    console.log(`[VRAM] 🔄 Unloading model: ${modelName} from ${host}`)
    const result = await ollamaRequest(host, '/api/generate', 'POST', {
        model: modelName,
        keep_alive: 0,  // 0 = unload immediately
    })
    if (result !== null) {
        console.log(`[VRAM] ✅ Model ${modelName} unloaded`)
        return true
    }
    console.log(`[VRAM] ⚠️ Failed to unload ${modelName}`)
    return false
}

/**
 * Get total VRAM available on the system
 */
async function detectVRAM(host: string): Promise<number> {
    // Priority 1: config override
    try {
        const { readFileSync } = await import('node:fs')
        const config = JSON.parse(readFileSync(join(process.cwd(), 'nova.config.json'), 'utf-8'))
        if (config.vramOverrideGB) {
            console.log(`[VRAM] Using config override: ${config.vramOverrideGB}GB`)
            return config.vramOverrideGB * 1e9
        }
    } catch { /* no config */ }

    const { execSync } = await import('node:child_process')

    // Priority 2: nvidia-smi (NVIDIA GPUs — Windows + Linux)
    try {
        const output = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', {
            timeout: 5000,
            encoding: 'utf-8',
        }).trim()
        const firstGpu = output.split('\n')[0]
        const separator = firstGpu.lastIndexOf(',')
        const gpuName = separator >= 0 ? firstGpu.slice(0, separator).trim() : ''
        const mbTotal = parseInt(separator >= 0 ? firstGpu.slice(separator + 1) : firstGpu)
        if (mbTotal > 0) {
            console.log(`[VRAM] nvidia-smi detected: ${mbTotal}MB (NVIDIA)`)
            return mbTotal * 1e6
        }
        const unifiedBytes = deriveUnifiedNvidiaMemory(gpuName, (await import('node:os')).totalmem())
        if (unifiedBytes) {
            console.log(`[VRAM] ${gpuName} detected: ${(unifiedBytes / 1e9).toFixed(1)}GB usable unified memory`)
            return unifiedBytes
        }
    } catch { /* no nvidia-smi */ }

    // Priority 3: rocm-smi (AMD GPUs — Linux with ROCm)
    try {
        const output = execSync('rocm-smi --showmeminfo vram --csv', {
            timeout: 5000,
            encoding: 'utf-8',
        }).trim()
        // Parse CSV: look for total VRAM line
        const lines = output.split('\n')
        for (const line of lines) {
            const match = line.match(/(\d+)/)
            if (match) {
                const bytes = parseInt(match[1])
                if (bytes > 1e8) {  // sanity: > 100MB
                    console.log(`[VRAM] rocm-smi detected: ${(bytes / 1e9).toFixed(1)}GB (AMD)`)
                    return bytes
                }
            }
        }
    } catch { /* no rocm-smi */ }

    // Priority 4: Windows GPU detection via PowerShell (AMD, Intel, any GPU)
    if (process.platform === 'win32') {
        try {
            const output = execSync(
                'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty AdapterRAM"',
                { timeout: 5000, encoding: 'utf-8' }
            ).trim()
            const bytes = parseInt(output)
            if (bytes > 1e8) {  // sanity: > 100MB
                console.log(`[VRAM] Windows GPU detected: ${(bytes / 1e9).toFixed(1)}GB`)
                return bytes
            }
        } catch { /* no GPU via WMI */ }
    }

    // Priority 5: Jetson (unified memory — use half of system RAM for GPU)
    try {
        const { readFileSync } = await import('node:fs')
        const model = readFileSync('/proc/device-tree/model', 'utf-8')
        if (model.includes('Jetson') || model.includes('NVIDIA')) {
            const systemMem = (await import('node:os')).totalmem()
            const jetsonVRAM = Math.floor(systemMem * 0.5)  // ~50% usable for GPU
            console.log(`[VRAM] Jetson detected: ${(jetsonVRAM / 1e9).toFixed(1)}GB unified`)
            return jetsonVRAM
        }
    } catch { /* not Jetson */ }

    // Priority 6: Ollama reports VRAM from loaded models
    const data = await ollamaRequest(host, '/api/ps')
    if (data?.models?.[0]?.size_vram) {
        const totalUsed = data.models.reduce((sum: number, m: any) => sum + (m.size_vram || 0), 0)
        return Math.max(totalUsed * 1.5, 4e9)
    }

    // Fallback: can't detect — assume 4GB (safe default)
    console.log('[VRAM] ⚠️ Could not detect VRAM — defaulting to 4GB')
    return 4e9
}

// ============================================
// VRAM Manager
// ============================================

const modelUsageTimestamps = new Map<string, number>()

/**
 * Check if we have enough VRAM to load a model.
 * If not, unload the least recently used model.
 */
export async function ensureVRAMForModel(
    modelName: string,
    ollamaHost: string = 'http://localhost:11434'
): Promise<{
    ready: boolean
    unloaded: string[]
    status: VRAMStatus
}> {
    const unloaded: string[] = []

    // Get current state
    const loaded = await getLoadedModels(ollamaHost)
    const totalVRAM = await detectVRAM(ollamaHost)
    const usedVRAM = loaded.reduce((sum, m) => sum + m.sizeBytes, 0)
    const freeVRAM = totalVRAM - usedVRAM
    const neededVRAM = estimateModelSize(modelName)

    // Track usage
    modelUsageTimestamps.set(modelName, Date.now())

    const status: VRAMStatus = {
        totalBytes: totalVRAM,
        freeBytes: freeVRAM,
        usedBytes: usedVRAM,
        loadedModels: loaded,
    }

    // Already loaded? Just update timestamp
    if (loaded.some(m => m.name === modelName || m.name.startsWith(modelName))) {
        console.log(`[VRAM] ✅ Model ${modelName} already loaded`)
        return { ready: true, unloaded, status }
    }

    // Enough free VRAM?
    if (freeVRAM >= neededVRAM * 1.1) {  // 10% safety margin
        console.log(`[VRAM] ✅ Enough VRAM (${formatBytes(freeVRAM)} free, ${formatBytes(neededVRAM)} needed)`)
        return { ready: true, unloaded, status }
    }

    // Need to free VRAM — unload least recently used models
    console.log(`[VRAM] ⚠️ Not enough VRAM: ${formatBytes(freeVRAM)} free, ${formatBytes(neededVRAM)} needed`)

    // Sort by last usage (oldest first)
    const sortedModels = [...loaded].sort((a, b) => {
        const aUsage = modelUsageTimestamps.get(a.name) || a.lastUsedAt
        const bUsage = modelUsageTimestamps.get(b.name) || b.lastUsedAt
        return aUsage - bUsage
    })

    let freedBytes = 0
    for (const model of sortedModels) {
        // Don't unload the model we're trying to load
        if (model.name === modelName) continue

        // Don't unload embedding models (they're tiny and always needed)
        if (model.name.includes('embed') || model.name.includes('nomic')) continue

        const success = await unloadModel(ollamaHost, model.name)
        if (success) {
            freedBytes += model.sizeBytes
            unloaded.push(model.name)
            console.log(`[VRAM] Freed ${formatBytes(model.sizeBytes)} (total freed: ${formatBytes(freedBytes)})`)

            // Enough space now?
            if (freeVRAM + freedBytes >= neededVRAM * 1.1) {
                break
            }
        }
    }

    // Update status
    status.freeBytes = freeVRAM + freedBytes
    status.usedBytes = usedVRAM - freedBytes
    status.loadedModels = loaded.filter(m => !unloaded.includes(m.name))

    const ready = status.freeBytes >= neededVRAM
    if (ready) {
        console.log(`[VRAM] ✅ VRAM freed successfully. Ready to load ${modelName}`)
    } else {
        console.log(`[VRAM] 🚨 Cannot free enough VRAM for ${modelName} (${formatBytes(status.freeBytes)} < ${formatBytes(neededVRAM)})`)
    }

    // Persist status
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'last-status.json'), JSON.stringify({
            timestamp: new Date().toISOString(),
            host: ollamaHost,
            ...status,
            lastUnloaded: unloaded,
        }, null, 2))
    } catch { /* non-critical */ }

    return { ready, unloaded, status }
}

/**
 * Get VRAM status for a specific host
 */
export async function getVRAMStatus(ollamaHost = 'http://localhost:11434'): Promise<VRAMStatus> {
    const loaded = await getLoadedModels(ollamaHost)
    const totalVRAM = await detectVRAM(ollamaHost)
    const usedVRAM = loaded.reduce((sum, m) => sum + m.sizeBytes, 0)

    return {
        totalBytes: totalVRAM,
        freeBytes: totalVRAM - usedVRAM,
        usedBytes: usedVRAM,
        loadedModels: loaded,
    }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}MB`
    return `${bytes}B`
}

/**
 * Initialize VRAM manager — log current state
 */
export async function initVRAMManager(ollamaHost = 'http://localhost:11434'): Promise<void> {
    try {
        const status = await getVRAMStatus(ollamaHost)
        console.log(`[VRAM] ✅ Manager initialized — ${formatBytes(status.totalBytes)} total, ${formatBytes(status.freeBytes)} free, ${status.loadedModels.length} models loaded`)
        if (status.loadedModels.length > 0) {
            for (const m of status.loadedModels) {
                console.log(`[VRAM]   📦 ${m.name} (${formatBytes(m.sizeBytes)})`)
            }
        }
    } catch (err) {
        console.log(`[VRAM] ⚠️ Manager init failed (no Ollama?): ${err}`)
    }
}
