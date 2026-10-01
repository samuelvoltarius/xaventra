/**
 * Werkzeug-Schmiede: die Sandbox (P9, 01.10.2026).
 *
 * Ein selbst gebautes Werkzeug läuft nie im Daemon, sondern immer in einem
 * eigenen Kindprozess:
 *
 *   node --permission --allow-fs-read=<runner> --allow-fs-read=<werkzeug>
 *        --disallow-code-generation-from-strings --max-old-space-size=96
 *
 * - Permission-Modell: keine Schreibrechte, Lesen nur der zwei eigenen
 *   Dateien, kein child_process, keine Worker, keine Addons, kein WASI.
 * - Codeerzeugung aus Text (eval, new Function, Konstruktor-Kette) ist aus.
 * - Import-Sperre per `module.registerHooks`: nur die Erlaubnisliste
 *   (`FORGE_ALLOWED_MODULES`); fs, net, http(s), child_process, vm, module
 *   usw. sind gesperrt, auch als dynamischer Import mit Kommentar-Trick.
 * - `process.getBuiltinModule`, `process.binding`, `process.kill` und weitere
 *   Ausgänge sind im Kind überschrieben; stdin/stdout/stderr, `process.env`
 *   und das globale `fetch`/`WebSocket` sind für das Werkzeug unsichtbar.
 * - Netz und Dateien nur über `ctx.fetch` / `ctx.readFile`, die der
 *   Elternprozess prüft (Manifest-Hosts, SSRF-Guard, Manifest-Pfade).
 * - Zeit- und Speicherlimit; das Ergebnis kommt nur mit einem Einmal-Schlüssel
 *   an, den das Werkzeug nie sieht (keine gefälschten Ergebnisse über stdout).
 *
 * Fehlt `--permission` oder `module.registerHooks` (Node < 22.15), lehnt die
 * Schmiede ehrlich ab, statt unsicher auszuführen (`sandboxSupport()`).
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeModule from 'node:module'

export type ForgeImpact = 'lesend' | 'schreibend' | 'extern' | 'physisch'
export const FORGE_IMPACTS: readonly ForgeImpact[] = Object.freeze(['lesend', 'schreibend', 'extern', 'physisch'])

export interface ForgeManifest {
    /** Hostnamen, die `ctx.fetch` erreichen darf (exakt, ohne Schema/Port). */
    net: string[]
    /** Dateien/Ordner, die `ctx.readFile` lesen darf (nur lesen). */
    fs: string[]
    wirkung: ForgeImpact
}

/** Module, die ein Werkzeug importieren darf (alles andere ist gesperrt). */
export const FORGE_ALLOWED_MODULES: readonly string[] = Object.freeze([
    'node:buffer', 'node:crypto', 'node:events', 'node:path', 'node:querystring', 'node:string_decoder', 'node:url',
])

export interface SandboxFetchRequest { url: string; method: string; headers: Record<string, string>; body?: string }
export interface SandboxFetchResponse { status: number; headers: Record<string, string>; body: string }

export interface SandboxRequest {
    code: string
    params: unknown
    manifest: ForgeManifest
    fetchHandler: (request: SandboxFetchRequest) => Promise<SandboxFetchResponse>
    readFileHandler: (path: string) => Promise<string>
    timeoutMs?: number
    memoryMb?: number
}

export interface SandboxResult {
    ok: boolean
    value?: unknown
    error?: string
    logs: string[]
    durationMs: number
    timedOut?: boolean
}

const MAX_CODE_BYTES = 20_000
const MAX_LOGS = 50
const MAX_STDOUT_BYTES = 4_000_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MEMORY_MB = 96

// ---------------------------------------------------------------------------
// Unterstützung
// ---------------------------------------------------------------------------

