import { describe, expect, it } from 'vitest'
import { isValidCapabilityName, researchCapability, researchResultToSetupAction, type CapabilityResearchResult } from './capability-researcher.js'

// K2 regression: capability names are untrusted (slash args / LLM output) and
// must never be interpolated into shell strings.

const node = { name: 'remote-node', host: 'remote.example', online: true, capabilities: [], services: {}, canInstall: [], recommendedFor: [], ollamaModels: [] } as any

function result(overrides: Partial<CapabilityResearchResult> = {}): CapabilityResearchResult {
    return {
        capability: 'stt', nodeName: 'remote-node', nodeHost: 'remote.example', os: 'linux', hardware: '{}',
        recommended: { name: 'x', installCommand: 'echo $(id) `id` "quoted" \'single\'', rationale: 'r' },
        alternatives: [], researchedAt: new Date().toISOString(), confidence: 'low', ...overrides,
    }
}

describe('capability researcher shell safety (K2)', () => {
    it('validates capability names', () => {
        expect(isValidCapabilityName('stt')).toBe(true)
        expect(isValidCapabilityName('whisper_cpp-2')).toBe(true)
        for (const bad of ['', 'STT', 'a b', 'x";touch /tmp/p;"', '$(id)', 'a'.repeat(41), '../x']) {
            expect(isValidCapabilityName(bad), bad).toBe(false)
        }
    })

    it('refuses to research an invalid capability', async () => {
        await expect(researchCapability('x";touch /tmp/p;"', node, { skipWeb: true, force: true })).rejects.toThrow(/capability/i)
    })

    it('does not interpolate the capability into the static fallback command', async () => {
        const res = await researchCapability('unknowncap', { ...node, name: 'n1' }, { skipWeb: true, force: true })
        expect(res.recommended.installCommand).not.toContain('unknowncap')
    })

    it('never turns a researched install command into an executable action (Stufe 1)', () => {
        for (const overrides of [{}, { nodeName: 'localhost', nodeHost: 'localhost' }, { nodeHost: '-oProxyCommand=touch /tmp/p' }, { nodeHost: 'host;id' }]) {
            const action = researchResultToSetupAction(result(overrides))
            expect(action.command, JSON.stringify(overrides)).toBeUndefined()
            // The recommendation stays visible as text for the owner.
            expect(action.research?.installMethod).toBe(result().recommended.installCommand)
        }
    })

    it('refuses to build actions for invalid capability names', () => {
        expect(() => researchResultToSetupAction(result({ capability: 'x;id' }))).toThrow(/capability/i)
    })
})
