import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_ENTRIES = 512
const MAX_DELAY = 6 * 60 * 60_000
type Failure = { failures: number; retryAt: number; reason: 'http' | 'unreachable' | 'mismatch' }

/** Operator exclusions are exact HTTP origins, never credentials or URL patterns. */
export function discoveryOrigin(value: string): string {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('AI scan exclusions must be plain HTTP origins without credentials or paths')
    }
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) url.hostname = 'localhost'
    return url.origin
}

/** How long one answer of a KI port is shared between modules (2.82.0). */
export const AI_PROBE_RESULT_MAX_AGE_MS = 30_000

/**
 * Only retry metadata is persisted. Response bodies and credentials never enter
 * the file. 2.82.0: one shared client for every module that asks a KI port
 * (AIScan, model-resolver latency, local LLM, self-setup): answers are shared
 * in memory for 30 s and concurrent callers join one request.
 */
export class DiscoveryProbeClient {
    private entries = new Map<string, Failure>()
    private results = new Map<string, { at: number; body: string | null; ms: number | null }>()
    private inflight = new Map<string, Promise<string | null>>()
    constructor(private file: string, private now = Date.now) {
        try {
            if (existsSync(file) && statSync(file).size <= 256 * 1024) {
                const data = JSON.parse(readFileSync(file, 'utf8'))
                for (const [key, value] of Object.entries(data.entries ?? {}).slice(-MAX_ENTRIES)) {
                    const entry = value as Failure
                    if (key.length <= 2048 && Number.isInteger(entry.failures) && entry.failures > 0
                        && entry.failures <= 20 && Number.isFinite(entry.retryAt)
                        && entry.retryAt <= this.now() + MAX_DELAY
                        && ['http', 'unreachable', 'mismatch'].includes(entry.reason)) this.entries.set(key, entry)
                }
            }
        } catch { /* A missing/corrupt advisory cache must not disable discovery. */ }
    }

    private key(url: string, service = ''): string {
        const parsed = new URL(url)
        return JSON.stringify([discoveryOrigin(parsed.origin), parsed.pathname, service])
    }