/** Hat diese Node-Version alles, was die Sandbox braucht? */
export function sandboxSupport(version = process.versions.node, hooks: unknown = (nodeModule as any).registerHooks): { ok: boolean; reason?: string } {
    const [major, minor] = String(version).split('.').map(part => Number.parseInt(part, 10) || 0)
    const permission = major > 22 || (major === 22 && minor >= 13)
    const registerHooks = typeof hooks === 'function'
    if (permission && registerHooks) return { ok: true }
    const missing = [!permission && '--permission (ab Node 22.13)', !registerHooks && 'module.registerHooks (ab Node 22.15)'].filter(Boolean).join(' und ')
    return { ok: false, reason: `Node ${version}: ${missing} fehlt — die Werkzeug-Schmiede führt deshalb nichts aus (keine unsichere Ausweichlösung).` }
}

// ---------------------------------------------------------------------------
// Statische Prüfung
// ---------------------------------------------------------------------------

function normalizeModule(specifier: string): string {
    return specifier.startsWith('node:') ? specifier : `node:${specifier}`
}

/**
 * Statische Prüfung vor jedem Test: CodeGuardian (`staticSecurityCheck`,
 * AST) plus Modul-Erlaubnisliste, kein dynamischer Import, kein require,
 * Pflicht `export default`. Die Sandbox bleibt trotzdem die Grenze.
 */
export async function validateForgeCode(code: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = []
    const source = String(code ?? '')
    if (!source.trim()) return { valid: false, errors: ['Kein Code'] }
    if (Buffer.byteLength(source) > MAX_CODE_BYTES) return { valid: false, errors: [`Code größer als ${MAX_CODE_BYTES / 1000} KB`] }

    const acorn = await import('acorn')
    const walk = await import('acorn-walk')
    let ast: any
    try {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: false, locations: true })
    } catch (error) {
        return { valid: false, errors: [`Code nicht parsebar: ${String((error as Error)?.message || error).slice(0, 160)}`] }
    }
    let hasDefault = false
    const allowed = new Set(FORGE_ALLOWED_MODULES)
    const checkSource = (value: unknown) => {
        const name = normalizeModule(String(value))
        if (!allowed.has(name)) errors.push(`Import von ${name} ist gesperrt (erlaubt: ${FORGE_ALLOWED_MODULES.join(', ')})`)
    }
    for (const node of ast.body) {
        if (node.type === 'ImportDeclaration') checkSource(node.source.value)
        if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) checkSource(node.source.value)
        if (node.type === 'ExportDefaultDeclaration') hasDefault = true
    }
    walk.full(ast, (node: any) => {
        if (node.type === 'ImportExpression') errors.push('Dynamischer Import ist gesperrt')
        if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') errors.push('require ist gesperrt')
        if (node.type === 'MetaProperty' && node.meta?.name === 'import') errors.push('import.meta ist gesperrt')
    })
    if (!hasDefault) errors.push('Werkzeug braucht `export default async function (params, ctx)`')

    const { staticSecurityCheck } = await import('../security/code-guardian.js')
    const guardian = await staticSecurityCheck(source, 'werkzeug.mjs')
    for (const finding of guardian.findings || []) {
        if (finding.severity === 'critical') errors.push(`CodeGuardian: ${finding.description}`)
    }
    if (!guardian.safe && !(guardian.findings || []).some(finding => finding.severity === 'critical')) errors.push('CodeGuardian: nicht als sicher bestätigt')
    return { valid: errors.length === 0, errors: [...new Set(errors)] }
}

// ---------------------------------------------------------------------------
// Kindprozess
// ---------------------------------------------------------------------------

/**
 * Läuft im Kind. Bewusst ohne Backslashes und Template-Literale, damit der
 * Text unverändert als .mjs-Datei geschrieben werden kann.
 */
