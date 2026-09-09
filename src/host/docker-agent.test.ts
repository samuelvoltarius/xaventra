import { afterEach, beforeEach, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDockerHostAgent, permitBytes, type DockerPermit } from './docker-agent.js'

const id = 'a'.repeat(64), token = 'synthetic-test-token-'.repeat(3)
const keys = generateKeyPairSync('ed25519')
let server: ReturnType<typeof createDockerHostAgent>, base: string, calls: string[], running: boolean, failPost: boolean
beforeEach(async () => {
    calls = []; running = true; failPost = false
    server = createDockerHostAgent({ nodeId: 'fixture', clientId: 'fixture-client', token,
        stateDir: mkdtempSync(join(tmpdir(), 'host-agent-test-')), allowedContainerIds: [id],
        approvalPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, {
        call: async (method, path) => {
            calls.push(`${method} ${path}`)
            if (path.startsWith('/containers/json')) return [{ Id: id, Names: ['/fixture'], Image: 'fixture', State: 'running', Status: 'Up', Labels: { secret: 'NOT-EXPORTED' } }]
            if (path.endsWith('/json')) return { Id: id, Name: '/fixture', Config: { Env: ['SERVICE_TOKEN=unusual-log-secret'] }, State: { Running: running, Status: running ? 'running' : 'exited', StartedAt: String(calls.filter(c => c.startsWith('POST')).length) }, RestartCount: 0 }
            if (path.includes('/logs?')) return 'SERVICE_TOKEN=unusual-log-secret sk-proj-1234567890123456789012345'
            if (method === 'POST') { running = !path.includes('/stop'); if (failPost) throw Error('uncertain transport'); return null }
            throw Error('Unexpected Docker path')
        },
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
async function call(op: string, body: any = {}, auth = token) {
    const res = await fetch(`${base}/v1/docker/${op}`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
}
function approval(overrides: Partial<DockerPermit> = {}) {
    const permit: DockerPermit = { id: 'fixture-operation-0001', nodeId: 'fixture', clientId: 'fixture-client', containerId: id, action: 'stop', approvedBy: 'cli:owner', expiresAt: Date.now() + 60_000, ...overrides }
    return { permit, signature: sign(null, permitBytes(permit), keys.privateKey).toString('base64') }
}
it('denies unauthenticated requests before touching Docker', async () => {
    expect((await call('list', {}, 'wrong')).status).toBe(401); expect(calls).toEqual([])
})
it('exports only bounded inventory fields, with observation receipt', async () => {
    const result = await call('list')
    expect(result.body).toMatchObject({ success: true, nodeId: 'fixture', operation: 'docker.list', count: 1 })
    expect(result.body.evidenceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(result.body)).not.toContain('NOT-EXPORTED')
})
it('does not accept free API paths, commands, names or all string coercion', async () => {
    for (const [op, body] of [['exec', {}], ['list', { command: 'anything' }], ['list', { all: 'false' }], ['status', { containerId: 'fixture;id' }]] as const) expect((await call(op, body)).body.success).toBe(false)
    expect(calls).toEqual([])
})
it('status never exports container environment', async () => {
    const result = await call('status', { containerId: id })
    expect(result.body.running).toBe(true); expect(JSON.stringify(result.body)).not.toContain('SERVICE_TOKEN')
})
it('redacts exact environment secrets from bounded logs', async () => {
    const result = await call('logs', { containerId: id, lines: 10 })
    expect(result.body.success).toBe(true); expect(result.body.logs).not.toContain('unusual-log-secret'); expect(result.body.logs).not.toContain('sk-proj-123')
    expect((await call('logs', { containerId: id, lines: 201 })).body.success).toBe(false)
})
it('rejects missing, forged, expired and wrong-node/client approvals', async () => {
    for (const body of [{}, { ...approval(), signature: 'bad' }, approval({ expiresAt: Date.now() - 1 }), approval({ nodeId: 'other' }), approval({ clientId: 'other' }), approval({ containerId: 'b'.repeat(64) })]) expect((await call('action', body)).body.success).toBe(false)
    expect(calls).toEqual([])
})
it('verifies a signed exact stop and replays receipt without repeating mutation', async () => {
    const body = approval()
    const one = await call('action', body), two = await call('action', body)
    expect(one.body).toMatchObject({ success: true, operation: 'docker.stop', containerId: id, running: false })
    expect(two.body).toEqual(one.body); expect(calls.filter(c => c.startsWith('POST'))).toHaveLength(1)
})
it('refuses an approval ID reused for a different action', async () => {
    await call('action', approval())
    expect((await call('action', approval({ action: 'start' }))).body.error).toContain('reused')
    expect(calls.filter(c => c.startsWith('POST'))).toHaveLength(1)
})
it('never repeats a possibly executed action after lost acknowledgement', async () => {
    failPost = true; const body = approval()
    expect((await call('action', body)).body.success).toBe(false)
    failPost = false
    expect((await call('action', body)).body.error).toContain('uncertain')
    expect(calls.filter(c => c.startsWith('POST'))).toHaveLength(1)
})
it('confirms actual restart generation', async () => {
    expect((await call('action', approval({ action: 'restart' }))).body).toMatchObject({ success: true, running: true })
})
