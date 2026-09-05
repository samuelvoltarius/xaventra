import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getDetectedDoctorHardware, type DoctorGpuVendor } from '../llm/llama-engine.js'

export type GpuRuntimeBackend = 'cuda' | 'vulkan' | 'metal'

export interface GpuBindingPackage {
    backend: GpuRuntimeBackend | 'cpu'
    packageName: string
    installed: boolean
    version?: string
}

export interface GpuRuntimeStatus {
    checkedAt: string
    detected: boolean
    vendor: DoctorGpuVendor
    name: string | null
    driverDetected: boolean
    cudaToolkitDetected: boolean
    vulkanLoaderDetected: boolean
    supportedBackends: GpuRuntimeBackend[]
    activeBackend: GpuRuntimeBackend | 'cpu'
    deviceNames: string[]
    bindings: GpuBindingPackage[]
    bindingVersion?: string
    errors: Partial<Record<GpuRuntimeBackend, string>>
    probeSkipped: boolean
}

export interface ProbeGpuRuntimeOptions {
    fresh?: boolean
    hardware?: { gpuVendor: DoctorGpuVendor; gpuName: string | null }
    /** Tests can provide a deterministic native probe without loading a real addon. */
    probeBackend?: (backend: GpuRuntimeBackend) => Promise<{ ok: boolean; deviceNames?: string[]; error?: string }>
}

let cachedProbe: { at: number; value: GpuRuntimeStatus } | null = null
const CACHE_MS = 5 * 60_000

function commandWorks(command: string, args: string[]): boolean {
    try {
        const result = spawnSync(command, args, { encoding: 'utf-8', timeout: 4_000, windowsHide: true })
        return result.status === 0
    } catch {
        return false
    }
}

function packageVersion(packageName: string): string | undefined {
    try {
        const path = join(process.cwd(), 'node_modules', ...packageName.split('/'), 'package.json')
        if (!existsSync(path)) return undefined
        return String(JSON.parse(readFileSync(path, 'utf-8')).version || '') || undefined
    } catch {
        return undefined
    }
}

function expectedBindingPackages(): GpuBindingPackage[] {
    const platform = process.platform
    const arch = process.arch
    const prefix = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'
    const base = `@node-llama-cpp/${prefix}-${arch}`
    const candidates: Array<[GpuBindingPackage['backend'], string]> = [
        ['cpu', base],
        ['cuda', `${base}-cuda`],
        ['vulkan', `${base}-vulkan`],
    ]
    return candidates.map(([backend, packageName]) => {
        const version = packageVersion(packageName)
        return { backend, packageName, installed: Boolean(version), version }
    })
}

function normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.replace(/\s+/g, ' ').trim().slice(0, 500)
}

async function nativeBackendProbe(backend: GpuRuntimeBackend): Promise<{ ok: boolean; deviceNames?: string[]; error?: string }> {
    let llama: any
    try {
        const mod = await import('node-llama-cpp')
        llama = await mod.getLlama({
            gpu: backend,
            build: 'never',
            logLevel: mod.LlamaLogLevel.error,
        })
        const deviceNames = await llama.getGpuDeviceNames()
        return { ok: llama.gpu === backend, deviceNames }
    } catch (error) {
        return { ok: false, error: normalizeError(error) }
    } finally {
        try { await llama?.dispose?.() } catch { /* best effort */ }
    }
}

function backendPreference(vendor: DoctorGpuVendor): GpuRuntimeBackend[] {
    if (vendor === 'nvidia') return ['cuda', 'vulkan']
    if (vendor === 'amd' || vendor === 'intel') return ['vulkan']
    if (vendor === 'apple') return ['metal']
    return ['vulkan']
}

/**
 * Deterministic, read-only GPU runtime check. It never downloads or compiles a
 * binding. A backend is only reported as available after its native addon was
 * loaded, initialized and returned at least one device.
 */
export async function probeGpuRuntime(options: ProbeGpuRuntimeOptions = {}): Promise<GpuRuntimeStatus> {
    if (!options.fresh && !options.probeBackend && cachedProbe && Date.now() - cachedProbe.at < CACHE_MS) {
        return cachedProbe.value
    }

    const hardware = options.hardware || getDetectedDoctorHardware()
    const probe = options.probeBackend || nativeBackendProbe
    const probeSkipped = !options.probeBackend && (
        process.env.NOVA_SKIP_MODEL_RESOLVER_INIT === '1'
        || process.env.NOVA_NO_SIDE_EFFECTS === '1'
        || process.env.NOVA_TEST_MODE === '1'
    )
    const detected = hardware.gpuVendor !== 'none' && hardware.gpuVendor !== 'unknown'
    const bindings = expectedBindingPackages()
    const errors: GpuRuntimeStatus['errors'] = {}
    const supportedBackends: GpuRuntimeBackend[] = []
    const deviceNames = new Set<string>()

    if (!probeSkipped) {
        for (const backend of backendPreference(hardware.gpuVendor)) {
            const result = await probe(backend)
            if (result.ok && (result.deviceNames?.length ?? 0) > 0) {
                supportedBackends.push(backend)
                for (const name of result.deviceNames || []) deviceNames.add(name)
            } else if (result.error) {
                errors[backend] = result.error
            }
        }
    }

    const cudaToolkitDetected = Boolean(process.env.CUDA_PATH)
        || commandWorks(process.platform === 'win32' ? 'nvcc.exe' : 'nvcc', ['--version'])
    const vulkanLoaderDetected = process.platform === 'win32'
        ? commandWorks('vulkaninfo.exe', ['--summary'])
        : commandWorks('vulkaninfo', ['--summary'])
    const driverDetected = hardware.gpuVendor === 'nvidia'
        ? commandWorks('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'])
        : detected

    const status: GpuRuntimeStatus = {
        checkedAt: new Date().toISOString(),
        detected,
        vendor: hardware.gpuVendor,
        name: hardware.gpuName,
        driverDetected,
        cudaToolkitDetected,
        vulkanLoaderDetected,
        supportedBackends,
        activeBackend: supportedBackends[0] || 'cpu',
        deviceNames: [...deviceNames],
        bindings,
        bindingVersion: packageVersion('node-llama-cpp'),
        errors,
        probeSkipped,
    }

    if (!options.probeBackend) cachedProbe = { at: Date.now(), value: status }
    return status
}

export function resetGpuRuntimeProbeCache(): void {
    cachedProbe = null
}
