/** Startup guards for the dedicated workstation (workstation-main.ts).
 * Pure checks take injected facts so they are testable off Linux. */
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { posix } from 'node:path'

const { join, relative, isAbsolute } = posix

export interface PathFacts { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }
export interface LogindSession { id: string; uid: number; type: string; state: string; active: boolean }

/** Owned by `uid`, the expected kind, not a symlink, and none of `forbidden` mode bits. */
export function assertOwnedPrivate(label: string, facts: PathFacts, kind: 'file' | 'dir', uid: number, forbidden: number): void {
    if (facts.isSymbolicLink()) throw Error(`${label} must not be a symbolic link`)
    if (kind === 'file' ? !facts.isFile() : !facts.isDirectory()) throw Error(`${label} must be a ${kind === 'file' ? 'regular file' : 'directory'}`)
    if (facts.uid !== uid) throw Error(`${label} must be owned by the workstation account`)
    if (facts.mode & forbidden) throw Error(`${label} has unsafe permissions ${(facts.mode & 0o777).toString(8)}; forbidden bits ${forbidden.toString(8)}`)
}

export function checkOwnedPrivatePath(label: string, path: string, kind: 'file' | 'dir', uid: number, forbidden: number): void {
    assertOwnedPrivate(label, lstatSync(path), kind, uid, forbidden)
}

/** Runtime dir: owner-only, or group search (0750) so the daemon group can
 * reach the 0660 socket. Never group-writable, never any "other" bits. */
export const RUNTIME_FORBIDDEN_BITS = 0o027
/** State, journal, shell HOME and private runtime subdir: 0700 / token 0600. */
export const PRIVATE_FORBIDDEN_BITS = 0o077

export interface WorkstationPaths {
    /** 0700 subdir of the runtime dir: Xauthority and transient captures. */
    privateDir: string; auth: string; captureDir: string
    /** Daemon-facing socket (0660) directly in the runtime dir. */
    socket: string; ready: string
    /** Durable input intents/receipts, outside the agent shell HOME. */
    journal: string
    /** HOME of the agent-controlled xterm/openbox; contains no secrets. */
    shellHome: string
}

export function planWorkstationPaths(runtime: string, state: string): WorkstationPaths {
    const privateDir = join(runtime, 'private')
    return {
        privateDir, auth: join(privateDir, 'Xauthority'), captureDir: privateDir,
        socket: join(runtime, 'desktop.sock'), ready: join(runtime, 'ready.json'),
        journal: join(state, 'input-receipts'), shellHome: join(state, 'home'),
    }
}

/** Environment for every child on the owned display (Xvfb, openbox, xterm). */
export function workstationChildEnv(paths: WorkstationPaths, display: string): Record<string, string> {
    return { PATH: '/usr/bin:/bin', HOME: paths.shellHome, DISPLAY: display, XAUTHORITY: paths.auth, XDG_SESSION_TYPE: 'x11', LANG: 'C.UTF-8' }
}

/** True when `child` is `parent` or lies below it (both already resolved). */
export function isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function assertOutsideShellHome(label: string, path: string, shellHome: string, resolve = realpathSync): void {
    if (isInside(resolve(shellHome), resolve(path))) throw Error(`${label} must not be inside the agent shell HOME`)
}

const GRAPHICAL = new Set(['x11', 'wayland', 'mir'])

/** Parses logind's runtime session records (/run/systemd/sessions/<id>). */
export function readLogindSessions(root = '/run/systemd/sessions',
    io: { list(dir: string): string[]; read(path: string): string } = { list: dir => readdirSync(dir), read: path => readFileSync(path, 'utf8') }): LogindSession[] {
    let names: string[]
    try { names = io.list(root) } catch { return [] }
    const sessions: LogindSession[] = []
    for (const id of names) {
        if (id.includes('.') || id.includes('/')) continue // skip *.ref and temp files
        let text: string
        try { text = io.read(join(root, id)) } catch { continue }
        const fields = Object.fromEntries(text.split('\n').map(line => line.split('=')).filter(p => p.length >= 2).map(([k, ...v]) => [k, v.join('=')]))
        const uid = Number(fields.UID)
        if (!Number.isInteger(uid)) continue
        sessions.push({ id, uid, type: String(fields.TYPE || ''), state: String(fields.STATE || ''), active: fields.ACTIVE === '1' })
    }
    return sessions
}

/** Refuse to run as a personal desktop user. The operator must name the
 * dedicated account explicitly, and that account must not own a graphical
 * logind session nor inherit a display from one. */
export function assertDedicatedWorkstationAccount(facts: {
    uid: number
    username: string
    expectedAccount?: string
    env: Record<string, string | undefined>
    sessions: LogindSession[]
}): void {
    if (facts.uid === 0) throw Error('Workstation must not run as root')
    if (!facts.expectedAccount || !/^[a-z_][a-z0-9_-]{0,31}$/.test(facts.expectedAccount))
        throw Error('NOVA_WORKSTATION_ACCOUNT must name the dedicated workstation account')
    if (facts.username !== facts.expectedAccount)
        throw Error(`Workstation runs as "${facts.username}", not the dedicated account "${facts.expectedAccount}"`)
    if (facts.env.DISPLAY || facts.env.WAYLAND_DISPLAY)
        throw Error('Workstation inherited a display; start it as a service, never from a personal session')
    const personal = facts.sessions.find(s => s.uid === facts.uid && GRAPHICAL.has(s.type) && s.state !== 'closing')
    if (personal) throw Error(`Account owns graphical login session ${personal.id} (${personal.type}); refusing to run as a personal desktop user`)
}
