import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteJson } from './atomic-storage.js'

export const UPDATE_REPOSITORY = 'samuelvoltarius/xaventra'
export const MANIFEST_ASSET = 'xaventra-update.json'
const MAX_PACKAGE = 256 * 1024 * 1024
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/
export function compareUpdateVersions(a: string, b: string): number {
    const x = semver.exec(a), y = semver.exec(b)
    if (!x || !y || [...x.slice(1), ...y.slice(1)].filter(Boolean).some(n => !Number.isSafeInteger(Number(n)))) throw Error('Invalid update version')
    for (let i = 1; i < 4; i++) if (+x[i] !== +y[i]) return +x[i] > +y[i] ? 1 : -1
    if (x[4] === y[4]) return 0
    if (x[4] === undefined) return 1
    if (y[4] === undefined) return -1
    return +x[4] > +y[4] ? 1 : -1
}
export function installedUpdateVersion(): string {
    // Container cwd is a writable data root, not necessarily the installation.
    const path = join(dirname(fileURLToPath(import.meta.url)), '../../package.json')
    return JSON.parse(readFileSync(path, 'utf8')).version
}

export interface UpstreamManifest {
    schema: 1; repository: string; version: string; commit: string; minUpdater: string
    artifacts: Array<{ name: string; platform: string; arch: string; size: number; sha256: string }>
}
export interface SignedUpstreamManifest { keyId: string; payload: UpstreamManifest; signature: string }
export interface GitHubUpdatePolicy {
    channel?: 'stable' | 'rc'
    /** Publisher keys enrolled by an operator, NOT keys from downloaded content or Mesh. */
    publisherKeys?: Record<string, string>
}
interface GitHubAsset { name: string; size: number; browser_download_url: string; state: string }
interface GitHubRelease { tag_name: string; draft: boolean; prerelease: boolean; assets: GitHubAsset[] }
export interface UpstreamStatus {
    state: 'unknown' | 'no-eligible-release' | 'available' | 'prepared'
    checkedAt: string; retryAfter: number; version?: string; releaseId?: string; commit?: string
    originVerified: boolean; reason?: string; packagePath?: string; sha256?: string
}
type Fetch = typeof fetch
/** Public GitHub only: no user URL, credentials or arbitrary redirects. */
export async function fetchUpdateResource(url: string, maxBytes: number, onChunk: (b: Uint8Array) => Promise<void>, fetcher: Fetch = fetch): Promise<void> {
    const first = new URL(url)
    const api = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100`
    const prefix = `https://github.com/${UPDATE_REPOSITORY}/releases/download/`
    if (url !== api && !(url.startsWith(prefix) && first.protocol === 'https:' && !first.username && !first.password && !first.search && !first.hash)) throw Error('Untrusted update origin')
    const abort = AbortSignal.timeout(120_000)
    let current = url
    for (let hop = 0; hop < 4; hop++) {
        const response = await fetcher(current, { redirect: 'manual', signal: abort, headers: { accept: url === api ? 'application/vnd.github+json' : 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28', 'user-agent': 'Xaventra-Update' } })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel()
            const next = new URL(response.headers.get('location') || '', current)
            if (url === api || next.protocol !== 'https:' || next.hostname !== 'release-assets.githubusercontent.com' || next.port || next.username || next.password || next.hash) throw Error('Untrusted update redirect')
            current = next.href; continue
        }
        if (!response.ok) { await response.body?.cancel(); throw Error(`GitHub update request failed (HTTP ${response.status})`) }
        if (!response.body || Number(response.headers.get('content-length') || 0) > maxBytes) { await response.body?.cancel(); throw Error('Update response exceeds budget') }
        const reader = response.body.getReader(); let count = 0
        try {
            while (true) { const { done, value } = await reader.read(); if (done) break; count += value.length; if (count > maxBytes) throw Error('Update response exceeds budget'); await onChunk(value) }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
        return
    }
    throw Error('Too many update redirects')
}
async function readJson(url: string, max: number, fetcher: Fetch): Promise<any> {
    const chunks: Uint8Array[] = []
    await fetchUpdateResource(url, max, async b => { chunks.push(b) }, fetcher)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function assetUrl(release: GitHubRelease, name: string): string {
    const matches = release.assets.filter(a => a.name === name && a.state === 'uploaded')
    const expected = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${release.tag_name}/${name}`
    if (matches.length !== 1 || matches[0].browser_download_url !== expected) throw Error('Missing, duplicate or untrusted release asset')
    return expected
}
export function verifyUpstreamManifest(signed: SignedUpstreamManifest, policy: GitHubUpdatePolicy, version: string, updater: string): UpstreamManifest {
    const key = policy.publisherKeys?.[signed?.keyId]
    if (!key) throw Error('Publisher key not enrolled; origin unverified')
    if (createPublicKey(key).asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(JSON.stringify(signed.payload)), key, Buffer.from(signed.signature || '', 'base64'))) throw Error('Invalid upstream publisher signature')
    const p = signed.payload
    if (p.schema !== 1 || p.repository !== UPDATE_REPOSITORY || p.version !== version || !/^[a-f0-9]{40}$/.test(p.commit) || compareUpdateVersions(p.minUpdater, updater) > 0) throw Error('Incompatible upstream manifest')
    if (!Array.isArray(p.artifacts) || !p.artifacts.length || p.artifacts.length > 12) throw Error('Invalid artifact inventory')
    const names = new Set<string>(), targets = new Set<string>()
    for (const a of p.artifacts) {
        const target = `${a.platform}-${a.arch}`
        if (!['linux', 'darwin', 'win32'].includes(a.platform) || !['arm64', 'x64'].includes(a.arch)
            || !/^xaventra-[a-z0-9.-]+\.tar\.gz$/.test(a.name) || names.has(a.name) || targets.has(target)
            || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > MAX_PACKAGE || !/^[a-f0-9]{64}$/.test(a.sha256)) throw Error('Invalid artifact descriptor')
        names.add(a.name); targets.add(target)
    }
    return p
}

/** Discovery and staging only. Never extracts or executes release contents.
 * The independently enrolled activation controller must verify bytes again. */
export class GitHubUpdateSource {
    private active: Promise<UpstreamStatus> | undefined
    constructor(private root: string, private policy: GitHubUpdatePolicy, private current: string,
        private target = { platform: process.platform as string, arch: process.arch as string }, private fetcher: Fetch = fetch) {}
    async status(): Promise<UpstreamStatus> {
        try {
            const record = JSON.parse(await readFile(join(this.root, 'status.json'), 'utf8'))
            if (record.scope !== this.scope()) throw Error('Update policy or platform changed')
            return record.status
        }
        catch { return { state: 'unknown', checkedAt: '', retryAfter: 0, originVerified: false } }
    }
    private scope(): string { return createHash('sha256').update(JSON.stringify({ policy: this.policy, current: this.current, target: this.target })).digest('hex') }
    async check(): Promise<UpstreamStatus> { return this.run(false) }
    async prepare(expectedRelease: string): Promise<UpstreamStatus> { return this.run(true, expectedRelease) }
    private run(prepare: boolean, expected?: string): Promise<UpstreamStatus> {
        // Duplicate checks coalesce. A deployment must not piggyback on another request.
        if (this.active) return prepare ? Promise.reject(Error('Update check/download already running')) : this.active
        this.active = this.execute(prepare, expected).finally(() => { this.active = undefined })
        return this.active
    }
    private async execute(prepare: boolean, expected?: string): Promise<UpstreamStatus> {
        const old = await this.status(), now = Date.now()
        if (!prepare && old.retryAfter > now) return old
        let result: UpstreamStatus = { state: 'unknown', checkedAt: new Date(now).toISOString(), retryAfter: now + 60_000, originVerified: false }
        let temporary: string | undefined
        try {
            const releases = await readJson(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100`, 2 * 1024 * 1024, this.fetcher)
            if (!Array.isArray(releases) || releases.length >= 100) throw Error('Release listing incomplete or invalid')
            const candidates = releases.filter((r: GitHubRelease) => !r.draft && typeof r.tag_name === 'string'
                && /^v/.test(r.tag_name) && semver.test(r.tag_name.slice(1))
                && (this.policy.channel === 'rc' || (!r.prerelease && !r.tag_name.includes('-')))
                && compareUpdateVersions(r.tag_name.slice(1), this.current) > 0)
                .sort((a, b) => compareUpdateVersions(b.tag_name.slice(1), a.tag_name.slice(1)))
            if (!candidates.length) {
                if (prepare) throw Error('Prepared release is no longer eligible')
                result = { ...result, state: 'no-eligible-release', retryAfter: now + 5 * 60_000 }
            } else {
                const release: GitHubRelease = candidates[0], version = release.tag_name.slice(1)
                result.version = version
                const signed: SignedUpstreamManifest = await readJson(assetUrl(release, MANIFEST_ASSET), 64 * 1024, this.fetcher)
                const manifest = verifyUpstreamManifest(signed, this.policy, version, this.current)
                const artifact = manifest.artifacts.find(a => a.platform === this.target.platform && a.arch === this.target.arch)
                if (!artifact) throw Error('Release has no artifact for this platform/architecture')
                const id = `${version}-${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`
                result = { ...result, state: 'available', version, releaseId: id, commit: manifest.commit, originVerified: true, retryAfter: now + 5 * 60_000 }
                if (prepare) {
                    if (expected !== id) throw Error('Release changed; check and approve the exact release again')
                    await mkdir(this.root, { recursive: true })
                    const disk = await statfs(this.root)
                    if (disk.bavail * disk.bsize < artifact.size * 2 + 64 * 1024 * 1024) throw Error('Insufficient update staging disk space')
                    temporary = join(this.root, `${randomUUID()}.part`)
                    const fd = await open(temporary, 'wx', 0o600), hash = createHash('sha256'); let size = 0
                    try {
                        await fetchUpdateResource(assetUrl(release, artifact.name), artifact.size, async chunk => {
                            size += chunk.length; hash.update(chunk)
                            let offset = 0
                            while (offset < chunk.length) offset += (await fd.write(chunk, offset, chunk.length - offset)).bytesWritten
                        }, this.fetcher)
                        await fd.sync()
                    } finally { await fd.close() }
                    if (size !== artifact.size || hash.digest('hex') !== artifact.sha256) throw Error('Downloaded release hash/size mismatch')
                    const packagePath = join(this.root, `${id}-${this.target.platform}-${this.target.arch}.tar.gz`)
                    await rename(temporary, packagePath); temporary = undefined
                    await atomicWriteJson(`${packagePath}.manifest.json`, signed)
                    result = { ...result, state: 'prepared', packagePath, sha256: artifact.sha256 }
                }
            }
        } catch (e) {
            // Never retain a stale "prepared"/"up to date" success on failure.
            result = { state: 'unknown', checkedAt: result.checkedAt, retryAfter: now + 60_000, originVerified: false, version: result.version, reason: e instanceof Error && !/https?:|BEGIN |token|password/i.test(e.message) ? e.message.slice(0, 200) : 'Update check or verification failed' }
        } finally { if (temporary) await rm(temporary, { force: true }) }
        await atomicWriteJson(join(this.root, 'status.json'), { scope: this.scope(), status: result })
        return result
    }
}

export async function hashUpdateFile(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
}
