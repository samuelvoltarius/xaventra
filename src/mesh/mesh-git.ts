/**
 * Mesh-Git (2.88 „Arbeitsdaten reisen mit“).
 *
 * Ein eigenes Git-Ziel im Mesh: bare Repositories auf dem Main
 * (`<Datenordner>/mesh-git/<name>.git`). Eine Aufgabe läuft auf einem
 * anderen Knoten mit GENAU demselben Repo-Stand weiter und das Ergebnis kommt
 * als eigener Zweig zurück (`mesh/<knoten>/<arbeit>`), nie direkt auf `main`.
 *
 * Transport: nur der bestehende signierte Mesh-Weg (git.request /
 * git.response, Main-Fence, nur verschlüsselt direkt/lokal, nie Outbox,
 * Supabase oder Relay). Die Daten reisen als Git-Bundle (begrenzt), nicht über
 * ssh/https; kein Knoten braucht einen Git-Server, Schlüssel oder Port.
 *
 * Regeln:
 *  - Pfade nur aus Datenordner/Laufzeit-Wurzel, Hosts nur aus dem Routing;
 *    nichts hart codiert.
 *  - git ohne Shell, ohne Rückfragen, ohne globale/System-Konfiguration, ohne
 *    Hooks und ohne Netzwerk-Protokolle (protocol.allow=never).
 *  - Ergebnis wird geprüft: Bundle-Hash, Abstammung vom Ausgangsstand, keine
 *    Geheimnisse im Diff (beidseitig).
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { getNovaDataDir, getRuntimeRoot } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'

export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024
const MAX_BUNDLE_BASE64 = Math.ceil(MAX_BUNDLE_BYTES / 3) * 4
const MAX_DIFF_BYTES = 16 * 1024 * 1024
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const REPO = /^[a-z0-9][a-z0-9_-]{0,62}$/
const WORK_ID = /^[a-z0-9][a-z0-9-]{7,63}$/
const NODE_SEGMENT = /[^a-z0-9-]+/g
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const SHA256 = /^[a-f0-9]{64}$/

export const validRepoName = (value: unknown): value is string => typeof value === 'string' && REPO.test(value)
export const validWorkId = (value: unknown): value is string => typeof value === 'string' && WORK_ID.test(value)
export const validCommit = (value: unknown): value is string => typeof value === 'string' && COMMIT.test(value)

export type GitRequest =
    | { operation: 'deliver'; repo: string; workId: string; commit: string; bundle: string; sha256: string }
    | { operation: 'collect'; repo: string; workId: string; base: string }
    | { operation: 'release'; repo: string; workId: string }

export type GitReceipt =
    | { operation: 'deliver'; workId: string; commit: string; path: string }
    | { operation: 'collect'; workId: string; base: string; head: string; changedFiles: number; bundle?: string; sha256?: string }
    | { operation: 'release'; workId: string; released: boolean }

// ---------------------------------------------------------------------------
// Contract (pure): what may travel
// ---------------------------------------------------------------------------

function validBundleFields(bundle: unknown, sha256: unknown): boolean {
    return typeof bundle === 'string' && bundle.length > 0 && bundle.length <= MAX_BUNDLE_BASE64 && BASE64.test(bundle)
        && typeof sha256 === 'string' && SHA256.test(sha256)
}

const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))

export function validGitRequest(value: unknown): value is GitRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const p = value as Record<string, unknown>
    if (!validRepoName(p.repo) || !validWorkId(p.workId)) return false
    if (p.operation === 'deliver') return onlyKeys(p, ['operation', 'repo', 'workId', 'commit', 'bundle', 'sha256']) && validCommit(p.commit) && validBundleFields(p.bundle, p.sha256)
    if (p.operation === 'collect') return onlyKeys(p, ['operation', 'repo', 'workId', 'base']) && validCommit(p.base)
    if (p.operation === 'release') return onlyKeys(p, ['operation', 'repo', 'workId'])
    return false
}

/** A signed peer still has to answer exactly what was asked. */
export function validateGitReceipt(request: GitRequest, value: unknown): GitReceipt {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid git receipt')
    const p = value as Record<string, unknown>
    if (p.operation !== request.operation || p.workId !== request.workId) throw new Error('git receipt does not match the request')
    if (request.operation === 'deliver') {
        if (!onlyKeys(p, ['operation', 'workId', 'commit', 'path']) || p.commit !== request.commit || typeof p.path !== 'string' || p.path !== workPathFor(request.workId)) throw new Error('invalid git deliver receipt')
        return { operation: 'deliver', workId: request.workId, commit: request.commit, path: p.path }
    }
    if (request.operation === 'collect') {
        if (!onlyKeys(p, ['operation', 'workId', 'base', 'head', 'changedFiles', 'bundle', 'sha256']) || p.base !== request.base || !validCommit(p.head)
            || !Number.isSafeInteger(p.changedFiles) || (p.changedFiles as number) < 0) throw new Error('invalid git collect receipt')
        if (p.head === request.base) {
            if (p.bundle !== undefined || p.sha256 !== undefined) throw new Error('invalid git collect receipt')
            return { operation: 'collect', workId: request.workId, base: request.base, head: request.base, changedFiles: 0 }
        }
        if (!validBundleFields(p.bundle, p.sha256)) throw new Error('invalid git collect bundle')
        return { operation: 'collect', workId: request.workId, base: request.base, head: p.head as string, changedFiles: p.changedFiles as number, bundle: p.bundle as string, sha256: p.sha256 as string }
    }
    if (!onlyKeys(p, ['operation', 'workId', 'released']) || typeof p.released !== 'boolean') throw new Error('invalid git release receipt')
    return { operation: 'release', workId: request.workId, released: p.released }
}

