import { describe, expect, it } from 'vitest'
import { createNovaLLMClient } from './nova-llm-sdk.js'

describe('provider readiness failover', () => {
    it('never configures MiniMax when the provider has no credential', async () => {
        const client = await createNovaLLMClient({ provider: 'minimax', model: 'MiniMax-M3', apiKey: '' })
        expect(client.providerId).toBe('local')
        expect(client.modelId).not.toBe('MiniMax-M3')
    })
})
