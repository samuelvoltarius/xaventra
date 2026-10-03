import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, readdir, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getRuntimeRoot } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'

export const EXCHANGE_MAX_BYTES = 256 * 1024
const QUOTA_BYTES = 32 * 1024 * 1024
let writes: Promise<unknown> = Promise.resolve()
export interface ExchangeRequest { operation: 'list' | 'read' | 'write'; name?: string; base64?: string; sha256?: string }
export interface ExchangeFile { name: string; bytes: number; sha256: string; base64?: string }

/** Signed peers still have to satisfy the requested response contract. */
export function validateExchangeResult(request: ExchangeRequest, value: unknown): ExchangeFile | { files: Array<{ name: string; bytes: number }> } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid exchange receipt')
    const p = value as Record<string, unknown>
    const size = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= EXCHANGE_MAX_BYTES
    if (request.operation === 'list') {
        if (Object.keys(p).some(k => k !== 'files') || !Array.isArray(p.files) || p.files.length > 1000) throw new Error('invalid exchange inventory')
        const seen = new Set<string>()
        const files = p.files.map((entry: unknown) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid exchange inventory entry')
            const f = entry as Record<string, unknown>
            if (Object.keys(f).some(k => !['name', 'bytes'].includes(k)) || !exchangeNameAllowed(f.name) || !size(f.bytes) || seen.has(f.name)) throw new Error('invalid exchange inventory entry')
            seen.add(f.name)
            return { name: f.name, bytes: f.bytes }
        })
        return { files }
    }
    const allowed = request.operation === 'read' ? ['name', 'bytes', 'sha256', 'base64'] : ['name', 'bytes', 'sha256']
    if (Object.keys(p).some(k => !allowed.includes(k)) || p.name !== request.name || !size(p.bytes) || typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256)) throw new Error('invalid exchange receipt')
    if (request.operation === 'read') {
        if (!validExchangeRequest({ operation: 'write', name: p.name, base64: p.base64, sha256: p.sha256 })) throw new Error('invalid exchange source receipt')
        const bytes = Buffer.from(p.base64 as string, 'base64')
        if (bytes.toString('base64') !== p.base64 || bytes.length !== p.bytes || createHash('sha256').update(bytes).digest('hex') !== p.sha256) throw new Error('exchange source hash mismatch')
        if (redactSecrets(bytes.toString('utf8')) !== bytes.toString('utf8')) throw new Error('secrets must not enter node exchange')
        return { name: request.name!, bytes: p.bytes, sha256: p.sha256, base64: p.base64 as string }
    }
    const bytes = Buffer.from(request.base64!, 'base64')
    if (p.sha256 !== request.sha256 || p.bytes !== bytes.length) throw new Error('exchange destination receipt mismatch')
    return { name: request.name!, bytes: p.bytes, sha256: p.sha256 }
}

/** Flat names only; existing state and credentials cannot be selected. */
export function exchangeNameAllowed(name: unknown): name is string {
    return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.(?:txt|md|json|csv|png|jpg|jpeg|pdf|bin)$/i.test(name)
        && !/(?:config|credential|auth|secret|token|private|password|id_rsa|id_ed25519)/i.test(name)
        && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)
}

export function validExchangeRequest(value: unknown): value is ExchangeRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const p = value as ExchangeRequest
    if (Object.keys(p).some(k => !['operation', 'name', 'base64', 'sha256'].includes(k))) return false
    if (p.operation === 'list') return Object.keys(p).length === 1
    if (!exchangeNameAllowed(p.name)) return false
    if (p.operation === 'read') return p.base64 === undefined && p.sha256 === undefined
    return p.operation === 'write' && typeof p.sha256 === 'string' && /^[a-f0-9]{64}$/.test(p.sha256)
        && typeof p.base64 === 'string' && p.base64.length <= Math.ceil(EXCHANGE_MAX_BYTES / 3) * 4
        && p.base64.length / 4 * 3 - (p.base64.endsWith('==') ? 2 : p.base64.endsWith('=') ? 1 : 0) <= EXCHANGE_MAX_BYTES
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.base64)
}

