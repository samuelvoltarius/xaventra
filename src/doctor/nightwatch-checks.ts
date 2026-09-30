/**
 * Nachtwache — read-only probes for services, disks, backups and cron targets.
 *
 * Every probe is a fixed argv built here from validated config values. Config
 * never supplies a command or shell fragment, and nothing here changes state on
 * any host. A probe that cannot observe its target reports `unbekannt`, never
 * `ok`: an unreachable source is not evidence that everything is fine.
 */

import { execFile } from 'node:child_process'
import { redactSecrets } from '../security/secret-redaction.js'

export type NightwatchStatus = 'ok' | 'fehler' | 'unbekannt'
export type NightwatchSeverity = 'warning' | 'critical'

export type NightwatchHost =
    | { kind: 'local' }
    | { kind: 'ssh'; target: string; port?: number; identityFile?: string }

interface CheckBase {
    id: string
    label?: string
    /** Key into `hosts`; defaults to `local`. Ignored for http probes. */
    host?: string
    /** Severity when the check fails. */
    severity?: NightwatchSeverity
    timeoutMs?: number
}

export type NightwatchCheck =
    | CheckBase & { kind: 'http'; url: string; expectStatus?: number[] }
    | CheckBase & { kind: 'systemd'; unit: string; user?: boolean }
    | CheckBase & { kind: 'disk'; mount: string; warnPercent?: number; critPercent?: number }
    | CheckBase & { kind: 'backup'; dir: string; maxAgeHours: number; namePattern?: string }
    | CheckBase & { kind: 'file'; path: string; executable?: boolean }

export interface NightwatchConfig {
    version: 1
    /** Minimum minutes between two real runs; callers in between get the cached report. */
    intervalMinutes?: number
    hosts: Record<string, NightwatchHost>
    checks: NightwatchCheck[]
}

export interface NightwatchEvidence {
    host: string
    command: string
    exitCode: number | null
    output: string
    durationMs: number
    checkedAt: string
}

export interface NightwatchResult {
    id: string
    kind: NightwatchCheck['kind']
    label: string
    host: string
    status: NightwatchStatus
    /** Only meaningful when status is not `ok`. */
    severity: NightwatchSeverity
    message: string
    evidence: NightwatchEvidence
}

export interface CommandOutcome {
    exitCode: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    spawnError?: string
}

export type CommandRunner = (host: NightwatchHost, argv: readonly string[], timeoutMs: number) => Promise<CommandOutcome>
export type HttpFetcher = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number }>

export interface ProbeDeps {
    runner?: CommandRunner
    fetcher?: HttpFetcher
    now?: () => number
}

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_TIMEOUT_MS = 120_000
const EVIDENCE_OUTPUT_LIMIT = 400
const SSH_UNREACHABLE_EXIT = 255

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HOST_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const UNIT_RE = /^[A-Za-z0-9@_:][A-Za-z0-9@._:-]{0,127}$/
const PATH_RE = /^\/(?:[A-Za-z0-9._@+-]+\/?)*$/
const NAME_PATTERN_RE = /^[A-Za-z0-9._*?][A-Za-z0-9._*?-]{0,63}$/
const SSH_TARGET_RE = /^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/

function isSafePath(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 512 || !PATH_RE.test(value)) return false
    return !value.split('/').some(segment => segment === '.' || segment === '..')
}

function isPercent(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100
}

/** Validates untrusted JSON into a config. Throws with every problem found, so
 * a broken config is reported as a whole instead of silently skipping checks. */
