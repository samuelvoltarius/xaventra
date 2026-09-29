import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createQuorumWitnessServer } from './quorum-witness.js'

// TOK-3 / MI-21: a captured, correctly signed witness request must not be
// accepted a second time inside the 30-second timestamp window.

const servers: ReturnType<typeof createQuorumWitnessServer>[] = []
afterEach(async () => {
    await Promise.all(servers.splice(0).map(instance => new Promise<void>(resolve => instance.server.close(() => resolve()))))
})

describe('TOK-3 witness request replay', () => {
    it('accepts a signed lease request once and rejects its replay', async () => {
        const secret = 'witness-replay-secret-0123456789'
        const instance = createQuorumWitnessServer({ witnessId: 'w1', secret, stateFile: join(mkdtempSync(join(tmpdir(), 'nova-tok3-')), 'w1.json') })
        servers.push(instance)
        const port = await instance.listen()
        const body = JSON.stringify({ service: 'telegram', nodeId: 'node-a', holderHostname: 'a', ttlMs: 5000, requestId: 'req-0001' })
        const timestamp = String(Date.now())
        const headers = {
            'content-type': 'application/json', 'x-nova-timestamp': timestamp,
            'x-nova-signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
        }
        const send = () => fetch(`http://127.0.0.1:${port}/v1/lease/acquire`, { method: 'POST', headers, body })
        expect((await send()).status).toBe(200)
        const replay = await send()
        expect(replay.status).toBe(401)
        expect(await replay.json()).toMatchObject({ error: 'replayed witness request' })

        // A fresh request (new nonce/timestamp) from the same holder still works.
        const body2 = JSON.stringify({ service: 'telegram', nodeId: 'node-a', holderHostname: 'a', ttlMs: 5000, requestId: 'req-0002' })
        const ts2 = String(Date.now())
        const fresh = await fetch(`http://127.0.0.1:${port}/v1/lease/acquire`, {
            method: 'POST', body: body2,
            headers: { 'content-type': 'application/json', 'x-nova-timestamp': ts2, 'x-nova-signature': createHmac('sha256', secret).update(`${ts2}.${body2}`).digest('hex') },
        })
        expect(fresh.status).toBe(200)
    })
})