async function exchangeDirectory(root: string): Promise<string> {
    const dir = join(root, 'exchange')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const stat = await lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('exchange directory must be a real directory')
    return dir
}

async function readExchangeFile(dir: string, name: string): Promise<ExchangeFile> {
    const path = join(dir, name)
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > EXCHANGE_MAX_BYTES) throw new Error('exchange file is not a bounded regular file')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
        const stat = await handle.stat()
        if (stat.ino !== before.ino || stat.dev !== before.dev || stat.nlink !== 1 || stat.size > EXCHANGE_MAX_BYTES) throw new Error('exchange file changed during open')
        // Bounded even if a producer grows the file after stat.
        const buffer = Buffer.alloc(EXCHANGE_MAX_BYTES + 1)
        let length = 0
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
            if (!bytesRead) break
            length += bytesRead
        }
        if (length > EXCHANGE_MAX_BYTES) throw new Error('exchange file exceeds size limit')
        const bytes = buffer.subarray(0, length)
        if (redactSecrets(bytes.toString('utf8')) !== bytes.toString('utf8')) throw new Error('secrets must not enter node exchange')
        return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }
    } finally { await handle.close() }
}

/** The only filesystem effect of the protocol: own exchange directory, no overwrite. */
export async function executeExchange(request: ExchangeRequest, root = getRuntimeRoot(), beforeCommit?: () => Promise<void>): Promise<ExchangeFile | { files: Array<{ name: string; bytes: number }> }> {
    if (request.operation !== 'write') return executeExchangeInner(request, root, beforeCommit)
    const pending = writes.then(() => executeExchangeInner(request, root, beforeCommit))
    writes = pending.catch(() => undefined)
    return pending
}

async function executeExchangeInner(request: ExchangeRequest, root: string, beforeCommit?: () => Promise<void>): Promise<ExchangeFile | { files: Array<{ name: string; bytes: number }> }> {
    if (!validExchangeRequest(request)) throw new Error('invalid exchange request')
    const dir = await exchangeDirectory(root)
    if (request.operation === 'read') return readExchangeFile(dir, request.name!)
    const entries = await readdir(dir)
    if (entries.length > 1000) throw new Error('exchange entry limit reached')
    const files: Array<{ name: string; bytes: number }> = []
    let occupied = 0
    for (const name of entries) {
        const stat = await lstat(join(dir, name))
        occupied += stat.size
        if (exchangeNameAllowed(name) && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= EXCHANGE_MAX_BYTES) files.push({ name, bytes: stat.size })
    }
    if (request.operation === 'list') return { files }
    const bytes = Buffer.from(request.base64!, 'base64')
    if (redactSecrets(bytes.toString('utf8')) !== bytes.toString('utf8')) throw new Error('secrets must not enter node exchange')
    if (bytes.length > EXCHANGE_MAX_BYTES || bytes.toString('base64') !== request.base64
        || createHash('sha256').update(bytes).digest('hex') !== request.sha256) throw new Error('exchange size/hash mismatch')
    try {
        const existing = await readExchangeFile(dir, request.name!)
        if (existing.sha256 !== request.sha256) throw new Error('exchange destination exists with different contents')
        return { name: existing.name, bytes: existing.bytes, sha256: existing.sha256 }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (occupied + bytes.length > QUOTA_BYTES || entries.length >= 1000) throw new Error('exchange quota exceeded')
    const temp = join(dir, `.incoming-${randomUUID()}`)
    const handle = await open(temp, 'wx', 0o600)
    try {
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        await beforeCommit?.()
        // link is atomic and refuses an existing destination, unlike rename.
        await link(temp, join(dir, request.name!))
    } finally { await unlink(temp) }
    const receipt = await readExchangeFile(dir, request.name!)
    if (receipt.sha256 !== request.sha256) throw new Error('exchange readback mismatch')
    return { name: receipt.name, bytes: receipt.bytes, sha256: receipt.sha256 }
}
