/**
 * Nova — Llama Engine
 *
 * In-process llama.cpp via node-llama-cpp.
 * Works on ANY machine: CUDA GPU → Metal → CPU fallback automatic.
 * "Kartoffel"-safe: CPU-thread capping, small context, adaptive model selection.
 *
 * Model resolution — picks smallest model that fits available RAM:
 *   VRAM/RAM ≥ 6 GB  → nova-doctor-1.5b-q5km.gguf   (best quality)
 *   VRAM/RAM ≥ 4 GB  → nova-doctor-1.5b-q4km.gguf
 *   VRAM/RAM ≥ 2 GB  → nova-doctor-0.5b-q5km.gguf
 *   VRAM/RAM ≥ 1 GB  → nova-doctor-0.5b-q4km.gguf
 *   VRAM/RAM < 1 GB  → nova-doctor-0.5b-q2k.gguf     (kartoffel mode)
 *
 * Override via xaventra.config.json: { "doctorModel": "1.5b-q5km" | "0.5b-q4km" | ... | "off" }
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cpus, totalmem } from 'node:os'
import { spawnSync } from 'node:child_process'
import { MODEL_REGISTRY, getDoctorModelsDir, getDoctorConfig, selectInstalledModel, verifyDoctorArtifact, isArtifactPresent, type ModelInfo } from './doctor-artifacts.js'
import type { GbnfJsonSchema } from 'node-llama-cpp'


export type DoctorGpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'unknown' | 'none'
export type DoctorBackend = 'cuda' | 'vulkan' | 'metal' | 'cpu'

export interface DoctorHardwareProfile {
    gpuVendor: DoctorGpuVendor
    gpuName: string | null
    backend: DoctorBackend
    supportedBackends: DoctorBackend[]
}

export interface LlamaCompletionOptions {
    systemPrompt?: string
    jsonSchema?: GbnfJsonSchema
    signal?: AbortSignal
    maxTokens?: number
    temperature?: number
    topP?: number
    stopStrings?: string[]
}

export interface LlamaEngine {
    complete(prompt: string, opts?: LlamaCompletionOptions): Promise<string>
    chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, opts?: LlamaCompletionOptions): Promise<string>
    modelName: string
    isReady: boolean
    hardware: DoctorHardwareProfile
    dispose(): Promise<void>
}

// ─── Model Catalogue ─────────────────────────────────────────────────────────

const MODEL_CATALOGUE = MODEL_REGISTRY

// ─── Hardware Detection ───────────────────────────────────────────────────────

function getSystemRamGB(): number {
    return totalmem() / (1024 ** 3)
}

function getCpuThreads(): number {
    // Use half of available cores — leave the rest for nova itself
    return Math.max(2, Math.floor(cpus().length / 2))
}

function commandOutput(command: string, args: string[]): string {
    try {
        const result = spawnSync(command, args, { encoding: 'utf-8', timeout: 3000, windowsHide: true })
        return result.status === 0 ? String(result.stdout || '').trim() : ''
    } catch {
        return ''
    }
}

function detectGpuIdentity(): { gpuVendor: DoctorGpuVendor; gpuName: string | null } {
    if (process.platform === 'darwin') {
        const output = commandOutput('system_profiler', ['SPDisplaysDataType'])
        return { gpuVendor: 'apple', gpuName: output.match(/Chipset Model:\s*(.+)/)?.[1]?.trim() || 'Apple GPU' }
    }
    const nvidia = commandOutput('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'])
    if (nvidia) return { gpuVendor: 'nvidia', gpuName: nvidia.split(/\r?\n/)[0].trim() }

    const display = process.platform === 'win32'
        ? commandOutput('wmic', ['path', 'win32_VideoController', 'get', 'Name', '/value'])
        : commandOutput('sh', ['-lc', "lspci 2>/dev/null | grep -Ei 'vga|3d|display'"])
    const normalized = display.toLowerCase()
    const name = display.match(/Name=(.+)/i)?.[1]?.trim() || display.split(/\r?\n/).find(Boolean)?.trim() || null
    if (/amd|radeon|advanced micro devices/.test(normalized)) return { gpuVendor: 'amd', gpuName: name }
    if (/intel/.test(normalized)) return { gpuVendor: 'intel', gpuName: name }
    return { gpuVendor: display ? 'unknown' : 'none', gpuName: name }
}

let detectedHardware: DoctorHardwareProfile | null = null

export function getDetectedDoctorHardware(): DoctorHardwareProfile {
    if (detectedHardware) return detectedHardware
    detectedHardware = { ...detectGpuIdentity(), backend: 'cpu', supportedBackends: ['cpu'] }
    return detectedHardware
}

function resolveModelPath(): string | null {
    try {
        const model = selectInstalledModel()
        return model ? join(getDoctorModelsDir(), model.filename) : null
    } catch { return null } // Invalid/unpinned config never enables a model.
}

// ─── Engine State ─────────────────────────────────────────────────────────────

let engineInstance: LlamaEngine | null = null
let initPromise: Promise<LlamaEngine | null> | null = null

// ─── Engine Creation ──────────────────────────────────────────────────────────

async function createEngine(selectedModel: ModelInfo): Promise<LlamaEngine> {
    const { getLlama, getLlamaGpuTypes, LlamaChatSession, LlamaLogLevel } = await import('node-llama-cpp')

    const threads = getCpuThreads()
    const ramGB = getSystemRamGB()

    const identity = getDetectedDoctorHardware()
    const available = await getLlamaGpuTypes('supported')
    const preference = identity.gpuVendor === 'nvidia'
        ? ['cuda', 'vulkan'] as const
        : identity.gpuVendor === 'amd'
            ? ['vulkan'] as const
            : identity.gpuVendor === 'apple'
                ? ['metal'] as const
                : ['vulkan'] as const
    const selected = preference.find(candidate => available.includes(candidate)) || false
    const backend: DoctorBackend = selected || 'cpu'
    detectedHardware = {
        ...identity,
        backend,
        supportedBackends: [...available.filter((item): item is 'cuda' | 'vulkan' | 'metal' => item !== false), 'cpu'],
    }
    console.log(`[LlamaEngine] Hardware: ${identity.gpuName || identity.gpuVendor}; candidate=${backend}`)

    let llama: Awaited<ReturnType<typeof getLlama>>
    try {
        llama = await getLlama({
            gpu: selected,
            build: 'never',
            logLevel: LlamaLogLevel.warn,
            ...(threads > 0 ? { threads } : {}),
        })
    } catch (error) {
        if (selected === false) throw error
        console.warn(`[LlamaEngine] ${backend} binding unavailable; falling back to CPU without compiling native code`)
        detectedHardware = { ...identity, backend: 'cpu', supportedBackends: ['cpu'] }
        llama = await getLlama({
            gpu: false,
            build: 'never',
            logLevel: LlamaLogLevel.warn,
            ...(threads > 0 ? { threads } : {}),
        })
    }

    const effectiveArtifact = detectedHardware?.backend === 'cpu' ? selectInstalledModel(true) : selectedModel
    if (!effectiveArtifact) { await llama.dispose(); throw new Error('Doctor disabled or model no longer available') }
    const effectiveModelPath = join(getDoctorModelsDir(), effectiveArtifact.filename)
    let model: Awaited<ReturnType<typeof llama.loadModel>>
    try {
        await verifyDoctorArtifact(effectiveModelPath, effectiveArtifact)
        model = await llama.loadModel({ modelPath: effectiveModelPath })
    } catch (error) { await llama.dispose(); throw error }

    // Smaller context on weak machines (RAM < 4 GB)
    const contextSize = ramGB < 4 ? 1024 : 2048

    const modelName = effectiveModelPath.split(/[\\/]/).pop() ?? 'nova-doctor'

    const engine: LlamaEngine = {
        modelName,
        isReady: true,
        hardware: detectedHardware,

        async complete(prompt: string, opts: LlamaCompletionOptions = {}): Promise<string> {
            const ctx = await model.createContext({ contextSize })
            try {
                const session = new LlamaChatSession({ contextSequence: ctx.getSequence(), systemPrompt: opts.systemPrompt })
                const grammar = opts.jsonSchema ? await llama.createGrammarForJsonSchema<GbnfJsonSchema>(opts.jsonSchema) : undefined
                return await session.prompt(prompt, {
                    grammar,
                    signal: opts.signal,
                    maxTokens: opts.maxTokens ?? 512,
                    temperature: opts.temperature ?? 0.1,
                    topP: opts.topP ?? 0.9,
                })
            } finally { await ctx.dispose() }
        },

        async chat(
            messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
            opts: LlamaCompletionOptions = {}
        ): Promise<string> {
            const ctx = await model.createContext({ contextSize })
            const session = new LlamaChatSession({ contextSequence: ctx.getSequence() })

            // Inject system message
            const systemMsg = messages.find(m => m.role === 'system')
            if (systemMsg) {
                await session.prompt(`[SYSTEM]: ${systemMsg.content}\n---`, {
                    maxTokens: 1,
                    temperature: 0.0,
                })
            }

            let lastResponse = ''
            for (const msg of messages.filter(m => m.role !== 'system')) {
                if (msg.role === 'user') {
                    lastResponse = await session.prompt(msg.content, {
                        maxTokens: opts.maxTokens ?? 512,
                        temperature: opts.temperature ?? 0.1,
                        topP: opts.topP ?? 0.9,
                    })
                }
            }

            await ctx.dispose()
            return lastResponse
        },

        async dispose(): Promise<void> {
            await model.dispose()
            await llama.dispose()
        },
    }

    return engine
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get (or lazily initialize) the global llama engine.
 * Returns null if no model found or doctorModel=off.
 */
