/**
 * Arbeitsdaten mitnehmen (2.86 Paket J Punkt 4, erster belegter Schritt).
 *
 * Quelle der Arbeitsdaten ist ein eigenes Git-Ziel im Mesh (z. B. ein Repo auf
 * dem NAS). Der ausführende Knoten holt GENAU den angegebenen Commit in ein
 * eigenes Arbeitsverzeichnis und prüft das Ergebnis. Regeln:
 *  - nur eigenes Mesh: Mesh-Knoten, Tailnet (100.64.0.0/10, *.ts.net, fd7a:115c:a1e0::/48)
 *    oder private Adressen; nichts aus/in die Cloud,
 *  - nur verschlüsselt: ssh oder https (git/http/file/ext werden abgelehnt,
 *    git selbst läuft mit protocol.allow=never + ssh/https erlaubt),
 *  - keine Zugangsdaten in der URL, keine Optionen über URL/Commit, keine Shell.
 *
 * Noch NICHT verdrahtet (Entwurf in docs/MESH_WORKDATA.md): die Übergabe im
 * agent.request, das Zurückschreiben der Ergebnisse und die Verschlüsselung
 * im Ruhezustand auf dem NAS.
 */
import { execFile } from 'node:child_process'
import { isIP } from 'node:net'

export type WorkspaceTransport = 'ssh' | 'https'
export type SourceAssessment = { ok: true; transport: WorkspaceTransport; host: string } | { ok: false; reason: string }

export interface WorkspaceHandoff {
    /** Mesh git source, e.g. ssh://git@xaventra-nas/srv/git/projekt.git */
    source: string
    /** Full commit id (40 or 64 hex); branch names are not accepted (no moving target). */
    commit: string
}

export type GitRunner = (args: string[], options?: { cwd?: string }) => Promise<{ code: number; stdout: string; stderr?: string }>

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

function privateOrTailnetIp(host: string): boolean {
    const version = isIP(host)
    if (version === 4) {
        const [a, b] = host.split('.').map(Number)
        return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    }
    if (version === 6) {
        const lower = host.toLowerCase()
        return lower.startsWith('fd7a:115c:a1e0:') || lower.startsWith('fd') || lower.startsWith('fc')
    }
    return false
}

function inMesh(host: string, meshHosts: readonly string[]): boolean {
    const lower = host.toLowerCase()
    if (privateOrTailnetIp(lower)) return true
    if (lower.endsWith('.ts.net')) return true
    return meshHosts.some(item => item && item.toLowerCase() === lower)
}

/** Is this a git source inside the own mesh, reached encrypted? Pure; no network. */
export function assessWorkspaceSource(url: string, meshHosts: readonly string[]): SourceAssessment {
    const raw = String(url || '').trim()
    if (!raw) return { ok: false, reason: 'Quelle leer' }
    if (/^[a-z][a-z0-9+.-]*::/i.test(raw)) return { ok: false, reason: 'Protokoll (Remote-Helfer ::) nicht erlaubt — nur ssh oder https' }
    if (/[\s\u0000-\u001f]/.test(raw)) return { ok: false, reason: 'Quelle ungültig (Leer-/Steuerzeichen)' }
    let transport: WorkspaceTransport
    let host: string
    const scp = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(?!\/\/)(.+)$/.exec(raw)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        let parsed: URL
        try { parsed = new URL(raw) } catch { return { ok: false, reason: 'Quelle ungültig' } }
        const protocol = parsed.protocol.replace(':', '').toLowerCase()
        if (protocol === 'http' || protocol === 'git') return { ok: false, reason: `unverschlüsselt (${protocol}://) — nur ssh oder https` }
        if (protocol !== 'ssh' && protocol !== 'https') return { ok: false, reason: `Protokoll ${protocol} nicht erlaubt — nur ssh oder https` }
        if (parsed.password || (protocol === 'https' && parsed.username)) return { ok: false, reason: 'Zugangsdaten gehören nicht in die URL' }
        transport = protocol
        host = parsed.hostname.replace(/^\[|\]$/g, '')
    } else if (scp && !raw.includes('::')) {
        transport = 'ssh'
        host = scp[2].replace(/^\[|\]$/g, '')
        if (scp[3].startsWith('-')) return { ok: false, reason: 'Quelle ungültig (Pfad beginnt mit -)' }
    } else {
        return { ok: false, reason: 'Protokoll nicht erkannt — nur ssh oder https' }
    }
    if (!host || host.startsWith('-') || !(isIP(host) || HOSTNAME.test(host.toLowerCase()))) return { ok: false, reason: 'Quelle ungültig (Host)' }
    if (!inMesh(host, meshHosts)) return { ok: false, reason: `${host} ist nicht im eigenen Mesh — Arbeitsdaten kommen nie aus der Cloud` }
    return { ok: true, transport, host }
}