export function parseNightwatchConfig(raw: unknown): NightwatchConfig {
    const errors: string[] = []
    const input = raw as any
    if (!input || typeof input !== 'object') throw new Error('Nachtwache-Konfiguration: kein Objekt')
    if (input.version !== 1) errors.push('version muss 1 sein')
    if (input.intervalMinutes !== undefined && !(Number.isInteger(input.intervalMinutes) && input.intervalMinutes >= 1 && input.intervalMinutes <= 1440)) {
        errors.push('intervalMinutes muss eine ganze Zahl 1–1440 sein')
    }

    const hosts: Record<string, NightwatchHost> = { local: { kind: 'local' } }
    for (const [key, value] of Object.entries(input.hosts || {})) {
        const host = value as any
        if (!HOST_KEY_RE.test(key)) { errors.push(`hosts.${key}: ungültiger Name`); continue }
        if (host?.kind === 'local') { hosts[key] = { kind: 'local' }; continue }
        if (host?.kind !== 'ssh') { errors.push(`hosts.${key}: kind muss local oder ssh sein`); continue }
        if (typeof host.target !== 'string' || !SSH_TARGET_RE.test(host.target)) errors.push(`hosts.${key}: target muss user@host sein`)
        if (host.port !== undefined && !(Number.isInteger(host.port) && host.port >= 1 && host.port <= 65535)) errors.push(`hosts.${key}: ungültiger port`)
        if (host.identityFile !== undefined && !isSafePath(host.identityFile)) errors.push(`hosts.${key}: identityFile muss ein absoluter Pfad sein`)
        hosts[key] = { kind: 'ssh', target: host.target, ...(host.port !== undefined ? { port: host.port } : {}), ...(host.identityFile !== undefined ? { identityFile: host.identityFile } : {}) }
    }

    const checks: NightwatchCheck[] = []
    const seen = new Set<string>()
    if (!Array.isArray(input.checks) || input.checks.length === 0) errors.push('checks muss eine nicht leere Liste sein')
    for (const [index, value] of (Array.isArray(input.checks) ? input.checks : []).entries()) {
        const check = value as any
        const where = `checks[${index}]${typeof check?.id === 'string' ? ` (${check.id})` : ''}`
        if (typeof check?.id !== 'string' || !ID_RE.test(check.id)) { errors.push(`${where}: ungültige id`); continue }
        if (seen.has(check.id)) errors.push(`${where}: id doppelt`)
        seen.add(check.id)
        if (check.label !== undefined && (typeof check.label !== 'string' || check.label.length > 80)) errors.push(`${where}: label zu lang`)
        if (check.host !== undefined && !(check.host in hosts)) errors.push(`${where}: unbekannter host ${JSON.stringify(check.host)}`)
        if (check.severity !== undefined && check.severity !== 'warning' && check.severity !== 'critical') errors.push(`${where}: severity muss warning oder critical sein`)
        if (check.timeoutMs !== undefined && !(Number.isInteger(check.timeoutMs) && check.timeoutMs >= 1000 && check.timeoutMs <= MAX_TIMEOUT_MS)) errors.push(`${where}: timeoutMs 1000–${MAX_TIMEOUT_MS}`)
        switch (check.kind) {
            case 'http': {
                let url: URL | null = null
                try { url = new URL(check.url) } catch { /* reported below */ }
                if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) errors.push(`${where}: url muss http(s) sein`)
                else if (url.username || url.password) errors.push(`${where}: url darf keine Zugangsdaten enthalten`)
                if (check.expectStatus !== undefined && !(Array.isArray(check.expectStatus) && check.expectStatus.length > 0
                    && check.expectStatus.every((code: unknown) => Number.isInteger(code) && (code as number) >= 100 && (code as number) <= 599))) {
                    errors.push(`${where}: expectStatus muss eine Liste von HTTP-Codes sein`)
                }
                break
            }
            case 'systemd':
                if (typeof check.unit !== 'string' || !UNIT_RE.test(check.unit)) errors.push(`${where}: ungültiger unit-Name`)
                if (check.user !== undefined && typeof check.user !== 'boolean') errors.push(`${where}: user muss boolean sein`)
                break
            case 'disk': {
                if (!isSafePath(check.mount)) errors.push(`${where}: mount muss ein absoluter Pfad sein`)
                const warn = check.warnPercent ?? 85, crit = check.critPercent ?? 95
                if (!isPercent(warn) || !isPercent(crit) || warn > crit) errors.push(`${where}: Schwellen 0–100 und warnPercent ≤ critPercent`)
                break
            }
            case 'backup':
                if (!isSafePath(check.dir)) errors.push(`${where}: dir muss ein absoluter Pfad sein`)
                if (!(typeof check.maxAgeHours === 'number' && check.maxAgeHours > 0 && check.maxAgeHours <= 24 * 90)) errors.push(`${where}: maxAgeHours fehlt oder ungültig`)
                if (check.namePattern !== undefined && (typeof check.namePattern !== 'string' || !NAME_PATTERN_RE.test(check.namePattern))) errors.push(`${where}: ungültiges namePattern`)
                break
            case 'file':
                if (!isSafePath(check.path)) errors.push(`${where}: path muss ein absoluter Pfad sein`)
                if (check.executable !== undefined && typeof check.executable !== 'boolean') errors.push(`${where}: executable muss boolean sein`)
                break
            default:
                errors.push(`${where}: unbekannte Prüfart ${JSON.stringify(check.kind)}`)
                continue
        }
        checks.push(check as NightwatchCheck)
    }

    if (errors.length) throw new Error(`Nachtwache-Konfiguration ungültig: ${errors.join('; ')}`)
    return { version: 1, ...(input.intervalMinutes !== undefined ? { intervalMinutes: input.intervalMinutes } : {}), hosts, checks }
}

