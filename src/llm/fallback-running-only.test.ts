/**
 * 2.85 Paket C, Live-Befund Spark 01.10.: ModelFallback versuchte mehrfach
 * „ollama/qwen“ und „ollama/qwen3.8-flash-next“, obwohl Ollama dort nur
 * installiert, aber aus ist. Rückfall-Ziele kommen nur aus LAUFENDEN,
 * erreichbaren Endpunkten mit tatsächlich vorhandenem Modell — nie aus
 * „installiert, nicht gestartet“ und nie aus geratenen Modellnamen.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const chain = vi.hoisted(() => ({ entries: [] as Array<{ provider: string; model: string }> }))
vi.mock('./model-discovery.js', () => ({ buildFallbackChain: () => chain.entries }))
vi.mock('../core/model-defaults.js', () => ({ getDefaultModel: () => 'qwen3.8-flash-next' }))

import { getDefaultFallbacks, localFallbackCandidates } from './model-fallback.js'

afterEach(() => { chain.entries = [] })

const SPARK = [
    { name: 'vllm', type: 'llm', status: 'running', endpoint: 'http://localhost:8000', models: ['qwen'] },
    { name: 'ollama', type: 'llm', status: 'installed', endpoint: 'http://localhost:11434', models: [] },
    { name: 'ollama', type: 'llm', status: 'running', endpoint: 'http://192.168.50.20:11434', models: ['llama3.2:3b'] },
]

describe('Rückfall nur auf laufende Endpunkte mit vorhandenem Modell', () => {
    it('Kette: nur Modelle, die gerade laufen; geratene Namen und „installiert“ fallen weg', () => {
        chain.entries = [
            { provider: 'ollama', model: 'qwen3.8-flash-next' },
            { provider: 'ollama', model: 'qwen' },
            { provider: 'custom', model: 'Qwen3-Next' },
        ]
        expect(getDefaultFallbacks(SPARK)).toEqual([
            { provider: 'local', model: 'qwen' },
            { provider: 'local', model: 'auto' },
        ])
    })

    it('noch kein Scan → nur „auto“ (wählt unter geprüft erreichbaren Endpunkten), kein Seed-Name', () => {
        chain.entries = [{ provider: 'ollama', model: 'qwen3.8-flash-next' }]
        expect(getDefaultFallbacks([])).toEqual([{ provider: 'local', model: 'auto' }])
    })

    it('ohne Angabe bleibt das bisherige Verhalten (Aufrufer ohne Scanner)', () => {
        chain.entries = [{ provider: 'ollama', model: 'qwen' }]
        expect(getDefaultFallbacks()).toEqual([{ provider: 'ollama', model: 'qwen' }])
    })

    it('Kandidaten: ein Modellname wird nie auf einen anderen Endpunkt gezwungen; „installiert, aus“ nie', () => {
        const entries = [
            { provider: 'vllm', model: 'qwen', endpoint: 'http://127.0.0.1:8000/v1' },
            { provider: 'ollama', model: 'qwen', endpoint: 'http://localhost:11434' },
            { provider: 'ollama', model: 'llama3.2:3b', endpoint: 'http://192.168.50.20:11434' },
            { provider: 'ollama', model: 'gemma3:4b', endpoint: 'http://192.168.50.20:11434' },
        ]
        expect(localFallbackCandidates(entries, 'qwen3.8-flash-next', SPARK)).toEqual([])
        expect(localFallbackCandidates(entries, 'qwen', SPARK).map(item => item.endpoint)).toEqual(['http://127.0.0.1:8000/v1'])
        expect(localFallbackCandidates(entries, 'auto', SPARK).map(item => `${item.model}@${item.endpoint}`)).toEqual([
            'qwen@http://127.0.0.1:8000/v1', 'llama3.2:3b@http://192.168.50.20:11434',
        ])
    })

    it('llm-factory nutzt beides mit dem Scanner-Stand', () => {
        const text = readFileSync(fileURLToPath(new URL('../core/llm-factory.ts', import.meta.url)), 'utf8')
        expect(text).toMatch(/getDefaultFallbacks\(runningServices\)/)
        expect(text).toMatch(/localFallbackCandidates\(localEntries, fallbackModel, runningServices\)/)
    })
})