/** git without a shell, without prompts; bounded. */
export function gitRunner(timeoutMs = 120_000): GitRunner {
    return (args, options = {}) => new Promise(resolve => {
        execFile('git', args, {
            cwd: options.cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
        }, (error, stdout, stderr) => resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }))
    })
}

const protocolArgs = (allowed: readonly string[]) => ['-c', 'protocol.allow=never', ...allowed.flatMap(name => ['-c', `protocol.${name}.allow=always`])]

/** HEAD is the pinned commit and nothing in the work tree differs from it. */
export async function verifyCheckout(target: string, commit: string, runGit: GitRunner): Promise<{ ok: true } | { ok: false; reason: string }> {
    const head = await runGit(['-C', target, 'rev-parse', 'HEAD'])
    if (head.code !== 0) return { ok: false, reason: 'kein Git-Arbeitsverzeichnis' }
    if (head.stdout.trim() !== commit) return { ok: false, reason: `HEAD ${head.stdout.trim().slice(0, 12)} ≠ ${commit.slice(0, 12)}` }
    const status = await runGit(['-C', target, 'status', '--porcelain', '--untracked-files=all'])
    if (status.code !== 0) return { ok: false, reason: 'Status nicht lesbar' }
    if (status.stdout.trim()) return { ok: false, reason: 'Arbeitsdaten nach dem Holen geändert' }
    return { ok: true }
}

/** init → fetch exactly one commit (depth 1) → detached checkout → verify. */
export async function fetchPinnedCommit(source: string, commit: string, target: string, runGit: GitRunner, allowedProtocols: readonly string[] = ['ssh', 'https']): Promise<{ ok: true; commit: string; target: string } | { ok: false; reason: string }> {
    if (!COMMIT.test(commit)) return { ok: false, reason: 'Commit muss eine volle Commit-ID sein (kein Zweigname)' }
    const steps: string[][] = [
        ['init', '-q', target],
        ['-C', target, ...protocolArgs(allowedProtocols), 'fetch', '-q', '--depth=1', '--no-tags', '--no-recurse-submodules', '--', source, commit],
        ['-C', target, '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', commit],
    ]
    for (const args of steps) {
        const result = await runGit(args)
        if (result.code !== 0) return { ok: false, reason: `git ${args.includes('fetch') ? 'fetch' : args.includes('checkout') ? 'checkout' : 'init'} fehlgeschlagen${result.stderr ? `: ${result.stderr.trim().slice(0, 160)}` : ''}` }
    }
    const verified = await verifyCheckout(target, commit, runGit)
    if (verified.ok === false) return { ok: false, reason: verified.reason }
    return { ok: true, commit, target }
}

/** Production entry: the mesh/encryption rule first, then the pinned fetch (ssh/https only). */
export async function fetchWorkspace(handoff: WorkspaceHandoff, target: string, options: { meshHosts: readonly string[]; runGit?: GitRunner }): Promise<{ ok: true; commit: string; target: string } | { ok: false; reason: string }> {
    const source = assessWorkspaceSource(handoff.source, options.meshHosts)
    if (source.ok === false) return { ok: false, reason: source.reason }
    if (!COMMIT.test(String(handoff.commit || ''))) return { ok: false, reason: 'Commit muss eine volle Commit-ID sein (kein Zweigname)' }
    return fetchPinnedCommit(handoff.source.trim(), handoff.commit, target, options.runGit || gitRunner())
}
