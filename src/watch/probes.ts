/**
 * Wächter — read-only probes: Erreichbarkeit (tcp/http/https/ping), TLS-Ablauf
 * und Backup-Alter. Every probe gets exactly one validated target from the
 * resolved list (config, eingerichtete Geräte, Proxmox-Gäste) — there is no
 * range, no port list and no discovery here, so no port scan is possible.
 * Hard timeouts everywhere; nothing sends credentials, nothing is changed.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { platform } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { isValidWatchHost, type WatchBackup, type WatchTarget, type WatchTlsHost } from './settings.js'

export interface ProbeOutcome { ok: boolean; ms: number | null; detail: string }

export interface WatchProbeDeps {
    tcp(host: string, port: number, timeoutMs: number): Promise<ProbeOutcome>
    http(url: string, timeoutMs: number): Promise<ProbeOutcome>
    ping(host: string, timeoutMs: number): Promise<ProbeOutcome>
    /** Certificate end date in ms, or null when not readable. */
    tlsValidTo(host: string, port: number, timeoutMs: number): Promise<number | null>
    /** Newest mtime (ms) of a file or of the matching entries in a directory; null when none. */
    newestMtime(path: string, pattern?: string): number | null
    now(): number
}

const elapsed = (start: number) => Date.now() - start

export function defaultTcp(host: string, port: number, timeoutMs: number): Promise<ProbeOutcome> {
    return new Promise(resolve => {
        const start = Date.now()
        const socket = netConnect({ host, port })
        const done = (ok: boolean, detail: string) => { socket.destroy(); resolve({ ok, ms: ok ? elapsed(start) : null, detail }) }
        socket.setTimeout(timeoutMs, () => done(false, `Zeitlimit ${timeoutMs} ms`))
        socket.once('connect', () => done(true, 'verbunden'))
        socket.once('error', error => done(false, String((error as NodeJS.ErrnoException).code || error.message).slice(0, 60)))
    })
}

/** Any HTTP answer below 500 counts as reachable (401/403 too). Certificates
 * are not judged here; their expiry has its own check. */
export function defaultHttp(url: string, timeoutMs: number): Promise<ProbeOutcome> {
    return new Promise(resolve => {
        const start = Date.now()
        let settled = false
        const finish = (outcome: ProbeOutcome) => { if (!settled) { settled = true; resolve(outcome) } }
        const options = { method: 'GET', timeout: timeoutMs, rejectUnauthorized: false, headers: { 'user-agent': 'xaventra-waechter' } }
        const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, options, res => {
            const status = res.statusCode ?? 0
            res.destroy()
            finish({ ok: status > 0 && status < 500, ms: elapsed(start), detail: `HTTP ${status}` })
        })
        req.once('timeout', () => { req.destroy(); finish({ ok: false, ms: null, detail: `Zeitlimit ${timeoutMs} ms` }) })
        req.once('error', error => finish({ ok: false, ms: null, detail: String((error as NodeJS.ErrnoException).code || error.message).slice(0, 60) }))
        req.end()
    })
}

export function defaultPing(host: string, timeoutMs: number): Promise<ProbeOutcome> {
    // Fixed argv; the host passed isValidWatchHost (starts alphanumeric, never an option).
    const argv = platform() === 'win32'
        ? ['-n', '1', '-w', String(timeoutMs), host]
        : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host]
    return new Promise(resolve => {
        const start = Date.now()
        execFile('ping', argv, { timeout: timeoutMs + 1000, windowsHide: true }, error => {
            resolve(error ? { ok: false, ms: null, detail: 'keine Antwort' } : { ok: true, ms: elapsed(start), detail: 'Antwort' })
        })
    })
}

export function defaultTlsValidTo(host: string, port: number, timeoutMs: number): Promise<number | null> {
    return new Promise(resolve => {
        let settled = false
        const finish = (value: number | null) => { if (!settled) { settled = true; socket.destroy(); resolve(value) } }
        const socket = tlsConnect({ host, port, servername: /^[\d.:]+$/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
            const end = Date.parse(socket.getPeerCertificate()?.valid_to || '')
            finish(Number.isFinite(end) ? end : null)
        })
        socket.once('timeout', () => finish(null))
        socket.once('error', () => finish(null))
    })
}

function globToRegExp(pattern: string): RegExp {
    return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\-]/g, char => `\\${char}`).replace(/\*/g, '.*')}$`)
}

/** stat only — file contents are never opened. */
export function defaultNewestMtime(path: string, pattern?: string): number | null {
    try {
        if (!existsSync(path)) return null
        const stats = statSync(path)
        if (!stats.isDirectory()) return stats.mtimeMs
        const match = pattern ? globToRegExp(pattern) : null
        let newest: number | null = null
        for (const name of readdirSync(path).slice(0, 5000)) {
            if (match && !match.test(name)) continue
            try { newest = Math.max(newest ?? 0, statSync(join(path, name)).mtimeMs) } catch { /* vanished */ }
        }
        return newest
    } catch { return null }
}

export const defaultWatchProbeDeps: WatchProbeDeps = {
    tcp: defaultTcp, http: defaultHttp, ping: defaultPing, tlsValidTo: defaultTlsValidTo, newestMtime: defaultNewestMtime, now: Date.now,
}

export interface ReachabilityResult { target: WatchTarget; ok: boolean; ms: number | null; detail: string; at: string }

export async function probeTarget(target: WatchTarget, deps: WatchProbeDeps, timeoutMs: number): Promise<ReachabilityResult> {
    const at = new Date(deps.now()).toISOString()
    if (!isValidWatchHost(target.host)) return { target, ok: false, ms: null, detail: 'ungültiger Host – nicht geprüft', at }
    let outcome: ProbeOutcome
    try {
        if (target.kind === 'tcp') outcome = await deps.tcp(target.host, target.port!, timeoutMs)
        else if (target.kind === 'ping') outcome = await deps.ping(target.host, timeoutMs)
        else {
            const host = target.host.includes(':') ? `[${target.host}]` : target.host
            outcome = await deps.http(`${target.kind}://${host}:${target.port}${target.path ?? '/'}`, timeoutMs)
        }
    } catch (error) {
        outcome = { ok: false, ms: null, detail: String((error as Error)?.message || error).slice(0, 60) }
    }
    return { target, ok: outcome.ok, ms: outcome.ms, detail: outcome.detail, at }
}

/** Probes exactly the given list, at most 4 at a time. */
export async function probeTargets(targets: readonly WatchTarget[], deps: WatchProbeDeps, timeoutMs: number): Promise<ReachabilityResult[]> {
    const results: ReachabilityResult[] = new Array(targets.length)
    let next = 0
    const worker = async () => { while (next < targets.length) { const index = next++; results[index] = await probeTarget(targets[index], deps, timeoutMs) } }
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
    return results
}

export async function readCertificates(hosts: readonly WatchTlsHost[], deps: WatchProbeDeps, timeoutMs: number): Promise<Array<{ host: WatchTlsHost; validTo: number | null }>> {
    const out: Array<{ host: WatchTlsHost; validTo: number | null }> = []
    for (const host of hosts) out.push({ host, validTo: await deps.tlsValidTo(host.host, host.port, timeoutMs).catch(() => null) })
    return out
}

export function readBackupAges(backups: readonly WatchBackup[], deps: WatchProbeDeps): Array<{ backup: WatchBackup; newest: number | null }> {
    return backups.map(backup => ({ backup, newest: deps.newestMtime(backup.path, backup.pattern) }))
}