const RUNNER_SOURCE = String.raw`import { registerHooks } from 'node:module'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

const NL = String.fromCharCode(10)
const input = process.stdin
const out = process.stdout
const exitNow = process.exit.bind(process)
const write = (message, done) => out.write(JSON.stringify(message) + NL, done)
const toolUrl = pathToFileURL(process.argv[2]).href
const allowed = new Set(JSON.parse(process.argv[3]))

let buffer = ''
let job = null
let resolveJob = null
const jobReady = new Promise(resolve => { resolveJob = resolve })
const pending = new Map()
input.setEncoding('utf8')
input.on('data', chunk => {
    buffer += chunk
    let index = buffer.indexOf(NL)
    while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf(NL)
        let message = null
        try { message = JSON.parse(line) } catch { continue }
        if (!job) { job = message; resolveJob(message); continue }
        const waiting = message && pending.get(message.id)
        if (waiting) { pending.delete(message.id); waiting(message) }
    }
})
const { nonce, params } = await jobReady

let sequence = 0
const ask = (type, payload) => new Promise(resolve => {
    sequence += 1
    pending.set(sequence, resolve)
    write(Object.assign({ nonce, type, id: sequence }, payload))
})
const plainHeaders = value => {
    const result = {}
    if (value && typeof value === 'object') for (const key of Object.keys(value)) result[String(key)] = String(value[key])
    return result
}
const ctx = Object.freeze({
    fetch: async (url, init) => {
        const options = init || {}
        const answer = await ask('fetch', {
            url: String(url),
            method: String(options.method || 'GET').toUpperCase(),
            headers: plainHeaders(options.headers),
            body: options.body === undefined || options.body === null ? undefined : String(options.body),
        })
        if (answer.error) throw new Error(answer.error)
        const body = String(answer.body === undefined || answer.body === null ? '' : answer.body)
        return Object.freeze({
            ok: answer.status >= 200 && answer.status < 300,
            status: answer.status,
            headers: Object.freeze(plainHeaders(answer.headers)),
            text: async () => body,
            json: async () => JSON.parse(body),
        })
    },
    readFile: async path => {
        const answer = await ask('readFile', { path: String(path) })
        if (answer.error) throw new Error(answer.error)
        return String(answer.content)
    },
    log: (...args) => {
        const text = args.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(' ').slice(0, 500)
        write({ nonce, type: 'log', text })
    },
})

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === toolUrl) return nextResolve(specifier, context)
        const name = specifier.startsWith('node:') ? specifier : 'node:' + specifier
        if (allowed.has(name)) return nextResolve(name, context)
        throw new Error('Import gesperrt: ' + specifier)
    },
})

const blocked = name => function () { throw new Error('gesperrt: process.' + name) }
for (const name of ['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule', 'kill', '_kill', 'report', '_getActiveHandles', '_getActiveRequests', 'openStdin', 'execve', 'loadEnvFile', 'chdir', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups', '_debugProcess', '_debugEnd', '_startProfilerIdleNotifier', '_stopProfilerIdleNotifier', 'setSourceMapsEnabled']) {
    try { Object.defineProperty(process, name, { value: blocked(name), configurable: false, writable: false, enumerable: false }) } catch {}
}
for (const name of ['stdin', 'stdout', 'stderr']) {
    try { Object.defineProperty(process, name, { value: Object.freeze({}), configurable: false, writable: false }) } catch {}
}
try { Object.defineProperty(process, 'env', { value: Object.freeze({}), configurable: false, writable: false }) } catch {}
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
    try { delete globalThis[name] } catch {}
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }) } catch {}
}
net.Socket.prototype.connect = blocked('net.connect')
net.Server.prototype.listen = blocked('net.listen')
const logToCtx = (...args) => ctx.log(...args)
try { Object.defineProperty(globalThis, 'console', { value: Object.freeze({ log: logToCtx, info: logToCtx, warn: logToCtx, error: logToCtx, debug: logToCtx }), configurable: false, writable: false }) } catch {}

let reply
try {
    const tool = await import(toolUrl)
    if (typeof tool.default !== 'function') throw new Error('Werkzeug hat kein export default')
    const value = await tool.default(params, ctx)
    const text = JSON.stringify(value === undefined ? null : value)
    if (typeof text !== 'string') throw new Error('Ergebnis ist nicht als JSON darstellbar')
    if (text.length > 1000000) throw new Error('Ergebnis zu groß (über 1 MB)')
    reply = { nonce, type: 'result', ok: true, value: JSON.parse(text) }
} catch (error) {
    reply = { nonce, type: 'result', ok: false, error: String((error && error.message) || error).slice(0, 500) }
}
write(reply, () => exitNow(0))
`

