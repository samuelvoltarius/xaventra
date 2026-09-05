import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { MeshIdentity } from './mesh-identity.js'
import { isSafeMeshKind, type MeshEnvelope } from './transport-contracts.js'

interface RelayItem {
    id: string
    to: string
    envelope: MeshEnvelope
    createdAt: number
    expiresAt: number
    receipts: Record<string, string>
    ackedBy: string[]
}

interface RelayStore { version: 1; items: RelayItem[] }
interface EncryptedStore { version: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; data: string }

export interface MeshRelayServerOptions {
    host?: string
    port?: number
    token: string
    storageKey?: string
    dataFile?: string
    maxBodyBytes?: number
    maxItems?: number
    maxTtlMs?: number
}

export interface MeshRelayServer {
    server: Server
    url: string
    close(): Promise<void>
}

const NODE_ID = /^[a-zA-Z0-9._:-]{1,160}$/
const STATE_UPDATE_KINDS = new Set(['node.heartbeat', 'node.capabilities', 'node.tools'])

function json(response: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' })
    response.end(data)
}

function authorized(request: IncomingMessage, token: string): boolean {
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
    const expectedHash = createHash('sha256').update(token).digest()
    const suppliedHash = createHash('sha256').update(supplied).digest()
    return supplied.length > 0 && timingSafeEqual(expectedHash, suppliedHash)
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > limit) throw new Error('body_too_large')
        chunks.push(buffer)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new Error('invalid_json') }
}

function encryptionKey(token: string, storageKey?: string): Buffer {
    return createHash('sha256').update(storageKey || token).digest()
}

function loadStore(path: string, key: Buffer): RelayStore {
    if (!existsSync(path)) return { version: 1, items: [] }
    const encrypted = JSON.parse(readFileSync(path, 'utf8')) as EncryptedStore
    if (encrypted.version !== 1 || encrypted.algorithm !== 'aes-256-gcm') throw new Error('unsupported relay store format')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64url')), decipher.final()])
    const store = JSON.parse(plaintext.toString('utf8')) as RelayStore
    if (store.version !== 1 || !Array.isArray(store.items)) throw new Error('invalid relay store')
    return store
}

function persistStore(path: string, key: Buffer, store: RelayStore): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(store)), cipher.final()])
    const payload: EncryptedStore = {
        version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url'),
    }
    const directory = dirname(path)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 })
    renameSync(temporary, path)
}

