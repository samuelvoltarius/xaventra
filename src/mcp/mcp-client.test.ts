import { describe, expect, it } from 'vitest'
import { MCPClient } from './mcp-client.js'

describe('modern MCP gateway policy', () => {
    it('rejects insecure remote HTTP transports', async () => {
        const client = new MCPClient()
        await expect(client.connectServer({ name: 'bad', transport: 'http', url: 'http://example.com/mcp' }))
            .rejects.toThrow(/HTTPS/)
    })

    it('keeps disconnected catalogs empty and credentials out of state', () => {
        const client = new MCPClient()
        client.registerOAuthProvider('private', {} as any)
        expect(client.listServers()).toEqual([])
    })
})