/** Ein Werkzeug in einem frischen, abgeschotteten Kindprozess ausführen. */
export async function runInForgeSandbox(request: SandboxRequest): Promise<SandboxResult> {
    const started = Date.now()
    const logs: string[] = []
    const support = sandboxSupport()
    if (!support.ok) return { ok: false, error: support.reason, logs, durationMs: 0 }
    if (Buffer.byteLength(String(request.code ?? '')) > MAX_CODE_BYTES) return { ok: false, error: 'Code zu groß', logs, durationMs: 0 }

    const dir = mkdtempSync(join(tmpdir(), 'xv-forge-'))
    const runnerPath = join(dir, 'runner.mjs')
    const toolPath = join(dir, 'werkzeug.mjs')
    writeFileSync(runnerPath, RUNNER_SOURCE, { mode: 0o600 })
    writeFileSync(toolPath, String(request.code), { mode: 0o600 })
    const nonce = randomBytes(16).toString('hex')
    const timeoutMs = Math.max(200, Math.min(Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS, 120_000))
    const memoryMb = Math.max(32, Math.min(Number(request.memoryMb) || DEFAULT_MEMORY_MB, 512))
    const args = [
        '--permission',
        `--allow-fs-read=${runnerPath}`,
        `--allow-fs-read=${toolPath}`,
        '--disallow-code-generation-from-strings',
        `--max-old-space-size=${memoryMb}`,
        '--no-warnings',
        runnerPath, toolPath, JSON.stringify(FORGE_ALLOWED_MODULES),
    ]

    return await new Promise<SandboxResult>(resolve => {
        let settled = false
        let stdoutBytes = 0
        let stderr = ''
        let lineBuffer = ''
        const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true })
        const finish = (result: Omit<SandboxResult, 'logs' | 'durationMs'>) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try { child.kill('SIGKILL') } catch { /* already gone */ }
            try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
            resolve({ ...result, logs, durationMs: Date.now() - started })
        }
        const timer = setTimeout(() => finish({ ok: false, error: `Zeitlimit ${timeoutMs} ms überschritten`, timedOut: true }), timeoutMs)
        const send = (message: unknown) => {
            try { child.stdin.write(`${JSON.stringify(message)}\n`) } catch { /* child gone */ }
        }
        const handle = async (message: any) => {
            if (!message || message.nonce !== nonce) {
                if (logs.length < MAX_LOGS) logs.push('[ohne Schlüssel verworfen]')
                return
            }
            if (message.type === 'log') {
                if (logs.length < MAX_LOGS) logs.push(String(message.text ?? '').slice(0, 500))
                return
            }
            if (message.type === 'result') {
                finish(message.ok === true ? { ok: true, value: message.value } : { ok: false, error: String(message.error ?? 'Fehler').slice(0, 500) })
                return
            }
            if (message.type === 'fetch') {
                // The manifest is enforced here, for test fixtures and real runs alike.
                const refusal = manifestFetchRefusal(request.manifest, { url: String(message.url), method: String(message.method || 'GET') })
                if (refusal) { send({ id: message.id, error: refusal }); return }
                try {
                    const response = await request.fetchHandler({
                        url: String(message.url), method: String(message.method || 'GET').toUpperCase(),
                        headers: message.headers && typeof message.headers === 'object' ? message.headers : {},
                        ...(message.body !== undefined ? { body: String(message.body) } : {}),
                    })
                    send({ id: message.id, status: response.status, headers: response.headers, body: response.body })
                } catch (error) {
                    send({ id: message.id, error: String((error as Error)?.message || error).slice(0, 300) })
                }
                return
            }
            if (message.type === 'readFile') {
                try {
                    send({ id: message.id, content: await request.readFileHandler(String(message.path)) })
                } catch (error) {
                    send({ id: message.id, error: String((error as Error)?.message || error).slice(0, 300) })
                }
            }
        }
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
            stdoutBytes += chunk.length
            if (stdoutBytes > MAX_STDOUT_BYTES) { finish({ ok: false, error: 'Zu viel Ausgabe' }); return }
            lineBuffer += chunk
            let index = lineBuffer.indexOf('\n')
            while (index >= 0) {
                const line = lineBuffer.slice(0, index)
                lineBuffer = lineBuffer.slice(index + 1)
                index = lineBuffer.indexOf('\n')
                let message: unknown = null
                try { message = JSON.parse(line) } catch { if (logs.length < MAX_LOGS) logs.push('[Ausgabe ohne Schlüssel verworfen]'); continue }
                void handle(message)
            }
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => { if (stderr.length < 4_000) stderr += chunk })
        child.on('error', error => finish({ ok: false, error: `Sandbox-Start fehlgeschlagen: ${String(error.message).slice(0, 200)}` }))
        // 'close' fires after stdout is drained, so a final result line is never lost.
        child.on('close', code => {
            finish({ ok: false, error: `Sandbox beendet (Code ${code ?? '?'}) ohne Ergebnis${stderr ? `: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}` : ''}` })
        })
        child.stdin.on('error', () => { /* child exited early */ })
        send({ nonce, params: request.params ?? {} })
    })
}

