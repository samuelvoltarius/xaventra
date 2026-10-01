/**
 * Eine SSH-Abfrage je Knoten (2.82.0 Aufräumen „Inventar“).
 *
 * L21 (Gesundheit), AIScan (Software-Inventar) und NodeIntelligence
 * (Befehls-Erkennung) sprachen dieselben config.nodes je mit eigenem ssh-Aufruf
 * an — ein toter Knoten kostete drei Zeitlimits je Runde. Jetzt gehen alle
 * durch diesen einen Ausführer:
 *   - gleiche feste Optionen (BatchMode, accept-new, ConnectTimeout), kein Shell,
 *     Ziel nur `[user@]host` (kein Optionsschmuggel);
 *   - geteilte Erreichbarkeit: scheitert die Verbindung selbst (ssh-Exit 255,
 *     Zeitlimit), überspringen AIScan und NodeIntelligence den Knoten 5 Minuten
 *     lang; L21 misst die Erreichbarkeit (`measure: true`) und versucht es immer;
 *   - geteilte Antworten: derselbe Befehl an denselben Knoten innerhalb von
 *     `cacheMs` wird nicht noch einmal geschickt.
 */
import { execFile } from 'node:child_process'
import { isIP } from 'node:net'

export const SSH_UNREACHABLE_HOLD_MS = 5 * 60_000

export interface SshOutcome { ok: boolean; stdout: string; cached?: boolean; error: string; unreachable: boolean; skipped: boolean }

type Exec = (args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; exitCode: number | null; error?: string; timedOut?: boolean }>

const defaultExec: Exec = (args, options) => new Promise(resolve => {
    execFile('ssh', args, { timeout: options.timeout, maxBuffer: options.maxBuffer, windowsHide: true }, (error, stdout) => {
        if (!error) { resolve({ stdout: String(stdout), exitCode: 0 }); return }
        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }
        resolve({ stdout: String(stdout || ''), exitCode: typeof err.code === 'number' ? err.code : null, error: String(err.message || err).slice(0, 300), timedOut: err.killed === true })
    })
})

let exec: Exec = defaultExec
let now: () => number = Date.now
const reach = new Map<string, { ok: boolean; at: number; reason?: string }>()
const answers = new Map<string, { at: number; stdout: string }>()
const inflight = new Map<string, Promise<SshOutcome>>()

/** Optional `user@` plus a literal IP or plain hostname; never an ssh option. */
export function isSafeNodeSshTarget(host: unknown): host is string {
    if (typeof host !== 'string' || host.length > 300 || host.startsWith('-')) return false
    const at = host.lastIndexOf('@')
    const user = at >= 0 ? host.slice(0, at) : ''
    const target = at >= 0 ? host.slice(at + 1) : host
    if (at >= 0 && !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(user)) return false
    if (isIP(target)) return true
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(target)
}

const hostKey = (host: string) => host.slice(host.lastIndexOf('@') + 1).toLowerCase()

/** Shared reachability of a node over SSH (null = never asked). */
export function sshReachability(host: string): { ok: boolean; at: number; reason?: string } | null {
    return reach.get(hostKey(host)) ?? null
}

/**
 * Runs one remote command. A failing remote command (exit ≠ 255) is not a
 * reachability problem; only a failed connection is shared with the others.
 */
export async function sshNodeRun(host: string, command: string, options: { timeoutMs?: number; connectTimeoutS?: number; maxBuffer?: number; cacheMs?: number; measure?: boolean } = {}): Promise<SshOutcome> {
    if (!isSafeNodeSshTarget(host)) return { ok: false, stdout: '', error: 'SSH-Ziel abgelehnt (nur [user@]host)', unreachable: false, skipped: true }
    const key = hostKey(host)
    const state = reach.get(key)
    if (!options.measure && state && !state.ok && now() - state.at < SSH_UNREACHABLE_HOLD_MS) {
        return { ok: false, stdout: '', error: `zuletzt nicht erreichbar (${state.reason || 'ssh'}) — geteilt, kein neuer Versuch`, unreachable: true, skipped: true }
    }
    const answerKey = `${host}\u0000${command}`
    const cached = answers.get(answerKey)
    if (cached && options.cacheMs && now() - cached.at < options.cacheMs) return { ok: true, stdout: cached.stdout, cached: true, error: '', unreachable: false, skipped: false }
    const running = inflight.get(answerKey)
    if (running) return running
    const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', `ConnectTimeout=${Math.max(1, Math.min(30, options.connectTimeoutS ?? 5))}`, '-o', 'BatchMode=yes', '--', host, command]
    const run = exec(args, { timeout: options.timeoutMs ?? 10_000, maxBuffer: options.maxBuffer ?? 1024 * 1024 }).then((result): SshOutcome => {
        if (result.exitCode === 0) {
            reach.set(key, { ok: true, at: now() })
            answers.set(answerKey, { at: now(), stdout: result.stdout.trim() })
            while (answers.size > 256) answers.delete(answers.keys().next().value!)
            return { ok: true, stdout: result.stdout.trim(), cached: false, error: '', unreachable: false, skipped: false }
        }
        const unreachable = result.exitCode === 255 || result.exitCode === null || result.timedOut === true
        if (unreachable) reach.set(key, { ok: false, at: now(), reason: result.timedOut ? 'Zeitlimit' : 'Verbindung' })
        else reach.set(key, { ok: true, at: now() })
        return { ok: false, stdout: result.stdout, error: result.error || `Exit ${result.exitCode}`, unreachable, skipped: false }
    }).finally(() => inflight.delete(answerKey))
    inflight.set(answerKey, run)
    return run
}

/** Tests only. */
export function resetNodeSsh(options: { exec?: Exec; now?: () => number } = {}): void {
    exec = options.exec ?? defaultExec
    now = options.now ?? Date.now
    reach.clear(); answers.clear(); inflight.clear()
}