export async function getLlamaEngine(): Promise<LlamaEngine | null> {
    if (getDoctorConfig().doctorModel === 'off') { await disposeLlamaEngine(); return null }
    if (engineInstance?.isReady) return engineInstance
    if (initPromise) return initPromise

    initPromise = (async () => {
        const selectedModel = selectInstalledModel()
        if (!selectedModel) {
            console.warn('[LlamaEngine] No GGUF model in models/ — Nova Doctor offline')
            return null
        }

        const ramGB = Math.round(getSystemRamGB() * 10) / 10
        const threads = getCpuThreads()
        const modelName = selectedModel.filename

        console.log(`[LlamaEngine] Loading ${modelName} (RAM: ${ramGB}GB, CPU threads: ${threads})...`)

        try {
            const engine = await createEngine(selectedModel)
            engineInstance = engine
            console.log(`[LlamaEngine] ✅ Nova Doctor ready: ${engine.modelName}`)
            return engine
        } catch (err: any) {
            console.error(`[LlamaEngine] ❌ Failed: ${err.message}`)
            return null
        }
    })()

    const pending = initPromise
    try { return await pending } finally { if (initPromise === pending) initPromise = null }
}

/**
 * Quick one-shot completion.
 */
export async function llamaComplete(
    prompt: string,
    opts?: LlamaCompletionOptions
): Promise<string | null> {
    const engine = await getLlamaEngine()
    if (!engine) return null
    return engine.complete(prompt, opts)
}