/** POSIX single-quote one argument for the remote login shell. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildSshArgs(host: Extract<NightwatchHost, { kind: 'ssh' }>, argv: readonly string[], timeoutMs: number): string[] {
    const connectTimeout = Math.max(3, Math.min(15, Math.floor(timeoutMs / 2000)))
    return [
        '-T',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', `ConnectTimeout=${connectTimeout}`,
        '-o', 'ClearAllForwardings=yes',
        ...(host.port ? ['-p', String(host.port)] : []),
        ...(host.identityFile ? ['-i', host.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
        '--',
        host.target,
        argv.map(shellQuote).join(' '),
    ]
}

const PASSTHROUGH_ENV = ['HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const

/** Default runner: execFile only, never a local shell. SSH runs the fixed argv
 * on the remote side, each argument single-quoted. */
export const execFileRunner: CommandRunner = (host, argv, timeoutMs) => new Promise(resolve => {
    const [file, args] = host.kind === 'ssh' ? ['ssh', buildSshArgs(host, argv, timeoutMs)] : [argv[0], argv.slice(1)]
    const env: Record<string, string> = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }
    for (const key of PASSTHROUGH_ENV) if (process.env[key]) env[key] = process.env[key] as string
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env, windowsHide: true }, (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string }) | null
        if (!err) return resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr), timedOut: false })
        const timedOut = Boolean(err.killed && err.signal)
        if (typeof err.code === 'string') return resolve({ exitCode: null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut, spawnError: err.code })
        resolve({ exitCode: typeof err.code === 'number' ? err.code : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut })
    })
})

const defaultFetcher: HttpFetcher = (url, init) => fetch(url, init)

function excerpt(value: string): string {
    const clean = redactSecrets(value.replace(/\r/g, '').trim())
    return clean.length > EVIDENCE_OUTPUT_LIMIT ? `${clean.slice(0, EVIDENCE_OUTPUT_LIMIT)}…` : clean
}

export function commandFor(check: NightwatchCheck): string[] | null {
    switch (check.kind) {
        case 'systemd': return ['systemctl', ...(check.user ? ['--user'] : []), 'is-active', '--', check.unit]
        case 'disk': return ['df', '-P', '-k', '--', check.mount]
        case 'backup': return ['find', check.dir, '-maxdepth', '1', '-type', 'f', ...(check.namePattern ? ['-name', check.namePattern] : []), '-printf', '%T@\\n']
        case 'file': return ['test', check.executable ? '-x' : '-f', check.path]
        case 'http': return null
    }
}

function defaultSeverity(check: NightwatchCheck): NightwatchSeverity {
    if (check.severity) return check.severity
    return check.kind === 'http' || check.kind === 'systemd' ? 'critical' : 'warning'
}

type Verdict = { status: NightwatchStatus; message: string; severity?: NightwatchSeverity }

function unreachable(outcome: CommandOutcome, host: NightwatchHost): Verdict | null {
    if (outcome.timedOut) return { status: 'unbekannt', message: 'Zeitüberschreitung, Zustand nicht prüfbar' }
    if (outcome.spawnError) return { status: 'unbekannt', message: `Prüfbefehl nicht startbar (${outcome.spawnError})` }
    if (host.kind === 'ssh' && outcome.exitCode === SSH_UNREACHABLE_EXIT) return { status: 'unbekannt', message: 'Host per SSH nicht erreichbar, Zustand nicht prüfbar' }
    if (outcome.exitCode === null) return { status: 'unbekannt', message: 'Prüfbefehl ohne Exitcode beendet' }
    return null
}

function judge(check: NightwatchCheck, outcome: CommandOutcome, host: NightwatchHost, nowMs: number): Verdict {
    const blocked = unreachable(outcome, host)
    if (blocked) return blocked
    const out = outcome.stdout.trim()
    switch (check.kind) {
        case 'systemd': {
            const state = out.split('\n').pop()?.trim() || ''
            if (state === 'active' && outcome.exitCode === 0) return { status: 'ok', message: 'aktiv' }
            if (['failed', 'inactive', 'deactivating'].includes(state)) return { status: 'fehler', message: `Dienst ${state}` }
            return { status: 'unbekannt', message: `Zustand ${JSON.stringify(state || outcome.stderr.trim().slice(0, 80))}` }
        }
        case 'disk': {
            if (outcome.exitCode !== 0) return { status: 'unbekannt', message: `df Exitcode ${outcome.exitCode}` }
            const fields = out.split('\n').pop()?.trim().split(/\s+/) || []
            const match = /^(\d{1,3})%$/.exec(fields[4] || '')
            if (!match) return { status: 'unbekannt', message: 'df-Ausgabe nicht lesbar' }
            const used = Number(match[1])
            const warn = check.warnPercent ?? 85, crit = check.critPercent ?? 95
            if (used >= crit) return { status: 'fehler', severity: 'critical', message: `Platte ${used} % voll (Grenze ${crit} %)` }
            if (used >= warn) return { status: 'fehler', severity: 'warning', message: `Platte ${used} % voll (Warnung ab ${warn} %)` }
            return { status: 'ok', message: `${used} % belegt` }
        }
        case 'backup': {
            if (outcome.exitCode !== 0) {
                if (/no such file or directory/i.test(outcome.stderr)) return { status: 'fehler', message: 'Backup-Ordner fehlt' }
                return { status: 'unbekannt', message: `find Exitcode ${outcome.exitCode}: ${outcome.stderr.trim().slice(0, 80)}` }
            }
            const stamps = out.split('\n').map(line => Number(line.trim())).filter(value => Number.isFinite(value) && value > 0)
            if (stamps.length === 0) return { status: 'fehler', message: 'kein Backup gefunden' }
            const ageHours = (nowMs / 1000 - Math.max(...stamps)) / 3600
            if (ageHours > check.maxAgeHours) return { status: 'fehler', message: `jüngstes Backup ${Math.round(ageHours)} h alt (Grenze ${check.maxAgeHours} h)` }
            return { status: 'ok', message: `jüngstes Backup ${Math.max(0, Math.round(ageHours))} h alt` }
        }
        case 'file':
            if (outcome.exitCode === 0) return { status: 'ok', message: 'vorhanden' }
            if (outcome.exitCode === 1) return { status: 'fehler', message: check.executable ? 'fehlt oder nicht ausführbar' : 'fehlt' }
            return { status: 'unbekannt', message: `test Exitcode ${outcome.exitCode}` }
        case 'http':
            return { status: 'unbekannt', message: 'interner Fehler: http ohne Befehl' }
    }
}

