import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MeshIdentity } from './mesh-identity.js'
import { startMeshRelayServer, type MeshRelayServer } from './relay-server.js'

// TOK-2 / MI-13: relay tokens are bound to a node. A compromised worker can
// neither read nor acknowledge Main's inbox, nor post envelopes as another node.

const active: MeshRelayServer[] = []
afterEach(async () => { while (active.length) await active.pop()!.close() })

const tokenFor = (node: string) => [`relay-node-${node}-`, 'credential-0123456789abcdef'].join('')
const main = new MeshIdentity('main', mkdtempSync(join(tmpdir(), 'nova-tok2-main-')))
const worker = new MeshIdentity('pi5', mkdtempSync(join(tmpdir(), 'nova-tok2-pi5-')))
const auth = (node: string) => ({ authorization: `Bearer ${tokenFor(node)}`, 'content-type': 'application/json' })

async function relay(extra: Record<string, unknown> = {}) {
    const server = await startMeshRelayServer({
        host: '127.0.0.1', port: 0, token: ['relay-storage-', 'key-material-0123456789'].join(''),
        dataFile: join(mkdtempSync(join(tmpdir(), 'nova-tok2-')), 'queue.enc.json'),
        nodeTokens: { main: tokenFor('main'), pi5: tokenFor('pi5') }, ...extra,
    })
    active.push(server)
    return server
}
const result = (source: MeshIdentity, target: string, n: number) => source.create({
    kind: 'run.result', targetNode: target, principal: { id: `node:${source.nodeId}`, role: 'system' },
    payload: { requestId: `request-${n}`, success: true, evidence: [] },
})

describe('TOK-2 relay node binding', () => {
    it('refuses to start with only the unbound shared token', async () => {
        await expect(startMeshRelayServer({ host: '127.0.0.1', port: 0, token: 'x'.repeat(32), dataFile: join(mkdtempSync(join(tmpdir(), 'nova-tok2-')), 'q.json') }))
            .rejects.toThrow(/per-node tokens/)
    })

    it('a node reads and acknowledges only its own inbox', async () => {
        const server = await relay()
        const post = await fetch(`${server.url}/envelopes`, { method: 'POST', headers: auth('pi5'), body: JSON.stringify({ to: 'main', envelope: result(worker, 'main', 1) }) })
        expect(post.status).toBe(202)
        expect((await fetch(`${server.url}/envelopes?to=main`, { headers: auth('pi5') })).status).toBe(403)
        const rows = await (await fetch(`${server.url}/envelopes?to=main`, { headers: auth('main') })).json() as Array<{ receipt: string }>
        expect(rows).toHaveLength(1)
        expect((await fetch(`${server.url}/envelopes/${rows[0].receipt}/ack`, { method: 'POST', headers: auth('pi5') })).status).toBe(404)
        expect((await fetch(`${server.url}/envelopes/${rows[0].receipt}/ack`, { method: 'POST', headers: auth('main') })).status).toBe(200)
    })

    it('a node cannot post envelopes signed as another node', async () => {
        const server = await relay()
        const forged = await fetch(`${server.url}/envelopes`, { method: 'POST', headers: auth('pi5'), body: JSON.stringify({ to: 'pi5', envelope: result(main, 'pi5', 2) }) })
        expect(forged.status).toBe(403)
    })

    it('verifies posts against pinned peer keys when configured', async () => {
        const server = await relay({ peerKeys: { main: main.publicKey, pi5: main.publicKey } })
        const selfSigned = await fetch(`${server.url}/envelopes`, { method: 'POST', headers: auth('pi5'), body: JSON.stringify({ to: 'main', envelope: result(worker, 'main', 3) }) })
        expect(selfSigned.status).toBe(400)
    })
})
