/**
 * 2.84.0 Punkt 8: Der Modell-Scout lebt. Ein Runner aus vorhandenen Teilen
 * misst installierte lokale Modelle mit dem Prüfsatz; ein Wechselvorschlag
 * entsteht nur für ein Ziel der vLLM-Wechselliste. Reine Hugging-Face-
 * Kandidaten werden Idee im Bericht, keine Karte. Die Ergebnisse landen über
 * scout-report.json in den Registry-Messungen.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { buildModelRegistry, type ModelRegistry } from '../routing/model-registry.js'
import { runModelScout, type ModelCandidate } from './model-scout.js'
import { createScoutRunner } from './scout-runner.js'
import type { ProbeCase } from './probe-set.js'
import { MemoryThoughtSink, parseThinkingSettings, type LoadSample } from './ports.js'

const IDLE: LoadSample = { measured: true, gpuUtilPercent: 2, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] }
const load = { sample: async () => IDLE }
const settings = parseThinkingSettings({ enabled: true, scout: { enabled: true, memoryBudgetGB: 96, minImprovementPercent: 5 } })
const probes: ProbeCase[] = [
    { id: 'p1', origin: 'alltag', prompt: 'Was ist 17 mal 23? Nur die Zahl.', expect: { kind: 'contains-any', values: ['391'] } },
    { id: 'p2', origin: 'alltag', prompt: 'Hauptstadt von Österreich?', expect: { kind: 'contains-any', values: ['Wien'] } },
    { id: 'p3', origin: 'alltag', prompt: 'Welcher Tag folgt auf Freitag?', expect: { kind: 'contains-any', values: ['Samstag'] } },
    { id: 'p4', origin: 'alltag', prompt: 'Wie viele Minuten hat ein Tag?', expect: { kind: 'contains-any', values: ['1440'] } },
]
const ANSWERS: Record<string, string> = { p1: '391', p2: 'Wien', p3: 'Samstag', p4: '1440' }

/** Spark-vLLM serves model A (current); a second local node serves model B. Cloud is never measured. */
const registry = (): ModelRegistry => buildModelRegistry({
    knownNodes: ['spark', 'nas'],
    vllm: [{ node: 'spark', baseUrl: 'http://127.0.0.1:8000/v1', models: ['org/model-a'] }],
    ollama: [{ node: 'nas', baseUrl: 'http://127.0.0.1:11434', models: [{ name: 'model-b', sizeBytes: 4e9 }], loaded: ['model-b'] }],
    cloud: [{ provider: 'openai', model: 'cloud-x', keyPresent: true, costEurPerCall: 0.01 }],
})
/** Model A answers 2 of 4 probes, model B all 4; every call is recorded. */
function clients() {
    const calls: string[] = []
    const factory = vi.fn(async (endpoint: { model: string; baseUrl?: string }) => ({
        async complete(messages: Array<{ role: string; content: string }>) {
            calls.push(endpoint.model)
            const probe = probes.find(item => item.prompt === messages.at(-1)?.content)!
            const good = endpoint.model === 'model-b' || probe.id === 'p1' || probe.id === 'p2'
            return { content: good ? ANSWERS[probe.id] : 'weiß nicht' }
        },
    }))
    return { calls, factory }
}
const hf = (id: string): ModelCandidate => ({ id, source: 'test', license: 'apache-2.0', paramsB: 8, quant: 'bf16', libraries: ['transformers'], tags: ['safetensors'] })
const reportPath = () => join(mkdtempSync(join(process.cwd(), 'scout-lebt-')), 'scout-report.json')

