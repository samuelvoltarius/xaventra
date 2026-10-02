import { describe, expect, it } from 'vitest'
import { selectBestNodeForCapability, setupNodeStrengthFacts } from './capability-researcher.js'

// 2.86 Paket J: "wohin installieren" nutzt dasselbe Stärken-Modul (rankNodes,
// Eignung nach Hardware) statt einer eigenen Punkteformel.
const setupNode = (name: string, patch: Record<string, unknown> = {}) => ({
    name, host: `${name}.example.com`, online: true, capabilities: [], services: {}, canInstall: [], recommendedFor: [], ollamaModels: [], ...patch,
}) as any

describe('selectBestNodeForCapability über rankNodes', () => {
    const gpu = setupNode('gpu-box', { hardware: { ram_gb: 64, cores: 16, gpu: 'NVIDIA RTX 4090', gpu_vram_mb: 24576 } })
    const pi = setupNode('pi', { hardware: { ram_gb: 8, cores: 4, arch: 'arm64' } })
    const nas = setupNode('nas', { hardware: { ram_gb: 8, cores: 4, disk_free_gb: 9000 } })

    it('Sprache → GPU-Knoten, große Modelle → GPU-Knoten, unabhängig von der Reihenfolge', () => {
        expect(selectBestNodeForCapability('stt', [pi, gpu])?.name).toBe('gpu-box')
        expect(selectBestNodeForCapability('llm', [pi, nas, gpu])?.name).toBe('gpu-box')
        expect(selectBestNodeForCapability('llm', [gpu, nas, pi])?.name).toBe('gpu-box')
    })

    it('übersetzt Setup-Knoten in Stärke-Fakten (Hardware, laufende Ollama-Modelle)', () => {
        const facts = setupNodeStrengthFacts(setupNode('b', { hardware: { ram_gb: 32, cores: 8 }, ollamaModels: ['qwen2.5:14b'] }), 1_000)
        expect(facts).toMatchObject({ nodeId: 'b', lastSeen: 1_000, hardware: { ramGB: 32, cpus: 8, gpuBackend: 'cpu' } })
        expect(facts.runtimes).toEqual([{ name: 'ollama', type: 'llm', models: ['qwen2.5:14b'], running: true }])
    })

    it('kein Knoten online → erster bekannter (wie bisher), keiner → null', () => {
        expect(selectBestNodeForCapability('stt', [{ ...pi, online: false }])?.name).toBe('pi')
        expect(selectBestNodeForCapability('stt', [])).toBeNull()
    })
})