// ---------------------------------------------------------------------------
// Vom Elternprozess geprüfte Zugriffe
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 1_000_000

export function hostOf(url: string): string | null {
    try { return new URL(url).hostname.toLowerCase() } catch { return null }
}

/** Prüft eine Anfrage gegen das Manifest (Host, Methode). Gibt einen Grund oder null. */
export function manifestFetchRefusal(manifest: ForgeManifest, request: Pick<SandboxFetchRequest, 'url' | 'method'>): string | null {
    let parsed: URL
    try { parsed = new URL(request.url) } catch { return 'ungültige URL' }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return `Schema ${parsed.protocol} nicht erlaubt`
    if (parsed.username || parsed.password) return 'Zugangsdaten in der URL sind nicht erlaubt'
    const host = parsed.hostname.toLowerCase()
    if (!manifest.net.map(item => item.toLowerCase()).includes(host)) return `Host ${host} steht nicht im Manifest`
    const method = String(request.method || 'GET').toUpperCase()
    if (manifest.wirkung === 'lesend' && method !== 'GET' && method !== 'HEAD') return `Werkzeug ist lesend: ${method} nicht erlaubt`
    return null
}

/** Echtes Netz für aktive Werkzeuge: Manifest + SSRF-Guard, keine Weiterleitungen. */
export function createManifestFetch(manifest: ForgeManifest): SandboxRequest['fetchHandler'] {
    return async request => {
        const refusal = manifestFetchRefusal(manifest, request)
        if (refusal) throw new Error(refusal)
        const { safeFetch } = await import('../security/ssrf-guard.js')
        const response = await safeFetch(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.body !== undefined && request.method !== 'GET' && request.method !== 'HEAD' ? { body: request.body } : {}),
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
        })
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error('Antwort größer als 1 MB')
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => { headers[key] = value })
        return { status: response.status, headers, body: buffer.toString('utf8') }
    }
}

/** Dateien nur aus den Manifest-Pfaden, nur lesen, nie Nie-Ziele. */
export function createManifestReadFile(manifest: ForgeManifest): SandboxRequest['readFileHandler'] {
    return async path => {
        const { realpathSync, statSync, readFileSync } = await import('node:fs')
        const { resolve, relative, isAbsolute } = await import('node:path')
        const { isNieZiel } = await import('../core/action-policy.js')
        let real: string
        try { real = realpathSync(resolve(path)) } catch { throw new Error('Datei nicht gefunden') }
        if (isNieZiel(real)) throw new Error('geschütztes Ziel (Nie-Liste)')
        const inside = manifest.fs.some(root => {
            let base: string
            try { base = realpathSync(resolve(root)) } catch { return false }
            const rel = relative(base, real)
            return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
        })
        if (!inside) throw new Error('Pfad steht nicht im Manifest')
        if (statSync(real).size > MAX_RESPONSE_BYTES) throw new Error('Datei größer als 1 MB')
        return readFileSync(real, 'utf8')
    }
}
