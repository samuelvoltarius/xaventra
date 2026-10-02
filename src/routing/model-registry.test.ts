import { describe, expect, it } from 'vitest'
import {
    buildModelRegistry,
    classifyPrivacy,
    hasProvenCapability,
    measurementsFromLedgerRuns,
    requiredCapability,
    type RegistryInputs,
} from './model-registry.js'

// Phase 6d: one register of every model endpoint. Capabilities count only
// with evidence ("Erkannt ≠ nutzbar", 2.79.3); names never prove anything.

const NODE_A = 'node-a'
const NODE_B = 'node-b'
const VLLM_URL = 'http://node-a.invalid:8000/v1'
const OLLAMA_URL = 'http://node-b.invalid:11434'

function baseInputs(extra: Partial<RegistryInputs> = {}): RegistryInputs {
    return {
        knownNodes: [NODE_A, NODE_B],
        vllm: [{ node: NODE_A, baseUrl: VLLM_URL, models: ['qwen-test'] }],
        ollama: [{ node: NODE_B, baseUrl: OLLAMA_URL, models: [{ name: 'llava-test', sizeBytes: 5 * 1024 ** 3 }, { name: 'vision-pro-test' }], loaded: ['llava-test'] }],
        probes: [
            { model: 'qwen-test', endpoint: VLLM_URL, online: true, supportsTools: true, supportsSystemPrompt: true, supportsVision: false, roles: ['chat', 'code', 'tools'], avgLatencyMs: 900 },
            // Name says "vision", probe found none: must not count.
            { model: 'vision-pro-test', endpoint: OLLAMA_URL, online: true, supportsTools: false, supportsSystemPrompt: true, supportsVision: false, roles: ['chat'] },
        ],
        codex: { enabled: true, model: 'codex-test', available: true },
        cloud: [
            { provider: 'anthropic', model: 'cloud-a-test', keyPresent: true, costEurPerCall: 0.02 },
            { provider: 'gemini', model: 'cloud-g-test', keyPresent: true },
            { provider: 'openai', model: 'cloud-o-test', keyPresent: false, costEurPerCall: 0.01 },
        ],
        ...extra,
    }
}

