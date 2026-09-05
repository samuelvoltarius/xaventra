import { describe, expect, it } from 'vitest'
import { initializeMCPRuntime } from './mcp-runtime.js'

describe('MCP runtime integration', () => {
    it('reports failed servers without blocking Nova startup', async () => {
        const result = await initializeMCPRuntime([{ name: 'invalid', transport: 'http', url: 'http://example.com/mcp' }])
        expect(result.connected).toEqual([])
        expect(result.failed[0]?.name).toBe('invalid')
    })
})