/** Work directory relative to the node's runtime root (where its file tools work). */
export const workPathFor = (workId: string) => `mesh-work/${workId}`

export function newWorkId(): string {
    return `w-${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/** Branch on the Main that receives a node's result. */
export function resultBranch(node: string, workId: string): string {
    const segment = String(node || 'knoten').toLowerCase().replace(NODE_SEGMENT, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'knoten'
    return `mesh/${segment}/${workId}`
}

// ---------------------------------------------------------------------------
// git, isolated
// ---------------------------------------------------------------------------

export interface GitResult { code: number; stdout: string; stderr: string }
export type GitRunner = (args: string[], options?: { cwd?: string; maxBuffer?: number }) => Promise<GitResult>

function isolationFiles(): { config: string; hooks: string } {
    const dir = getNovaDataDir('mesh-git', '.isolation')
    const hooks = join(dir, 'no-hooks')
    const config = join(dir, 'empty.gitconfig')
    if (!existsSync(hooks)) mkdirSync(hooks, { recursive: true })
    if (!existsSync(config)) writeFileSync(config, '')
    return { config, hooks }
}

/** git without a shell, prompts, global/system config, hooks or network protocols; bounded. */
export function isolatedGit(timeoutMs = 120_000): GitRunner {
    return (args, options = {}) => new Promise(done => {
        const { config, hooks } = isolationFiles()
        const env: NodeJS.ProcessEnv = { ...process.env }
        for (const key of Object.keys(env)) if (/^GIT_/.test(key)) delete env[key]
        Object.assign(env, {
            GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config,
            GIT_AUTHOR_NAME: 'Xaventra', GIT_AUTHOR_EMAIL: 'mesh@xaventra.invalid', GIT_COMMITTER_NAME: 'Xaventra', GIT_COMMITTER_EMAIL: 'mesh@xaventra.invalid',
        })
        const full = ['-c', `core.hooksPath=${hooks}`, '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...args]
        execFile('git', full, { cwd: options.cwd, env, timeout: timeoutMs, maxBuffer: options.maxBuffer || 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
            const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
            done({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
        })
    })
}

async function must(run: GitRunner, args: string[], what: string, options?: { cwd?: string; maxBuffer?: number }): Promise<string> {
    const result = await run(args, options)
    if (result.code !== 0) throw new Error(`${what} fehlgeschlagen${result.stderr ? `: ${result.stderr.trim().split('\n')[0].slice(0, 160)}` : ''}`)
    return result.stdout
}

function within(parent: string, child: string): boolean {
    const rel = relative(resolve(parent), resolve(child))
    return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${sep}`)
}

