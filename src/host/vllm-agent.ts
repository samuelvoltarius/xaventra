import { spawn } from 'node:child_process'
import { closeSync, constants, existsSync, fchownSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join, posix } from 'node:path'
import { neverListViolation } from '../install/never-list.js'
import { DEFAULT_VLLM_TARGETS, isAllowedVllmTarget, normalizeVllmTargets, verifyVllmTicket, VLLM_TARGET_PATTERN, type VllmTicket } from '../install/vllm-ticket.js'
import type { HostDockerEngine } from './docker-agent.js'

// ============================================================================
// Phase 8 (Alfred 01.10.2026): vLLM model switch at the Spark, host side.
// Runs inside the root host agent (xaventra-host.service). Accepts only signed
// single-use tickets for three fixed steps:
//   markieren  - set the maintenance marker (~/.spark-stage-saved-target) so the
//                vLLM guard does not interfere; refused if a marker exists.
//   wechseln   - start `<script> switch <ziel>` DETACHED (own session, no
//                shell) as the vLLM user; only under the agent's own marker,
//                ziel only from the closed list.
//   freigeben  - remove the agent's OWN marker (never a marker set by Alfred).
// There is no stop operation: "vLLM stoppen ohne Rückweg" stays on the Nie-Liste.
// ============================================================================

export interface VllmHostUser { uid: number; gid: number; home: string; name?: string }
export interface VllmHostOptions {
    nodeId: string
    clientId: string
    stateDir: string
    ticketPublicKey: string
    /** Runs the switch script. Node drops supplementary groups: gid must grant Docker access (e.g. the docker group). */
    user: VllmHostUser
    /** Default `<home>/spark-models.sh`. */
    script?: string
    targets?: readonly string[]
    files?: { current?: string; modelIds?: string; marker?: string }
    containerPattern?: RegExp
    now?: () => number
}
export interface VllmLaunch { pid?: number; exited: Promise<number | null> }
export interface VllmLaunchOptions { uid: number; gid: number; cwd: string; env: Record<string, string>; logPath: string }
export interface VllmLauncher { launch(file: string, args: string[], options: VllmLaunchOptions): Promise<VllmLaunch> }
export interface VllmLastLaunch { ticketId: string; planId: string; target: string; purpose: string; launchedAt: number; exitCode?: number | null }
export interface VllmHostState {
    success: true
    nodeId: string
    targets: string[]
    currentTarget: string | null
    maintenance: boolean
    /** Plan id of the agent's own marker, null when there is no own marker. */
    ownMarkerPlan: string | null
    modelIds: Record<string, string>
    switchRunning: boolean
    lastLaunch?: VllmLastLaunch
    /** undefined = no Docker view; null = no matching vLLM container running. */
    container?: { name: string; startedAt: string; running: boolean } | null
}

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const SAFE_FILE = /^\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/
const MODEL_ID = /^[A-Za-z0-9._/:@-]{1,128}$/
const NOFOLLOW: number = (constants as any).O_NOFOLLOW ?? 0
/** POSIX absolute path without '..'; on win32 (tests only) a drive path is accepted too. */
const safePath = (path: unknown): path is string => typeof path === 'string' && !path.includes('..')
    && (SAFE_FILE.test(path) || (process.platform === 'win32' && /^[A-Za-z]:[\\/][A-Za-z0-9._@+\\/ -]*$/.test(path)))

/** Reads at most 8 KiB, never through a symlink (root must not follow links the user controls). */
function readNoFollow(path: string): string | null {
    let fd: number
    try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW) } catch { return null }
    try {
        const buffer = Buffer.alloc(8192)
        const length = readSync(fd, buffer, 0, buffer.length, 0)
        return buffer.subarray(0, length).toString('utf8')
    } catch { return null } finally { closeSync(fd) }
}

/** `~/.spark-model-ids`: one `ziel=id`, `ziel id` or `ziel: id` per line; comments and unknown targets ignored. */
export function parseModelIds(text: string | null, targets: readonly string[]): Record<string, string> {
    const result: Record<string, string> = {}
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim()
        const match = /^([a-z0-9][a-z0-9_-]{0,31})\s*(?:=|:|\s)\s*["']?([^"'\s]+)["']?$/.exec(line)
        if (match && targets.includes(match[1]) && MODEL_ID.test(match[2])) result[match[1]] = match[2]
    }
    return result
}

export function parseCurrentTarget(text: string | null): string | null {
    const value = String(text || '').split(/\r?\n/)[0]?.trim() || ''
    return VLLM_TARGET_PATTERN.test(value) ? value : null
}

