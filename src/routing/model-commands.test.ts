import { describe, expect, it } from 'vitest'
import { NovaConfigSchema } from '../core/config.js'
import { getCommandMinimumRole } from '../core/slash-commands.js'
import { formatModelRegistry } from './model-commands.js'
import { buildModelRegistry } from './model-registry.js'
import { readMultiRouteSettings } from './task-model-routing.js'

// Phase 6d /modelle: owner-only view of the register and the current choice.

const registry = buildModelRegistry({
    knownNodes: ['node-a'],
    vllm: [{ node: 'node-a', baseUrl: 'http://node-a.invalid:8000/v1', models: ['local-a'] }],
    probes: [{ model: 'local-a', endpoint: 'http://node-a.invalid:8000/v1', online: true, supportsTools: true, supportsSystemPrompt: true, roles: ['chat', 'code'] }],
    codex: { enabled: false, model: 'codex-test' },
    cloud: [{ provider: 'anthropic', model: 'cloud-a', keyPresent: true }],
})

describe('/modelle', () => {
    it('is owner-only (not opened in COMMAND_MINIMUM_ROLE)', () => {
        expect(getCommandMinimumRole('modelle')).toBe('owner')
    })

    it('shows register, privacy, proven capabilities, cost and the R1–R8 choice when off', () => {
        const text = formatModelRegistry(registry, readMultiRouteSettings({}), { codex: { enabled: false } })
        expect(text).toMatch(/Multi-Router: aus/)
        expect(text).toMatch(/R1–R8/)
        expect(text).toMatch(/`local-a` — vllm auf node-a · lokal · 0 €/)
        expect(text).toMatch(/chat \(Probe\), code \(Probe\)/)
        expect(text).toMatch(/`cloud-a` — anthropic · cloud · Kosten unbekannt/)
        expect(text).toMatch(/Code → lokal \(R5-disabled\)/)
        expect(text).toMatch(/Bilder\/Vision → lokal \(R1-vision-local\)/)
        expect(text).toMatch(/Tagesbudget: 0 €/)
    })
})

describe('config schema routing.multi', () => {
    it('is optional (old configs parse unchanged) and defaults to off / 0 € when present', () => {
        const plain = NovaConfigSchema.parse({})
        expect((plain as any).routing).toBeUndefined()
        const parsed: any = NovaConfigSchema.parse({ routing: { multi: { enabled: true } } })
        expect(parsed.routing.multi).toMatchObject({ enabled: true, cloudDailyBudgetEur: 0, minSamples: 5, cloudModels: [], costs: {} })
        expect(NovaConfigSchema.safeParse({ routing: { multi: { cloudDailyBudgetEur: -1 } } }).success).toBe(false)
    })
})