describe('Punkt 8: der Scout misst installierte Modelle', () => {
    it('Runner misst A und B lokal; B ist besser und steht auf der Wechselliste → modell-wechsel mit dem Zielnamen', async () => {
        const { calls, factory } = clients()
        const runner = createScoutRunner({ registry: async () => registry(), client: factory, targets: async () => [{ target: 'nano', modelId: 'model-b' }, { target: 'qwen27', modelId: 'org/model-a' }] })
        const sink = new MemoryThoughtSink()
        const result = await runModelScout({ settings, load, sink, probes, runner, currentModel: 'org/model-a', sources: [], reportPath: reportPath() })
        expect(result.proposal?.kind).toBe('modell-wechsel')
        expect(result.proposal?.proposal).toMatchObject({ action: 'modell-wechsel', params: { modell: 'nano', von: 'org/model-a' }, autoExecute: false })
        expect(result.proposal?.stufe).toBe('fragen')
        expect(result.report?.results).toEqual([
            expect.objectContaining({ model: 'org/model-a', passed: 2, total: 4 }),
            expect.objectContaining({ model: 'model-b', passed: 4, total: 4 }),
        ])
        expect(calls).not.toContain('cloud-x')
    })

    it('Gegenprobe: ohne Runner bleibt der Scout „ungetestet“ (heutiger Stand)', async () => {
        const result = await runModelScout({ settings, load, sink: new MemoryThoughtSink(), probes, currentModel: 'org/model-a', sources: [{ name: 'test', list: async () => [hf('org/neu-8b')] }], reportPath: reportPath() })
        expect(result.proposal).toBeUndefined()
        expect(result.reason).toMatch(/ungetestet/)
    })

    it('besser, aber kein Ziel der Wechselliste → Idee, kein Vorschlag', async () => {
        const { factory } = clients()
        const runner = createScoutRunner({ registry: async () => registry(), client: factory, targets: async () => [{ target: 'qwen27', modelId: 'org/model-a' }] })
        const sink = new MemoryThoughtSink()
        const result = await runModelScout({ settings, load, sink, probes, runner, currentModel: 'org/model-a', sources: [], reportPath: reportPath() })
        expect(result.proposal).toBeUndefined()
        expect(sink.thoughts.filter(item => item.stufe === 'fragen')).toHaveLength(0)
        expect(sink.thoughts.some(item => /model-b/.test(item.text) && /Wechselliste/.test(item.text))).toBe(true)
    })

    it('reiner HF-Kandidat (nicht installiert, nicht auf der Liste) → Gedanke Idee, keine Karte, nicht gemessen', async () => {
        const { calls, factory } = clients()
        const runner = createScoutRunner({ registry: async () => registry(), client: factory, targets: async () => [{ target: 'qwen27', modelId: 'org/model-a' }] })
        const sink = new MemoryThoughtSink()
        const result = await runModelScout({ settings, load, sink, probes, runner, currentModel: 'org/model-a', sources: [{ name: 'test', list: async () => [hf('org/neu-8b')] }], reportPath: reportPath() })
        expect(calls).not.toContain('org/neu-8b')
        expect(result.report?.results.map(item => item.model)).not.toContain('org/neu-8b')
        expect(result.report?.ideas).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'org/neu-8b', reason: expect.stringMatching(/nicht installiert/) })]))
        const idea = sink.thoughts.find(item => item.text.includes('org/neu-8b'))
        expect(idea?.stufe).toBe('selbst')
        expect(idea?.proposal).toBeUndefined()
        // 2.86 Punkt 8: keine Config-Arbeit für den Owner mehr, sondern Katalogpflege durch Claude.
        expect(idea?.text).toMatch(/Katalogpflege/)
        expect(idea?.text).not.toMatch(/routing\.vllm\.targets/)
        expect(sink.thoughts.filter(item => item.kind === 'modell-wechsel').every(item => !item.text.includes('org/neu-8b'))).toBe(true)
    })

    it('die Registry liest die Scout-Ergebnisse als Messung source: scout', async () => {
        const { factory } = clients()
        const runner = createScoutRunner({ registry: async () => registry(), client: factory, targets: async () => [{ target: 'nano', modelId: 'model-b' }] })
        const path = reportPath()
        await runModelScout({ settings, load, sink: new MemoryThoughtSink(), probes, runner, currentModel: 'org/model-a', sources: [], reportPath: path })
        const withScout = buildModelRegistry({
            knownNodes: ['nas'], ollama: [{ node: 'nas', baseUrl: 'http://127.0.0.1:11434', models: [{ name: 'model-b' }] }],
            scout: JSON.parse(readFileSync(path, 'utf8')),
        })
        expect(withScout.endpoints[0].measurements).toContainEqual(expect.objectContaining({ taskClass: 'general', samples: 4, successes: 4, source: 'scout' }))
    })

    it('ein installiertes, nicht geladenes Ollama-Modell wird mit Speicherprüfung geladen, gemessen und wieder entladen', async () => {
        const reg = buildModelRegistry({
            knownNodes: ['spark', 'nas'],
            vllm: [{ node: 'spark', baseUrl: 'http://127.0.0.1:8000/v1', models: ['org/model-a'] }],
            ollama: [{ node: 'nas', baseUrl: 'http://127.0.0.1:11434', models: [{ name: 'model-b', sizeBytes: 4e9 }], loaded: [] }],
        })
        const port = {
            tags: vi.fn(async () => [{ name: 'model-b', sizeBytes: 4e9 }]),
            ps: vi.fn(async () => []),
            keepAlive: vi.fn(async () => undefined),
            pull: vi.fn(async () => undefined),
        }
        const { factory } = clients()
        const runner = createScoutRunner({
            registry: async () => reg, client: factory, targets: async () => [],
            ollama: { port, memory: async () => ({ nodeId: 'nas', totalBytes: 64e9, freeBytes: 48e9, memoryStatus: 'ok', vllmNode: false }) },
        })
        const value = await runner.evaluate('model-b', probes, new AbortController().signal)
        expect(value).toMatchObject({ model: 'model-b', passed: 4, total: 4 })
        expect(port.keepAlive.mock.calls.map(call => (call as unknown[])[2])).toEqual(['10m', 0])
        expect(port.pull).not.toHaveBeenCalled()
        await expect(runner.evaluate('cloud-x', probes, new AbortController().signal)).rejects.toThrow(/lokal/)
    })

    it('der Daemon schließt den Runner an (nur Main, neben setIdeaFormulator)', () => {
        const source = readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')
        const hook = source.indexOf('setScoutRunner(await createProductionScoutRunner())')
        expect(hook).toBeGreaterThan(0)
        expect(source.slice(source.lastIndexOf('setIdeaFormulator(', hook), hook)).toMatch(/if \(!isAutonomyWorker\(\)\)/)
    })
})