async function probeHttp(check: Extract<NightwatchCheck, { kind: 'http' }>, fetcher: HttpFetcher, timeoutMs: number): Promise<{ verdict: Verdict; status: number | null; detail: string }> {
    try {
        const response = await fetcher(check.url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
        const ok = check.expectStatus ? check.expectStatus.includes(response.status) : response.status >= 200 && response.status < 400
        return { verdict: ok ? { status: 'ok', message: `HTTP ${response.status}` } : { status: 'fehler', message: `HTTP ${response.status}` }, status: response.status, detail: `HTTP ${response.status}` }
    } catch (error) {
        const name = (error as Error)?.name
        const message = name === 'TimeoutError' || name === 'AbortError' ? 'keine Antwort (Zeitüberschreitung)' : 'nicht erreichbar'
        // The daemon could not reach the service: for a watchdog that is a failure of the target, not "unknown".
        return { verdict: { status: 'fehler', message }, status: null, detail: String(error).slice(0, 180) }
    }
}

/** `unbekannt` never wakes anyone at night: it goes into the daytime bundle.
 * A service that is really down is caught by its own http/systemd probe. */
function severityFor(verdict: Verdict, fallback: NightwatchSeverity): NightwatchSeverity {
    if (verdict.status === 'unbekannt') return 'warning'
    return verdict.severity ?? fallback
}

/** Runs one check. Never throws: every internal failure becomes `unbekannt`. */
export async function runCheck(check: NightwatchCheck, hosts: Record<string, NightwatchHost>, deps: ProbeDeps = {}): Promise<NightwatchResult> {
    const now = deps.now ?? Date.now
    const started = now()
    const hostKey = check.kind === 'http' ? 'local' : (check.host ?? 'local')
    const host = hosts[hostKey] ?? { kind: 'local' as const }
    const timeoutMs = Math.min(check.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const base = { id: check.id, kind: check.kind, label: check.label || check.id, host: hostKey, severity: defaultSeverity(check) }
    const evidence = (command: string, exitCode: number | null, output: string): NightwatchEvidence => ({
        host: hostKey, command, exitCode, output: excerpt(output), durationMs: Math.max(0, now() - started), checkedAt: new Date(started).toISOString(),
    })
    try {
        if (check.kind === 'http') {
            const probe = await probeHttp(check, deps.fetcher ?? defaultFetcher, timeoutMs)
            return { ...base, ...probe.verdict, severity: severityFor(probe.verdict, base.severity), evidence: evidence(`GET ${new URL(check.url).origin}${new URL(check.url).pathname}`, probe.status, probe.detail) }
        }
        const argv = commandFor(check)!
        const outcome = await (deps.runner ?? execFileRunner)(host, argv, timeoutMs)
        const verdict = judge(check, outcome, host, now())
        return {
            ...base,
            status: verdict.status,
            severity: severityFor(verdict, base.severity),
            message: verdict.message,
            evidence: evidence(argv.join(' '), outcome.exitCode, `${outcome.stdout}${outcome.stderr ? `\n[stderr] ${outcome.stderr}` : ''}`),
        }
    } catch (error) {
        return { ...base, status: 'unbekannt', severity: 'warning', message: 'Prüfung abgebrochen', evidence: evidence(check.kind, null, String(error)) }
    }
}
