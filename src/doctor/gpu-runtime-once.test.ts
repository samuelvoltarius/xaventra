import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNativeProbe, resetGpuRuntimeProbeCache, type GpuBindingPackage } from './gpu-runtime.js'

// B8 (28.10.2026, VM 130, x86 ohne GPU, nur emulierte QEMU-Grafik): 79×
// "[WARN ] [node-llama-cpp] A prebuilt binary was not found" — alle 10 min beim Umgebungs-Scan,
// weil das Vulkan-Backend geprüft wurde, dessen Binding-Paket gar nicht installiert ist.
const bindings = (vulkan: boolean): GpuBindingPackage[] => [
    { backend: 'cpu', packageName: '@node-llama-cpp/linux-x64', installed: true, version: '3.0.0' },
    { backend: 'cuda', packageName: '@node-llama-cpp/linux-x64-cuda', installed: false },
    { backend: 'vulkan', packageName: '@node-llama-cpp/linux-x64-vulkan', installed: vulkan, version: vulkan ? '3.0.0' : undefined },
]

describe('GPU runtime probe once per start (B8)', () => {
    beforeEach(() => resetGpuRuntimeProbeCache())
    it('never loads node-llama-cpp for a backend whose binding is not installed', async () => {
        const load = vi.fn(async () => ({ ok: false, error: 'A prebuilt binary was not found' }))
        const probe = createNativeProbe(bindings(false), load)
        for (let scan = 0; scan < 79; scan++) {
            const result = await probe('vulkan')
            expect(result.ok).toBe(false)
            expect(result.error).toMatch(/nicht installiert/)
        }
        expect(load).not.toHaveBeenCalled()
    })

    it('an installed binding is loaded once per process, later scans reuse the result', async () => {
        const load = vi.fn(async () => ({ ok: true, deviceNames: ['GPU 0'] }))
        const probe = createNativeProbe(bindings(true), load)
        for (let scan = 0; scan < 10; scan++) expect(await probe('vulkan')).toEqual({ ok: true, deviceNames: ['GPU 0'] })
        expect(load).toHaveBeenCalledTimes(1)
    })
})