describe('model registry (Phase 6d)', () => {
    it('lists vLLM, Ollama per node, Codex and configured cloud providers with privacy class', () => {
        const registry = buildModelRegistry(baseInputs())
        const byModel = Object.fromEntries(registry.endpoints.map(ep => [ep.model, ep]))
        expect(byModel['qwen-test']).toMatchObject({ kind: 'vllm', node: NODE_A, privacy: 'lokal', costEurPerCall: 0, health: 'ok' })
        expect(byModel['llava-test']).toMatchObject({ kind: 'ollama', node: NODE_B, privacy: 'lokal', loaded: true, sizeBytes: 5 * 1024 ** 3 })
        expect(byModel['codex-test']).toMatchObject({ kind: 'codex', privacy: 'cloud' })
        expect(byModel['cloud-a-test']).toMatchObject({ kind: 'anthropic', privacy: 'cloud', costEurPerCall: 0.02 })
        // Unknown cost stays unknown (= expensive), never silently 0.
        expect(byModel['cloud-g-test'].costEurPerCall).toBeNull()
        // A provider without key is not listed.
        expect(byModel['cloud-o-test']).toBeUndefined()
    })

    it('counts capabilities only from probe, ledger or the existing rule table — never from the name', () => {
        const registry = buildModelRegistry(baseInputs())
        const ep = (model: string) => registry.endpoints.find(item => item.model === model)!
        expect(hasProvenCapability(ep('qwen-test'), 'code')).toBe(true)
        expect(hasProvenCapability(ep('qwen-test'), 'vision')).toBe(false)
        expect(hasProvenCapability(ep('vision-pro-test'), 'vision')).toBe(false)
        // Cloud model without probe: nothing proven.
        expect(hasProvenCapability(ep('cloud-a-test'), 'chat')).toBe(false)
        // Codex: code work proven by the fixed table (R8), not by a probe.
        expect(ep('codex-test').capabilities).toContainEqual(expect.objectContaining({ capability: 'code', source: 'regel' }))
    })

    it('treats an end-to-end ledger success as proof (vision on the production path)', () => {
        const runs = [1, 2, 3].map(index => ({
            runId: `r${index}`, status: 'completed', model: 'llava-test', node: NODE_B,
            startedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:02.000Z',
            userId: 'owner@example.com', channel: 'telegram', contract: { id: `r${index}` },
            validation: { success: true, validator: 'nova-execution-kernel' },
            events: [{ type: 'route.selected', payload: { modelClass: 'vision' } }],
        }))
        const registry = buildModelRegistry(baseInputs({ ledgerRuns: runs as any }))
        const llava = registry.endpoints.find(item => item.model === 'llava-test')!
        expect(hasProvenCapability(llava, 'vision')).toBe(true)
        expect(llava.measurements).toContainEqual(expect.objectContaining({ taskClass: 'vision', samples: 3, successRate: 1, avgLatencyMs: 2000, source: 'ledger' }))
    })

    it('derives success rate and latency per task class from the Outcome-Ledger, ignoring running/invalidated runs', () => {
        const mk = (id: string, status: string, ok: boolean, ms: number, extra: Record<string, unknown> = {}) => ({
            runId: id, status, model: 'qwen-test', node: NODE_A,
            startedAt: '2026-10-01T10:00:00.000Z', updatedAt: new Date(Date.parse('2026-10-01T10:00:00.000Z') + ms).toISOString(),
            userId: 'owner@example.com', channel: 'telegram', contract: { id },
            validation: status === 'running' ? undefined : { success: ok, validator: 'nova-execution-kernel' },
            events: [{ type: 'route.selected', payload: { modelClass: 'code' } }], ...extra,
        })
        const cells = measurementsFromLedgerRuns([
            mk('a', 'completed', true, 1000), mk('b', 'completed', true, 3000), mk('c', 'failed', false, 2000),
            mk('d', 'running', false, 500), mk('e', 'completed', true, 100, { invalidated: true }),
        ] as any)
        expect(cells).toHaveLength(1)
        expect(cells[0]).toMatchObject({ model: 'qwen-test', node: NODE_A, measurement: { taskClass: 'code', samples: 3, successes: 2, avgLatencyMs: 2000 } })
        expect(cells[0].measurement.successRate).toBeCloseTo(2 / 3)
    })

    it('marks unreachable endpoints as down and maps scout results to general work', () => {
        const registry = buildModelRegistry(baseInputs({
            probes: [{ model: 'qwen-test', endpoint: VLLM_URL, online: false, supportsTools: false, supportsSystemPrompt: false, roles: [] }],
            scout: { results: [{ model: 'qwen-test', passed: 9, total: 10, score: 0.9, avgLatencyMs: 1200 }] },
        }))
        const qwen = registry.endpoints.find(item => item.model === 'qwen-test')!
        expect(qwen.health).toBe('down')
        expect(qwen.measurements).toContainEqual(expect.objectContaining({ taskClass: 'general', samples: 10, successRate: 0.9, source: 'scout' }))
    })

    it('classifies privacy conservatively: local only for local runtimes on known nodes or private hosts', () => {
        expect(classifyPrivacy('vllm', 'http://unknown-host.invalid:8000', 'node-a', ['node-a'])).toBe('lokal')
        expect(classifyPrivacy('ollama', 'http://127.0.0.1:11434', undefined, [])).toBe('lokal')
        expect(classifyPrivacy('ollama', 'http://10.1.2.3:11434', undefined, [])).toBe('lokal')
        // A "local" runtime on a public host without node is not provably local.
        expect(classifyPrivacy('vllm', 'https://models.example.com/v1', undefined, [])).toBe('cloud')
        expect(classifyPrivacy('codex', undefined, undefined, [])).toBe('cloud')
        expect(classifyPrivacy('anthropic', undefined, undefined, [])).toBe('cloud')
    })

    it('names the capability each task class needs', () => {
        expect(requiredCapability('vision')).toBe('vision')
        expect(requiredCapability('code')).toBe('code')
        expect(requiredCapability('debug')).toBe('code')
        expect(requiredCapability('smalltalk')).toBe('chat')
    })
})
