import { describe, expect, it } from 'vitest'
import { probeGpuRuntime } from './gpu-runtime.js'

describe('GPU runtime doctor', () => {
    it('uses verified Vulkan when CUDA cannot load on an NVIDIA host', async () => {
        const status = await probeGpuRuntime({
            hardware: { gpuVendor: 'nvidia', gpuName: 'Test RTX' },
            probeBackend: async backend => backend === 'vulkan'
                ? { ok: true, deviceNames: ['Test RTX'] }
                : { ok: false, error: 'CUDA runtime missing' },
        })

        expect(status.activeBackend).toBe('vulkan')
        expect(status.supportedBackends).toEqual(['vulkan'])
        expect(status.errors.cuda).toContain('CUDA runtime missing')
    })

    it('keeps CPU fallback when no native backend passes its smoke test', async () => {
        const status = await probeGpuRuntime({
            hardware: { gpuVendor: 'amd', gpuName: 'Test Radeon' },
            probeBackend: async () => ({ ok: false, error: 'binding rejected' }),
        })

        expect(status.activeBackend).toBe('cpu')
        expect(status.supportedBackends).toEqual([])
        expect(status.errors.vulkan).toContain('binding rejected')
    })
})
