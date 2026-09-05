import { describe, expect, it } from 'vitest'
import { ExternalAgentAdapter } from './external-agent-adapters.js'
import type { BenchmarkScenario } from './benchmark-lab.js'

const scenario: BenchmarkScenario = {
    id: 'external-unavailable', category: 'tools', title: 'Unavailable', prompt: 'No-op',
    requiredEvidence: ['tool result'], timeoutMs: 1_000, destructive: false,
}

describe('ExternalAgentAdapter', () => {
    it('marks missing executables unavailable instead of fabricating a score', async () => {
        const adapter = new ExternalAgentAdapter({ name: 'nova', command: '__nova_missing_agent__', args: () => [], versionArgs: ['--version'] })
        const result = await adapter.execute(scenario)
        expect(result.available).toBe(false)
        expect(result.success).toBe(false)
        expect(result.toolExecuted).toBe(false)
    })
})