    private persist(): void {
        while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!)
        const temp = `${this.file}.${randomUUID()}.tmp`
        try {
            mkdirSync(dirname(this.file), { recursive: true })
            writeFileSync(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }), { mode: 0o600, flag: 'wx' })
            renameSync(temp, this.file)
        } catch { /* In-memory backoff still applies on read-only storage. */ }
        finally { try { rmSync(temp, { force: true }) } catch { /* Advisory cache only. */ } }
    }

    private allowed(key: string): boolean { return (this.entries.get(key)?.retryAt ?? 0) <= this.now() }
    private success(key: string): void { if (this.entries.delete(key)) this.persist() }
    private fail(key: string, reason: Failure['reason']): void {
        const failures = Math.min(20, (this.entries.get(key)?.failures ?? 0) + 1)
        const base = reason === 'unreachable' ? 60_000 : 30 * 60_000
        const ceiling = reason === 'unreachable' ? 15 * 60_000 : MAX_DELAY
        this.entries.delete(key)
        this.entries.set(key, { failures, reason, retryAt: this.now() + Math.min(ceiling, base * 2 ** (failures - 1)) })
        this.persist()
    }

    allowsService(url: string, service: string): boolean { return this.allowed(this.key(url, service)) }
    recordService(url: string, service: string, matches: boolean): void {
        const key = this.key(url, service)
        if (matches) this.success(key)
        else this.fail(key, 'mismatch')
    }

    /** Latency (ms) of the last answered probe of `url`, null when it did not answer. */
    lastLatency(url: string): number | null { return this.results.get(url)?.ms ?? null }

    async probe(url: string, timeoutMs = 3000, options: { maxAgeMs?: number } = {}): Promise<string | null> {
        // Operator exclusion and backoff are checked first, every time: the shared answer
        // cache never bypasses them, and their short-circuit is never cached as an answer.
        const excluded = (process.env.XAVENTRA_AI_SCAN_EXCLUDE_ENDPOINTS ?? '').split(',').map(v => v.trim()).filter(Boolean)
        if (excluded.map(discoveryOrigin).includes(discoveryOrigin(new URL(url).origin))) return null
        if (!this.allowed(this.key(url))) return null
        const maxAge = options.maxAgeMs ?? AI_PROBE_RESULT_MAX_AGE_MS
        const cached = this.results.get(url)
        if (cached && this.now() - cached.at < maxAge) return cached.body
        const running = this.inflight.get(url)
        if (running) return running
        const started = Date.now()
        const run = this.probeOnce(url, timeoutMs).then(body => {
            this.results.set(url, { at: this.now(), body, ms: body === null ? null : Date.now() - started })
            while (this.results.size > MAX_ENTRIES) this.results.delete(this.results.keys().next().value!)
            return body
        }).finally(() => this.inflight.delete(url))
        this.inflight.set(url, run)
        return run
    }

    private async probeOnce(url: string, timeoutMs: number): Promise<string | null> {
        // Re-read local operator policy; neither full inventory nor forceFresh bypasses it.
        // Invalid entries fail this probe closed, rather than silently scanning excluded services.
        const excluded = (process.env.XAVENTRA_AI_SCAN_EXCLUDE_ENDPOINTS ?? '').split(',').map(v => v.trim()).filter(Boolean)
        if (excluded.map(discoveryOrigin).includes(discoveryOrigin(new URL(url).origin))) return null
        const key = this.key(url)
        if (!this.allowed(key)) return null
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const response = await fetch(url, {
                signal: controller.signal, redirect: 'error',
                headers: { Accept: 'application/json', 'User-Agent': 'Xaventra-AI-Discovery' },
            })
            if (!response.ok) {
                await response.body?.cancel()
                this.fail(key, response.status >= 500 || response.status === 429 ? 'unreachable' : 'http')
                return null
            }
            const reader = response.body?.getReader()
            let bytes = 0
            const chunks: Uint8Array[] = []
            if (reader) {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    bytes += value.byteLength
                    if (bytes > 256 * 1024) { await reader.cancel(); throw new Error('discovery response too large') }
                    chunks.push(value)
                }
            }
            this.success(key)
            return Buffer.concat(chunks).toString('utf8')
        } catch { this.fail(key, 'unreachable'); return null }
        finally { clearTimeout(timer) }
    }
}

let shared: DiscoveryProbeClient | undefined
/** The one KI-port probe client of this process (backoff file under .nova-data). */
export function getAiProbeClient(): DiscoveryProbeClient {
    return shared ??= new DiscoveryProbeClient(join(process.cwd(), '.nova-data', 'ai-probe-backoff.json'))
}
/** Tests only. */
export function resetAiProbeClient(client?: DiscoveryProbeClient): void { shared = client }

/**
 * Ask a KI port for its JSON list (`/api/tags`, `/v1/models`) through the one
 * shared client: plain http endpoints share answer, backoff and latency; an
 * https endpoint (never a scan target) is asked directly. Never throws.
 */
export async function probeAiJson(baseUrl: string, path: string, timeoutMs = 3000): Promise<{ ok: boolean; body: any | null; ms: number | null }> {
    const url = `${String(baseUrl).replace(/\/+$/, '')}${path}`
    try {
        if (new URL(url).protocol === 'http:') {
            const client = getAiProbeClient()
            const text = await client.probe(url, timeoutMs)
            if (text === null) return { ok: false, body: null, ms: null }
            let body: any = null
            try { body = JSON.parse(text) } catch { body = null }
            return { ok: true, body, ms: client.lastLatency(url) }
        }
        const started = Date.now()
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { ok: false, body: null, ms: null } }
        return { ok: true, body: await response.json().catch(() => null), ms: Date.now() - started }
    } catch { return { ok: false, body: null, ms: null } }
}
