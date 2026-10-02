import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuorumWitnessStore } from './quorum-witness.js'
import { createHttpWitnessClient } from './witness-quorum.js'

const sign = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('hex')

afterEach(() => vi.unstubAllGlobals())

describe('HTTP witness client for the succession (no network: fetch is stubbed)', () => {
    it('acquires, peeks and releases with authenticated requests and responses', async () => {
        const secret = ['succession-witness-', 'test-value'].join('')
        const store = new QuorumWitnessStore('w1', join(mkdtempSync(join(tmpdir(), 'xaventra-http-witness-')), 'w1.json'))
        let forgeResponses = false
        vi.stubGlobal('fetch', async (url: string, init: { body: string; headers: Record<string, string> }) => {
            const path = new URL(url).pathname
            const signature = init.headers['x-nova-signature']
            if (signature !== sign(secret, `${init.headers['x-nova-timestamp']}.${init.body}`)) return new Response('', { status: 401 })
            const input = JSON.parse(init.body)
            const result = path === '/v1/lease/acquire' ? store.acquire(input)
                : path === '/v1/lease/peek' ? { requestId: input.requestId, lease: store.peek(input.service) }
                    : { requestId: input.requestId, released: store.release(input) }
            const body = JSON.stringify(result)
            return new Response(body, { status: 200, headers: { 'x-nova-witness-id': 'w1', 'x-nova-signature': forgeResponses ? sign('wrong-secret-value-xx', body) : sign(secret, body) } })
        })
        const client = createHttpWitnessClient({ id: 'w1', url: 'https://witness.example.com', secret })
        expect(await client.peek('nova-main')).toBeNull()
        const decision = await client.acquire({ service: 'nova-main', nodeId: 'spark', holderHostname: 'spark.example.com', ttlMs: 30_000, requestId: 'r1', proposedEpoch: 0 })
        expect(decision?.leader).toBe(true)
        expect((await client.peek('nova-main'))?.holderNodeId).toBe('spark')
        expect(await client.release({ service: 'nova-main', nodeId: 'ns1', epoch: decision!.epoch! })).toBe(false)
        expect(await client.release({ service: 'nova-main', nodeId: 'spark', epoch: decision!.epoch! })).toBe(true)
        forgeResponses = true
        expect(await client.peek('nova-main')).toBeUndefined()
        expect(() => createHttpWitnessClient({ id: 'w2', url: 'https://witness.example.com', secret: 'short' })).toThrow(/16/)
    })
})