/** Production launcher: own session (setsid semantics via `detached`), no shell, output to a log, never awaited. */
export function detachedLauncher(): VllmLauncher {
    return {
        launch: (file, args, options) => new Promise((resolve, reject) => {
            const log = openSync(options.logPath, 'a', 0o600)
            let child: ReturnType<typeof spawn>
            try {
                child = spawn(file, args, { detached: true, shell: false, uid: options.uid, gid: options.gid, cwd: options.cwd, env: options.env, stdio: ['ignore', log, log], windowsHide: true })
            } catch (error) { closeSync(log); reject(error); return }
            closeSync(log)
            const exited = new Promise<number | null>(done => { child.once('exit', code => done(code)); child.once('error', () => done(-1)) })
            child.once('error', error => reject(error))
            child.once('spawn', () => { child.unref(); resolve({ pid: child.pid, exited }) })
        }),
    }
}

export function createHostVllmSwitcher(options: VllmHostOptions, launcher: VllmLauncher = detachedLauncher(), engine?: HostDockerEngine) {
    const opt = { ...options }
    const now = opt.now || Date.now
    if (!opt.nodeId || !opt.clientId || !opt.ticketPublicKey) throw Error('vLLM-Wechsel braucht Knoten, Client und Ticket-Schlüssel')
    const user = opt.user
    if (!user || !Number.isInteger(user.uid) || !Number.isInteger(user.gid) || user.uid === 0 || user.gid === 0
        || !safePath(user.home) || (user.name !== undefined && !/^[a-z_][a-z0-9_-]{0,31}$/.test(user.name))) {
        throw Error('vLLM-Benutzer ungültig (nicht root, sicherer Home-Pfad)')
    }
    const targets = opt.targets ? normalizeVllmTargets(opt.targets) : [...DEFAULT_VLLM_TARGETS]
    const script = opt.script || posix.join(user.home, 'spark-models.sh')
    const files = {
        current: opt.files?.current || posix.join(user.home, '.spark-current-model'),
        modelIds: opt.files?.modelIds || posix.join(user.home, '.spark-model-ids'),
        marker: opt.files?.marker || posix.join(user.home, '.spark-stage-saved-target'),
    }
    for (const path of [script, files.current, files.modelIds, files.marker]) {
        if (!safePath(path)) throw Error('Unsicherer Pfad für den vLLM-Wechsel')
    }
    const containerPattern = opt.containerPattern || /^\/?sparkrun_.+_solo$/
    const root = join(opt.stateDir, 'vllm')
    const ticketDir = join(root, 'tickets')
    mkdirSync(ticketDir, { recursive: true, mode: 0o700 })
    const ownMarkerFile = join(root, 'own-marker.json')
    let running: (VllmLastLaunch & { alive: boolean }) | null = null

    const ownMarker = (): { planId: string; at: number } | null => {
        try { const value = JSON.parse(readFileSync(ownMarkerFile, 'utf8')); return typeof value?.planId === 'string' ? value : null } catch { return null }
    }
    const setOwnMarker = (value: { planId: string; at: number } | null) => {
        if (!value) { try { unlinkSync(ownMarkerFile) } catch { /* already gone */ } return }
        writeFileSync(ownMarkerFile, JSON.stringify(value), { mode: 0o600 })
    }
    // lstat: a dangling symlink also counts as "marker present" (fail-safe).
    const markerExists = () => { try { lstatSync(files.marker); return true } catch { return false } }

    async function container(): Promise<VllmHostState['container']> {
        if (!engine) return undefined
        try {
            const rows = await engine.call('GET', '/containers/json?all=0')
            const row = (Array.isArray(rows) ? rows : []).find((item: any) => (item?.Names || []).some((name: string) => containerPattern.test(String(name))))
            if (!row || !/^[a-f0-9]{64}$/.test(String(row.Id))) return null
            const info = await engine.call('GET', `/containers/${row.Id}/json`)
            return { name: String(info?.Name || row.Names[0]).replace(/^\//, ''), startedAt: String(info?.State?.StartedAt || ''), running: info?.State?.Running === true }
        } catch { return undefined }
    }

    async function state(): Promise<VllmHostState> {
        const own = ownMarker()
        const last = running ? { ticketId: running.ticketId, planId: running.planId, target: running.target, purpose: running.purpose, launchedAt: running.launchedAt, exitCode: running.exitCode } : undefined
        return {
            success: true, nodeId: opt.nodeId, targets: [...targets],
            currentTarget: parseCurrentTarget(readNoFollow(files.current)),
            maintenance: markerExists(), ownMarkerPlan: own?.planId || null,
            modelIds: parseModelIds(readNoFollow(files.modelIds), targets),
            switchRunning: running?.alive === true,
            ...(last ? { lastLaunch: last } : {}),
            container: await container(),
        }
    }

    /** Single use: the ticket id is recorded before any work (exclusive create). */
    function consumeTicket(ticket: VllmTicket): void {
        const fd = openSync(join(ticketDir, `${ticket.id}.json`), 'wx', 0o600)
        try { writeSync(fd, JSON.stringify({ ticket, at: now() })); fsyncSync(fd) } finally { closeSync(fd) }
    }

    async function action(signed: unknown): Promise<Record<string, unknown>> {
        const ticket = verifyVllmTicket(signed, { nodeId: opt.nodeId, clientId: opt.clientId, publicKey: opt.ticketPublicKey, targets, now: now() })
        if (existsSync(join(ticketDir, `${ticket.id}.json`))) throw Error('Ticket bereits verwendet')
        const own = ownMarker()
        if (ticket.operation === 'markieren') {
            if (ticket.purpose !== 'wechsel') throw Error('Wartungsmarke nur zu Beginn eines Wechsels')
            if (markerExists()) throw Error('Wartungsmarke existiert bereits (laufende Wartung) — kein Wechsel')
            if (running?.alive) throw Error('Ein Wechsel läuft bereits')
            const current = parseCurrentTarget(readNoFollow(files.current))
            if (!current) throw Error('Aktuelles Ziel nicht lesbar — kein Rückweg, kein Wechsel')
            consumeTicket(ticket)
            // O_EXCL + O_NOFOLLOW: never overwrite, never follow a link placed by the user.
            const fd = openSync(files.marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644)
            try {
                writeSync(fd, `${current}\n`); fsyncSync(fd)
                // Hand the marker to the vLLM user. Only root can chown; the host agent runs as
                // root in production. Unprivileged (CI, tests) the file stays with the agent user.
                if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) fchownSync(fd, user.uid, user.gid)
            } finally { closeSync(fd) }
            setOwnMarker({ planId: ticket.planId, at: now() })
            return { success: true, operation: 'markieren', nodeId: opt.nodeId, savedTarget: current }
        }
        if (ticket.operation === 'freigeben') {
            if (!own || own.planId !== ticket.planId) throw Error('Keine eigene Wartungsmarke für diesen Plan — fremde Marke bleibt')
            consumeTicket(ticket)
            try { unlinkSync(files.marker) } catch { /* already gone */ }
            setOwnMarker(null)
            return { success: true, operation: 'freigeben', nodeId: opt.nodeId }
        }
        // wechseln
        if (!own || own.planId !== ticket.planId || !markerExists()) throw Error('Wechsel nur unter der eigenen Wartungsmarke dieses Plans')
        // A hung start of the previous switch must not block the way back; a new switch must wait.
        if (running?.alive && ticket.purpose === 'wechsel') throw Error('Ein Wechsel läuft bereits')
        if (!isAllowedVllmTarget(ticket.target, targets)) throw Error('Ziel nicht auf der geschlossenen Liste')
        const argv = [script, 'switch', ticket.target]
        const never = neverListViolation(argv)
        if (never) throw Error(`Nie-Liste: ${never.ruleId}`)
        if (!existsSync(script)) throw Error('Wechsel-Skript fehlt auf diesem Host')
        consumeTicket(ticket)
        const launchedAt = now()
        const env: Record<string, string> = { PATH: `${user.home}/.local/bin:${SAFE_PATH}`, HOME: user.home, LANG: 'C.UTF-8', ...(user.name ? { USER: user.name, LOGNAME: user.name } : {}) }
        const launched = await launcher.launch(argv[0], argv.slice(1), { uid: user.uid, gid: user.gid, cwd: user.home, env, logPath: join(root, `switch-${ticket.id}.log`) })
        const entry: VllmLastLaunch & { alive: boolean } = { ticketId: ticket.id, planId: ticket.planId, target: ticket.target, purpose: ticket.purpose, launchedAt, alive: true }
        running = entry
        launched.exited.then(code => { entry.alive = false; entry.exitCode = code }, () => { entry.alive = false; entry.exitCode = -1 })
        return { success: true, operation: 'wechseln', nodeId: opt.nodeId, target: ticket.target, purpose: ticket.purpose, launchedAt, pid: launched.pid }
    }

    return { targets, state, action }
}
export type HostVllmSwitcher = ReturnType<typeof createHostVllmSwitcher>
