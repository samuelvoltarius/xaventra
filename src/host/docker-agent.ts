import { createHash, timingSafeEqual, verify } from 'node:crypto'
import { createServer, request } from 'node:http'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redactSecrets } from '../security/secret-redaction.js'

export interface HostDockerEngine { call(method: string, path: string): Promise<any> }
export interface DockerPermit {
    id: string; nodeId: string; clientId: string; containerId: string
    action: 'start' | 'stop' | 'restart'; expiresAt: number; approvedBy: string
}
export interface HostAgentOptions {
    nodeId: string; clientId: string; token: string; stateDir: string
    approvalPublicKey?: string; allowedContainerIds?: string[]
}
const idPattern = /^[a-f0-9]{64}$/
const permitPattern = /^[a-zA-Z0-9-]{16,80}$/
const actions = ['start', 'stop', 'restart']
export function permitBytes(p: DockerPermit): Buffer {
    return Buffer.from(JSON.stringify([p.id, p.nodeId, p.clientId, p.containerId, p.action, p.expiresAt, p.approvedBy]))
}
function writeDurable(path: string, value: unknown, exclusive = false): void {
    const fd = openSync(path, exclusive ? 'wx' : 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
    if (process.platform !== 'win32') {
        const directory = openSync(dirname(path), 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
    }
}
export function hostDockerEngine(socketPath = '/var/run/docker.sock', apiVersion = ''): HostDockerEngine {
    if (!/^(?:\/|\\\\\.\\pipe\\)/.test(socketPath) || (apiVersion !== '' && !/^1\.\d{2}$/.test(apiVersion))) throw Error('Invalid operator Docker endpoint')
    return { call: (method, path) => new Promise((resolve, reject) => {
        const req = request({ socketPath, method, path: `${apiVersion ? `/v${apiVersion}` : ''}${path}` }, res => {
            const chunks: Buffer[] = []; let size = 0
            res.on('data', c => { size += c.length; if (size > 1024 * 1024) req.destroy(Error('Docker response limit exceeded')); else chunks.push(c) })
            res.on('error', reject)
            res.on('end', () => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return reject(Error(`Docker refused operation (${res.statusCode})`))
                const buffer = Buffer.concat(chunks)
                if (path.includes('/logs?')) {
                    // Docker multiplexed stdout/stderr frames, or unframed TTY.
                    let pos = 0; const text: Buffer[] = []
                    while (pos + 8 <= buffer.length && buffer[pos] <= 2 && buffer.subarray(pos + 1, pos + 4).equals(Buffer.alloc(3))) {
                        const length = buffer.readUInt32BE(pos + 4)
                        if (pos + 8 + length > buffer.length) return reject(Error('Truncated Docker log frame'))
                        text.push(buffer.subarray(pos + 8, pos + 8 + length)); pos += 8 + length
                    }
                    if (pos && pos !== buffer.length) return reject(Error('Invalid Docker log frame'))
                    return resolve((pos ? Buffer.concat(text) : buffer).toString('utf8'))
                }
                try { resolve(buffer.length ? JSON.parse(buffer.toString('utf8')) : null) } catch { reject(Error('Invalid Docker JSON')) }
            })
        })
        const timer = setTimeout(() => req.destroy(Error('Docker timed out; outcome must be reconciled')), 40_000)
        req.on('error', reject); req.on('close', () => clearTimeout(timer)); req.end()
    }) }
}

/** Operator-side service. Never accepts shell commands, raw API paths, mounts,
 * environment, image names, pulls, create, remove, exec or privilege flags. */
export function createDockerHostAgent(options: HostAgentOptions, engine: HostDockerEngine) {
    const opt = structuredClone(options)
    if (opt.token.length < 32 || !opt.nodeId || !opt.clientId) throw Error('Explicit node/client identity and strong token required')
    if ((opt.allowedContainerIds || []).some(id => !idPattern.test(id))) throw Error('Full container IDs required')
    mkdirSync(opt.stateDir, { recursive: true, mode: 0o700 })
    const busy = new Set<string>()
    const receipt = (data: object) => ({ success: true, nodeId: opt.nodeId, verifiedAt: new Date().toISOString(),
        evidenceHash: createHash('sha256').update(JSON.stringify(data)).digest('hex'), ...data })
    const inspect = async (id: string) => {
        if (!idPattern.test(id)) throw Error('Exact container ID required')
        const value = await engine.call('GET', `/containers/${id}/json`)
        if (value.Id !== id) throw Error('Docker container identity changed')
        return value
    }
    const server = createServer(async (req, res) => {
        res.setHeader('content-type', 'application/json')
        const reply = (code: number, value: unknown) => { res.statusCode = code; res.end(JSON.stringify(value)) }
        const expected = Buffer.from(`Bearer ${opt.token}`), auth = Buffer.from(String(req.headers.authorization || ''))
        if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { req.resume(); return reply(401, { success: false, error: 'Host agent authentication required' }) }
        if (req.method !== 'POST' || !['/v1/docker/list', '/v1/docker/status', '/v1/docker/logs', '/v1/docker/action'].includes(req.url || '')) {
            req.resume(); return reply(404, { success: false, error: 'Unsupported host operation' })
        }
        let data: any; let locked: string | undefined
        try {
            let body = ''; for await (const c of req) { body += c; if (Buffer.byteLength(body) > 16_384) throw Error('Request too large') }
            data = JSON.parse(body || '{}')
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Object required')
            const fields: Record<string, string[]> = { '/v1/docker/list': ['all'], '/v1/docker/status': ['containerId'], '/v1/docker/logs': ['containerId', 'lines'], '/v1/docker/action': ['permit', 'signature'] }
            if (Object.keys(data).some(k => !fields[req.url!].includes(k))) throw Error('Unknown host parameter')
            if (req.url === '/v1/docker/list') {
                if (data.all !== undefined && typeof data.all !== 'boolean') throw Error('all must be boolean')
                const rows = await engine.call('GET', `/containers/json?all=${data.all === true ? 1 : 0}`)
                if (!Array.isArray(rows) || rows.length > 2000) throw Error('Invalid Docker inventory')
                const containers = rows.map(c => ({ id: c.Id, names: c.Names, image: c.Image, state: c.State, status: c.Status }))
                return reply(200, receipt({ operation: 'docker.list', count: containers.length, containers }))
            }
            if (req.url !== '/v1/docker/action') {
                const info = await inspect(data.containerId)
                if (req.url === '/v1/docker/status') return reply(200, receipt({ operation: 'docker.status', containerId: info.Id, name: info.Name, running: info.State.Running, status: info.State.Status, health: info.State.Health?.Status, restartCount: info.RestartCount }))
                const lines = data.lines ?? 50
                if (!Number.isInteger(lines) || lines < 1 || lines > 200) throw Error('Log lines must be 1..200')
                let logs = await engine.call('GET', `/containers/${info.Id}/logs?stdout=1&stderr=1&timestamps=1&tail=${lines}`)
                // Environment values never leave the host, even if the process logs them.
                for (const item of info.Config?.Env || []) {
                    const index = item.indexOf('='); const key = item.slice(0, index), value = item.slice(index + 1)
                    if (/TOKEN|KEY|PASSWORD|SECRET|PASS/i.test(key) && value.length >= 4) logs = logs.split(value).join('[REDACTED]')
                }
                return reply(200, receipt({ operation: 'docker.logs', containerId: info.Id, logs: redactSecrets(logs).slice(-32_768) }))
            }
            const p: DockerPermit = data.permit
            if (!p || Object.keys(p).sort().join(',') !== 'action,approvedBy,clientId,containerId,expiresAt,id,nodeId'
                || !permitPattern.test(p.id) || !idPattern.test(p.containerId) || !actions.includes(p.action)
                || p.nodeId !== opt.nodeId || p.clientId !== opt.clientId || typeof p.approvedBy !== 'string' || !p.approvedBy.trim()
                || !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= Date.now() || p.expiresAt > Date.now() + 300_000
                || typeof data.signature !== 'string' || !opt.approvalPublicKey
                || !verify(null, permitBytes(p), opt.approvalPublicKey, Buffer.from(data.signature, 'base64'))
                || !opt.allowedContainerIds?.includes(p.containerId)) throw Error('Missing, expired or out-of-scope operator approval')
            const path = join(opt.stateDir, `${p.id}.json`), binding = createHash('sha256').update(permitBytes(p)).digest('hex')
            if (existsSync(path)) {
                const prior = JSON.parse(readFileSync(path, 'utf8'))
                if (prior.binding !== binding) throw Error('Approval ID reused for a different operation')
                if (prior.phase !== 'completed') throw Error('Prior outcome uncertain; operator reconciliation required')
                return reply(200, prior.receipt)
            }
            if (busy.has(p.containerId)) throw Error('Container already has an active operation')
            busy.add(p.containerId); locked = p.containerId
            const before = await inspect(p.containerId)
            if (before.State.Paused || before.State.Restarting || before.State.Dead) throw Error('Container state requires operator reconciliation')
            writeDurable(path, { binding, phase: 'intent', permit: p, before: { running: before.State.Running, startedAt: before.State.StartedAt } }, true)
            const already = (p.action === 'start' && before.State.Running) || (p.action === 'stop' && !before.State.Running)
            if (!already) await engine.call('POST', `/containers/${p.containerId}/${p.action}${p.action === 'start' ? '' : '?t=20'}`)
            const after = await inspect(p.containerId)
            if (after.State.Running !== (p.action !== 'stop') || after.State.Restarting
                || (p.action === 'restart' && before.State.StartedAt === after.State.StartedAt)) throw Error('Docker final state not verified')
            const result = receipt({ operation: `docker.${p.action}`, containerId: p.containerId, approvalId: p.id, running: after.State.Running, status: after.State.Status })
            writeDurable(path, { binding, phase: 'completed', receipt: result })
            return reply(200, result)
        } catch (error) {
            return reply(409, { success: false, error: redactSecrets(String((error as Error).message)).slice(0, 250) })
        } finally { if (locked) busy.delete(locked) }
    })
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    server.maxConnections = 32
    return server
}