/**
 * Check whether any Nova Doctor model is present on disk.
 */
export function hasLocalModel(): boolean {
    return resolveModelPath() !== null
}

/**
 * Return info about available models and hardware.
 */
export function getDoctorInfo(): {
    available: boolean
    modelName: string | null
    ramGB: number
    cpuThreads: number
    models: string[]
    hardware: DoctorHardwareProfile
    loaded: boolean
    integrity: 'verified' | 'not_checked'
} {
    const modelPath = resolveModelPath()
    const available = MODEL_CATALOGUE.filter(isArtifactPresent)
    return {
        available: modelPath !== null,
        modelName: engineInstance?.modelName || (modelPath ? modelPath.split(/[\\/]/).pop() ?? null : null),
        ramGB: Math.round(getSystemRamGB() * 10) / 10,
        cpuThreads: getCpuThreads(),
        models: available.map(m => m.filename),
        hardware: getDetectedDoctorHardware(),
        loaded: Boolean(engineInstance?.isReady && modelPath),
        integrity: engineInstance?.isReady && modelPath ? 'verified' : 'not_checked',
    }
}

/**
 * Dispose the global engine (call on graceful shutdown).
 */
export async function disposeLlamaEngine(): Promise<void> {
    // Wait for an in-flight load before disposing; do not leave a late engine alive.
    const pending = initPromise
    if (pending) await pending.catch(() => null)
    initPromise = null
    const engine = engineInstance
    engineInstance = null
    if (engine) await engine.dispose()
}