export async function startMeshRelayServer(options: MeshRelayServerOptions): Promise<MeshRelayServer> {
    if (!options.token || options.token.length < 24) throw new Error('relay token must contain at least 24 characters')
    const host = options.host || '127.0.0.1'
    const port = options.port ?? 3310
    const dataFile = options.dataFile || join(getNovaDataDir(), 'relay', 'queue.enc.json')
    const key = encryptionKey(options.token, options.storageKey)
    const store = loadStore(dataFile, key)
    const peers = new Map<string, number>()
    const maxBody = options.maxBodyBytes || 1024 * 1024
    const maxItems = options.maxItems || 10_000
    const maxTtl = options.maxTtlMs || 24 * 60 * 60_000

    const prune = () => {
        const before = store.items.length
        store.items = store.items.filter(item => item.expiresAt > Date.now())
        const latestState = new Map<string, RelayItem>()
        const durable: RelayItem[] = []
        for (const item of store.items) {
            if (!STATE_UPDATE_KINDS.has(item.envelope.kind)) { durable.push(item); continue }
            const stateKey = `${item.envelope.sourceNode}:${item.to}:${item.envelope.kind}`
            const previous = latestState.get(stateKey)
            if (!previous || previous.createdAt < item.createdAt) latestState.set(stateKey, item)
        }
        store.items = [...durable, ...latestState.values()]
        if (before !== store.items.length) persistStore(dataFile, key, store)
        for (const [nodeId, lastSeen] of peers) if (lastSeen < Date.now() - 2 * 60_000) peers.delete(nodeId)
    }

    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
            if (request.method === 'GET' && url.pathname === '/health') {
                prune()
                return json(response, 200, { ok: true, service: 'nova-mesh-relay', queued: store.items.length, peers: peers.size, encryptedAtRest: true })
            }
            if (!authorized(request, options.token)) return json(response, 401, { error: 'unauthorized' })
            prune()

            if (request.method === 'GET' && url.pathname === '/peers') {
                return json(response, 200, [...peers].map(([nodeId, lastSeen]) => ({ nodeId, lastSeen })))
            }

            if (request.method === 'POST' && url.pathname === '/envelopes') {
                const body = await readBody(request, maxBody) as { to?: unknown; envelope?: unknown }
                const to = typeof body?.to === 'string' ? body.to : ''
                const envelope = body?.envelope as MeshEnvelope
                if ((!NODE_ID.test(to) && to !== '*') || !envelope || (envelope.targetNode !== to && envelope.targetNode !== '*') ||
                    !isSafeMeshKind(envelope.kind) || !MeshIdentity.verify(envelope)) {
                    return json(response, 400, { error: 'invalid_or_unsigned_envelope' })
                }
                if (envelope.expiresAt <= Date.now() || envelope.expiresAt > Date.now() + maxTtl) {
                    return json(response, 400, { error: 'invalid_expiry' })
                }
                const duplicate = store.items.find(item => item.id === envelope.id && item.to === to)
                if (duplicate) return json(response, 200, { status: 'duplicate', receipt: duplicate.id })
                if (store.items.length >= maxItems) return json(response, 503, { error: 'relay_capacity_reached' })
                if (STATE_UPDATE_KINDS.has(envelope.kind)) {
                    store.items = store.items.filter(item => item.to !== to || item.envelope.sourceNode !== envelope.sourceNode || item.envelope.kind !== envelope.kind)
                }
                store.items.push({ id: envelope.id, to, envelope, createdAt: Date.now(), expiresAt: envelope.expiresAt, receipts: {}, ackedBy: [] })
                persistStore(dataFile, key, store)
                return json(response, 202, { status: 'queued', receipt: envelope.id })
            }

            if (request.method === 'GET' && url.pathname === '/envelopes') {
                const nodeId = url.searchParams.get('to') || ''
                if (!NODE_ID.test(nodeId)) return json(response, 400, { error: 'invalid_node' })
                peers.set(nodeId, Date.now())
                const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 100)))
                const rows: Array<{ receipt: string; envelope: MeshEnvelope }> = []
                for (const item of store.items) {
                    if (rows.length >= limit || (item.to !== nodeId && item.to !== '*') || item.ackedBy.includes(nodeId)) continue
                    item.receipts[nodeId] ||= randomUUID()
                    rows.push({ receipt: item.receipts[nodeId], envelope: item.envelope })
                }
                if (rows.length) persistStore(dataFile, key, store)
                return json(response, 200, rows)
            }

            const ack = request.method === 'POST' && url.pathname.match(/^\/envelopes\/([^/]+)\/ack$/)
            if (ack) {
                const receipt = decodeURIComponent(ack[1])
                const item = store.items.find(candidate => Object.values(candidate.receipts).includes(receipt))
                if (!item) return json(response, 404, { error: 'receipt_not_found' })
                const nodeId = Object.entries(item.receipts).find(([, value]) => value === receipt)?.[0]
                if (!nodeId) return json(response, 404, { error: 'receipt_not_found' })
                if (item.to === '*') {
                    item.ackedBy.push(nodeId)
                    delete item.receipts[nodeId]
                } else {
                    store.items = store.items.filter(candidate => candidate !== item)
                }
                persistStore(dataFile, key, store)
                return json(response, 200, { status: 'acknowledged' })
            }

            return json(response, 404, { error: 'not_found' })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return json(response, message === 'body_too_large' ? 413 : 400, { error: message.slice(0, 160) })
        }
    })

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve())
    })
    const address = server.address()
    const actualPort = address && typeof address === 'object' ? address.port : port
    return {
        server, url: `http://${host}:${actualPort}`,
        close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/relay-server.js')) {
    const token = process.env.NOVA_MESH_RELAY_TOKEN || ''
    startMeshRelayServer({
        host: process.env.NOVA_MESH_RELAY_HOST || '127.0.0.1',
        port: Number(process.env.NOVA_MESH_RELAY_PORT || 3310), token,
        storageKey: process.env.NOVA_MESH_RELAY_STORAGE_KEY,
        dataFile: process.env.NOVA_MESH_RELAY_DATA_FILE,
    }).then(relay => console.log(`[MeshRelay] listening on ${relay.url}`))
        .catch(error => { console.error(`[MeshRelay] startup failed: ${error}`); process.exit(1) })
}