export function meshGitRoot(): string { return getNovaDataDir('mesh-git') }
export function bareRepoPath(repo: string): string {
    if (!validRepoName(repo)) throw new Error('Repo-Name ungültig (nur a-z, 0-9, - und _)')
    return join(meshGitRoot(), `${repo}.git`)
}
function workDirFor(workId: string): string {
    if (!validWorkId(workId)) throw new Error('Arbeits-ID ungültig')
    const dir = join(getRuntimeRoot(), 'mesh-work', workId)
    if (!within(join(getRuntimeRoot(), 'mesh-work'), dir)) throw new Error('Arbeitsordner außerhalb des Mesh-Bereichs')
    return dir
}

async function ensureBare(repo: string, run: GitRunner): Promise<string> {
    const path = bareRepoPath(repo)
    if (!existsSync(join(path, 'HEAD'))) {
        mkdirSync(path, { recursive: true })
        await must(run, ['init', '-q', '--bare', '-b', 'main', path], 'git init')
    }
    return path
}

function tempFile(tag: string): string {
    const dir = getNovaDataDir('mesh-git', '.tmp')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${tag}-${randomUUID()}.bundle`)
}

/** Refuses when the change between two commits contains a secret (same rule as node exchange). */
async function assertNoSecrets(gitDir: string, base: string, head: string, run: GitRunner): Promise<number> {
    const names = (await must(run, ['--git-dir', gitDir, 'diff', '--name-only', '--no-renames', base, head], 'git diff')).split('\n').filter(Boolean)
    const diff = await run(['--git-dir', gitDir, 'diff', '--no-ext-diff', '--no-color', '--text', base, head], { maxBuffer: MAX_DIFF_BYTES })
    if (diff.code !== 0) throw new Error('Änderung zu groß oder nicht lesbar — nicht übertragen')
    if (redactSecrets(diff.stdout) !== diff.stdout) throw new Error('Änderung enthält ein Geheimnis (Schlüssel/Token) — nicht übertragen')
    return names.length
}

/** Bundle of `ref` (optionally only what is new since `since`), as base64 with hash. */
async function bundleOf(gitDir: string, ref: string, since: string | undefined, run: GitRunner): Promise<{ bundle: string; sha256: string; bytes: number }> {
    const file = tempFile('out')
    try {
        await must(run, ['--git-dir', gitDir, 'bundle', 'create', '-q', file, ref, ...(since ? [`^${since}`] : [])], 'git bundle')
        const size = statSync(file).size
        if (size > MAX_BUNDLE_BYTES) throw new Error(`Repo-Stand zu groß für den Mesh-Weg (${Math.ceil(size / 1024 / 1024)} MB, erlaubt ${MAX_BUNDLE_BYTES / 1024 / 1024} MB)`)
        const bytes = readFileSync(file)
        return { bundle: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    } finally { rmSync(file, { force: true }) }
}

/** Verifies and unpacks a bundle into `gitDir`; returns the single head it carries. */
async function unpackBundle(gitDir: string, bundle: string, sha256: string, run: GitRunner): Promise<{ ref: string; commit: string }> {
    const bytes = Buffer.from(bundle, 'base64')
    if (bytes.toString('base64') !== bundle || bytes.length > MAX_BUNDLE_BYTES) throw new Error('Bundle ungültig')
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Bundle-Prüfsumme stimmt nicht')
    const file = tempFile('in')
    writeFileSync(file, bytes, { mode: 0o600 })
    try {
        await must(run, ['--git-dir', gitDir, 'bundle', 'verify', '-q', file], 'git bundle verify')
        const heads = (await must(run, ['--git-dir', gitDir, 'bundle', 'list-heads', file], 'git bundle list-heads')).split('\n').map(line => line.trim()).filter(Boolean)
        if (heads.length !== 1) throw new Error('Bundle muss genau einen Stand enthalten')
        const [commit, ref] = heads[0].split(/\s+/)
        if (!validCommit(commit) || !/^refs\/mesh\/(?:out|result)\/[a-z0-9-]+$/.test(ref || '')) throw new Error('Bundle-Stand ungültig')
        await must(run, ['--git-dir', gitDir, 'bundle', 'unbundle', file], 'git bundle unbundle')
        const type = (await must(run, ['--git-dir', gitDir, 'cat-file', '-t', commit], 'git cat-file')).trim()
        if (type !== 'commit') throw new Error('Bundle-Stand ist kein Commit')
        return { ref, commit }
    } finally { rmSync(file, { force: true }) }
}

// ---------------------------------------------------------------------------
// Main side: the mesh Git target
// ---------------------------------------------------------------------------

/** Imports a local repository's current state as `main` of the mesh repo. Returns the commit. */
export async function publishRepo(sourcePath: string, repo: string, run: GitRunner = isolatedGit()): Promise<{ repo: string; commit: string }> {
    const source = resolve(String(sourcePath || ''))
    if (!existsSync(source)) throw new Error('Quell-Ordner nicht gefunden')
    const top = (await must(run, ['-C', source, 'rev-parse', '--show-toplevel'], 'kein Git-Repository')).trim()
    await must(run, ['-C', top, 'rev-parse', '--verify', 'HEAD^{commit}'], 'Repository hat noch keinen Commit')
    const bare = await ensureBare(repo, run)
    // Local path only (file protocol for exactly this call); never a remote URL.
    await must(run, ['-c', 'protocol.file.allow=always', '--git-dir', bare, 'fetch', '-q', '--no-tags', '--no-recurse-submodules', '--', top, '+HEAD:refs/heads/main'], 'git fetch (lokal)')
    return { repo, commit: await repoHead(repo, 'main', run) }
}

export async function repoHead(repo: string, ref = 'main', run: GitRunner = isolatedGit()): Promise<string> {
    const bare = bareRepoPath(repo)
    if (!existsSync(join(bare, 'HEAD'))) throw new Error(`Mesh-Repo ${repo} gibt es noch nicht`)
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(ref) || ref.includes('..') || ref.startsWith('-')) throw new Error('Zweig ungültig')
    return (await must(run, ['--git-dir', bare, 'rev-parse', '--verify', `${ref}^{commit}`], `Stand ${ref}`)).trim()
}

export async function listMeshRepos(run: GitRunner = isolatedGit()): Promise<Array<{ repo: string; branches: string[] }>> {
    const root = meshGitRoot()
    if (!existsSync(root)) return []
    const { readdirSync } = await import('node:fs')
    const out: Array<{ repo: string; branches: string[] }> = []
    for (const entry of readdirSync(root).filter(name => name.endsWith('.git')).sort()) {
        const repo = entry.slice(0, -4)
        if (!validRepoName(repo)) continue
        const refs = await run(['--git-dir', join(root, entry), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
        out.push({ repo, branches: refs.code === 0 ? refs.stdout.split('\n').filter(Boolean).slice(0, 50) : [] })
    }
    return out
}

/** Bundle of exactly this commit for a node (full history; bounded). */
export async function prepareDelivery(repo: string, commit: string, workId: string, run: GitRunner = isolatedGit()): Promise<Extract<GitRequest, { operation: 'deliver' }>> {
    if (!validCommit(commit) || !validWorkId(workId)) throw new Error('Stand oder Arbeits-ID ungültig')
    const bare = bareRepoPath(repo)
    const ref = `refs/mesh/out/${workId}`
    await must(run, ['--git-dir', bare, 'update-ref', ref, commit], 'git update-ref')
    try {
        const packed = await bundleOf(bare, ref, undefined, run)
        return { operation: 'deliver', repo, workId, commit, bundle: packed.bundle, sha256: packed.sha256 }
    } finally { await run(['--git-dir', bare, 'update-ref', '-d', ref]) }
}

/** Takes a node's result into its own branch; never touches `main`. */
export async function importResult(repo: string, node: string, receipt: Extract<GitReceipt, { operation: 'collect' }>, run: GitRunner = isolatedGit()): Promise<{ branch: string | null; head: string; changedFiles: number }> {
    if (receipt.head === receipt.base || !receipt.bundle || !receipt.sha256) return { branch: null, head: receipt.base, changedFiles: 0 }
    const bare = bareRepoPath(repo)
    const unpacked = await unpackBundle(bare, receipt.bundle, receipt.sha256, run)
    if (unpacked.commit !== receipt.head || unpacked.ref !== `refs/mesh/result/${receipt.workId}`) throw new Error('Ergebnis-Stand stimmt nicht mit der Quittung überein')
    const ancestor = await run(['--git-dir', bare, 'merge-base', '--is-ancestor', receipt.base, receipt.head])
    if (ancestor.code !== 0) throw new Error('Ergebnis baut nicht auf dem gelieferten Stand auf')
    const changedFiles = await assertNoSecrets(bare, receipt.base, receipt.head, run)
    const branch = resultBranch(node, receipt.workId)
    await must(run, ['--git-dir', bare, 'update-ref', `refs/heads/${branch}`, receipt.head, ''], 'git update-ref (Ergebnis)')
    return { branch, head: receipt.head, changedFiles }
}

// ---------------------------------------------------------------------------
// Node side: receive, work, hand back
// ---------------------------------------------------------------------------

export async function executeGitRequest(request: GitRequest, run: GitRunner = isolatedGit()): Promise<GitReceipt> {
    if (!validGitRequest(request)) throw new Error('invalid git request')
    if (request.operation === 'deliver') return receiveDelivery(request, run)
    if (request.operation === 'collect') return collectResult(request, run)
    return releaseWork(request, run)
}

async function receiveDelivery(request: Extract<GitRequest, { operation: 'deliver' }>, run: GitRunner): Promise<GitReceipt> {
    const mirror = await ensureBare(request.repo, run)
    const dir = workDirFor(request.workId)
    if (existsSync(dir)) throw new Error('Arbeitsordner existiert schon')
    const unpacked = await unpackBundle(mirror, request.bundle, request.sha256, run)
    if (unpacked.commit !== request.commit || unpacked.ref !== `refs/mesh/out/${request.workId}`) throw new Error('Gelieferter Stand stimmt nicht')
    // Keep the delivered commit reachable while the work runs.
    await must(run, ['--git-dir', mirror, 'update-ref', `refs/mesh/base/${request.workId}`, request.commit], 'git update-ref')
    mkdirSync(join(getRuntimeRoot(), 'mesh-work'), { recursive: true })
    await must(run, ['--git-dir', mirror, 'worktree', 'add', '-q', '--detach', dir, request.commit], 'git worktree add')
    return { operation: 'deliver', workId: request.workId, commit: request.commit, path: workPathFor(request.workId) }
}

async function collectResult(request: Extract<GitRequest, { operation: 'collect' }>, run: GitRunner): Promise<GitReceipt> {
    const mirror = bareRepoPath(request.repo)
    const dir = workDirFor(request.workId)
    if (!existsSync(dir)) throw new Error('Arbeitsordner fehlt')
    await must(run, ['-C', dir, 'add', '-A'], 'git add')
    const staged = await run(['-C', dir, 'diff', '--cached', '--quiet'])
    if (staged.code === 1) await must(run, ['-C', dir, 'commit', '-q', '-m', `Mesh-Ergebnis ${request.workId}`], 'git commit')
    const head = (await must(run, ['-C', dir, 'rev-parse', 'HEAD'], 'git rev-parse')).trim()
    if (head === request.base) return { operation: 'collect', workId: request.workId, base: request.base, head, changedFiles: 0 }
    const ancestor = await run(['--git-dir', mirror, 'merge-base', '--is-ancestor', request.base, head])
    if (ancestor.code !== 0) throw new Error('Arbeitsstand baut nicht auf dem gelieferten Stand auf')
    const changedFiles = await assertNoSecrets(mirror, request.base, head, run)
    const ref = `refs/mesh/result/${request.workId}`
    await must(run, ['--git-dir', mirror, 'update-ref', ref, head], 'git update-ref')
    try {
        const packed = await bundleOf(mirror, ref, request.base, run)
        return { operation: 'collect', workId: request.workId, base: request.base, head, changedFiles, bundle: packed.bundle, sha256: packed.sha256 }
    } finally { await run(['--git-dir', mirror, 'update-ref', '-d', ref]) }
}

async function releaseWork(request: Extract<GitRequest, { operation: 'release' }>, run: GitRunner): Promise<GitReceipt> {
    const mirror = bareRepoPath(request.repo)
    const dir = workDirFor(request.workId)
    let released = false
    if (existsSync(join(mirror, 'HEAD'))) {
        if (existsSync(dir)) released = (await run(['--git-dir', mirror, 'worktree', 'remove', '--force', dir])).code === 0
        await run(['--git-dir', mirror, 'worktree', 'prune'])
        await run(['--git-dir', mirror, 'update-ref', '-d', `refs/mesh/base/${request.workId}`])
    }
    if (existsSync(dir) && within(join(getRuntimeRoot(), 'mesh-work'), dir)) { rmSync(dir, { recursive: true, force: true }); released = true }
    return { operation: 'release', workId: request.workId, released }
}
