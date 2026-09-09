import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compareUpdateVersions, fetchUpdateResource, GitHubUpdateSource, installedUpdateVersion, MANIFEST_ASSET, UPDATE_REPOSITORY, verifyUpstreamManifest } from './github-update.js'
import { upstreamUpdateCommand } from './upstream-update-command.js'
import { pullAndRebuild } from '../infra/auto-update.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'xaventra-upstream-')); roots.push(root)
    const keys = generateKeyPairSync('ed25519'), bytes = Buffer.from('fixture artifact bytes; never executable')
    const policy = { publisherKeys: { release: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }
    const payload = { schema: 1 as const, repository: UPDATE_REPOSITORY, version: '2.79.0', commit: 'a'.repeat(40), minUpdater: '2.78.21', artifacts: [{ name: 'xaventra-linux-arm64.tar.gz', platform: 'linux', arch: 'arm64', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
    const signed = { keyId: 'release', payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('base64') }
    const prefix = `https://github.com/${UPDATE_REPOSITORY}/releases/download/v2.79.0/`
    const releases: any[] = [{ tag_name: 'v2.79.0', draft: false, prerelease: false, assets: [MANIFEST_ASSET, payload.artifacts[0].name].map(name => ({ name, state: 'uploaded', size: name === MANIFEST_ASSET ? 1000 : bytes.length, browser_download_url: prefix + name })) }]
    let corrupt = false
    const fetcher = vi.fn(async (url: any) => new Response(String(url).includes('api.github.com') ? JSON.stringify(releases) : String(url).endsWith(MANIFEST_ASSET) ? JSON.stringify(signed) : corrupt ? 'X'.repeat(bytes.length) : bytes))
    const source = new GitHubUpdateSource(root, policy, '2.78.21', { platform: 'linux', arch: 'arm64' }, fetcher as any)
    return { root, source, payload, signed, policy, releases, fetcher, bytes, corrupt: () => { corrupt = true } }
}
describe('GitHub upstream release boundary', () => {
    it('orders stable/RC numerically and rejects unsafe versions', () => {
        expect(compareUpdateVersions('2.79.0', '2.79.0-rc.9')).toBe(1)
        expect(compareUpdateVersions('2.79.0-rc.10', '2.79.0-rc.9')).toBe(1)
        for (const v of ['v1.0.0', '01.0.0', '1.2.3;id', '1.2.3-beta.1']) expect(() => compareUpdateVersions(v, '1.0.0')).toThrow()
    })
    it('reads installed package independently of runtime cwd', () => {
        expect(installedUpdateVersion()).toBe(JSON.parse(readFileSyncLocal()).version)
    })
    it('checks, downloads, verifies, persists and does not extract or activate', async () => {
        const f = await fixture(), available = await f.source.check()
        expect(available).toMatchObject({ state: 'available', originVerified: true, version: '2.79.0' })
        const prepared = await f.source.prepare(available.releaseId!)
        expect(prepared.state).toBe('prepared')
        expect(await readFile(prepared.packagePath!)).toEqual(f.bytes)
        expect((await readdir(f.root)).sort()).toHaveLength(3)
        expect(await f.source.status()).toEqual(prepared)
    })
    it('rejects a changed release approval without downloading', async () => {
        const f = await fixture(), s = await f.source.prepare('2.79.0-wrong')
        expect(s.state).toBe('unknown'); expect(s.reason).toContain('exact release')
        expect(f.fetcher).toHaveBeenCalledTimes(2)
    })
    it('requires independently enrolled publisher key and valid signature', async () => {
        const f = await fixture()
        expect(() => verifyUpstreamManifest(f.signed, {}, '2.79.0', '2.78.21')).toThrow('not enrolled')
        f.signed.payload.commit = 'b'.repeat(40)
        expect((await f.source.check()).reason).toContain('signature')
    })
    it('rejects minimum-updater and tag mismatch even with a valid signature', async () => {
        const f = await fixture()
        expect(() => verifyUpstreamManifest(f.signed, f.policy, '2.79.0', '2.78.20')).toThrow('Incompatible')
        expect(() => verifyUpstreamManifest(f.signed, f.policy, '2.79.1', '2.78.21')).toThrow('Incompatible')
    })
    it('rejects foreign repository and duplicate targets signed by an enrolled key', async () => {
        const f = await fixture(), keys = generateKeyPairSync('ed25519')
        const policy = { publisherKeys: { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }
        const signed = payload => ({ keyId: 'fixture', payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('base64') })
        expect(() => verifyUpstreamManifest(signed({ ...f.payload, repository: 'attacker/repo' }), policy, '2.79.0', '2.78.21')).toThrow('Incompatible')
        expect(() => verifyUpstreamManifest(signed({ ...f.payload, artifacts: [...f.payload.artifacts, ...f.payload.artifacts] }), policy, '2.79.0', '2.78.21')).toThrow('descriptor')
    })
    it('refuses ambiguous 100-entry discovery instead of declaring current', async () => {
        const f = await fixture(); f.releases.push(...Array(99).fill(f.releases[0]))
        expect((await f.source.check()).reason).toContain('incomplete')
    })
    it('cleans partial packages and never keeps a prepared success after corruption', async () => {
        const f = await fixture(), available = await f.source.check(); f.corrupt()
        const result = await f.source.prepare(available.releaseId!)
        expect(result.state).toBe('unknown'); expect(result.reason).toContain('hash/size')
        expect(await readdir(f.root)).toEqual(['status.json'])
    })
    it('rejects missing architecture, draft/prerelease, downgrade and no releases honestly', async () => {
        const f = await fixture()
        const wrong = new GitHubUpdateSource(f.root, f.policy, '2.78.21', { platform: 'win32', arch: 'x64' }, f.fetcher as any)
        expect((await wrong.check()).reason).toContain('architecture')
        await rm(join(f.root, 'status.json'))
        f.releases[0].prerelease = true
        expect((await f.source.check()).state).toBe('no-eligible-release')
    })
    it('bounded cache coalesces checks; offline becomes unknown, not current', async () => {
        const f = await fixture()
        await Promise.all([f.source.check(), f.source.check()]); await f.source.check()
        expect(f.fetcher).toHaveBeenCalledTimes(2)
        f.fetcher.mockImplementation(async () => { throw Error('offline') })
        const result = await f.source.prepare('stale')
        expect(result).toMatchObject({ state: 'unknown', originVerified: false, reason: 'offline' })
        await f.source.check(); expect(f.fetcher).toHaveBeenCalledTimes(3)
    })
    it('does not bypass policy with forged asset URLs or private redirects', async () => {
        const f = await fixture(); f.releases[0].assets[0].browser_download_url = 'http://127.0.0.1/private'
        expect((await f.source.check()).reason).toContain('untrusted')
        const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
        await expect(fetchUpdateResource(`https://github.com/${UPDATE_REPOSITORY}/releases/download/v2.79.0/x.tar.gz`, 99, async () => {}, redirect as any)).rejects.toThrow('redirect')
        expect(redirect).toHaveBeenCalledTimes(1)
    })
    it('caps streamed bytes including responses without content-length', async () => {
        const url = `https://github.com/${UPDATE_REPOSITORY}/releases/download/v2.79.0/x.tar.gz`
        await expect(fetchUpdateResource(url, 3, async () => {}, (async () => new Response('abcd')) as any)).rejects.toThrow('budget')
    })
    it('allows only the bounded GitHub asset redirect, no credentials', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/test?sig=fixture' } })).mockResolvedValueOnce(new Response('ok'))
        let output = ''
        await fetchUpdateResource(`https://github.com/${UPDATE_REPOSITORY}/releases/download/v2.79.0/x.tar.gz`, 3, async b => { output += Buffer.from(b).toString() }, fetcher)
        expect(output).toBe('ok'); expect(JSON.stringify(fetcher.mock.calls)).not.toContain('authorization')
    })
    it('gates prepare by role and refuses unpinned deployment without fetching', async () => {
        const f = await fixture()
        expect(await upstreamUpdateCommand('prepare something', 'user', f.source)).toContain('Owner/Admin')
        expect(await upstreamUpdateCommand('deploy', 'owner', f.source)).toContain('exakte')
        expect(f.fetcher).not.toHaveBeenCalled()
    })
    it('does not claim activation from successful download; unsafe legacy entry fails closed', async () => {
        const f = await fixture(), s = await f.source.check()
        expect(await upstreamUpdateCommand(`deploy ${s.releaseId}`, 'owner', f.source)).toContain('Kein Rollout gestartet')
        expect(await pullAndRebuild()).toMatchObject({ success: false, blocked: true })
    })
})
import { readFileSync } from 'node:fs'
function readFileSyncLocal() { return readFileSync(new URL('../../package.json', import.meta.url), 'utf8') }
