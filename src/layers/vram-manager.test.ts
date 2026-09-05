import { describe, expect, it } from 'vitest'
import { deriveUnifiedNvidiaMemory } from './vram-manager.js'

describe('unified NVIDIA memory detection', () => {
    it('reserves operating-system headroom on a GB10 Spark', () => {
        expect(deriveUnifiedNvidiaMemory('NVIDIA GB10', 128e9)).toBe(96e9)
    })

    it('uses a conservative share for Jetson devices', () => {
        expect(deriveUnifiedNvidiaMemory('NVIDIA Jetson AGX Orin', 64e9)).toBe(32e9)
    })

    it('does not infer shared memory for discrete GPUs', () => {
        expect(deriveUnifiedNvidiaMemory('NVIDIA RTX 5090', 128e9)).toBeNull()
    })
})
