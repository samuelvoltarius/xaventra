import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MANIFEST_ASSET, UPDATE_REPOSITORY } from '../github-update.js'
import { encodeUpdatePackage } from '../update-package.js'
import { JsonlThoughtSink, type Thought, type ThoughtSink } from './thought-sink.js'
import {
    CHECKSUM_ASSET, MAX_DESCRIPTOR_BYTES, PINNED_PUBLISHER_KEY_ID, PINNED_PUBLISHER_SPKI_SHA256,
    SelfUpdateWatch, createUpdateProposal, inspectLatestRelease, readSelfUpdateSettings, startSelfUpdateWatch,
    type SelfUpdateSettings,
} from './release-watch.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })

const API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100`
const spkiSha = (key: KeyObject) => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
const pem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString()

interface FixtureOptions { version?: string; tags?: string[]; bigArtifact?: boolean }
function fixture(options: FixtureOptions = {}) {
    const version = options.version || '2.81.0'
    const keys = generateKeyPairSync('ed25519')
    const pin = { keyId: PINNED_PUBLISHER_KEY_ID, spkiSha256: spkiSha(keys.publicKey) }
    const commit = 'c'.repeat(40)
    const descriptors = (['x64', 'arm64'] as const).map(arch => {
        const bytes = encodeUpdatePackage({ schema: 1, kind: 'docker', repository: UPDATE_REPOSITORY, version, commit, platform: 'linux', arch, image: `ghcr.io/samuelvoltarius/xaventra@sha256:${(arch === 'x64' ? '1' : '2').repeat(64)}` })
        return { arch, name: `xaventra-${version}-linux-${arch}.tar.gz`, bytes }
    })
    const payload = {
        schema: 1 as const, repository: UPDATE_REPOSITORY, version, commit, minUpdater: '2.78.22',
        artifacts: descriptors.map(d => ({ name: d.name, platform: 'linux', arch: d.arch, size: options.bigArtifact && d.arch === 'x64' ? MAX_DESCRIPTOR_BYTES + 1 : d.bytes.length, sha256: createHash('sha256').update(d.bytes).digest('hex') })),
    }
    const state = {
        signed: { keyId: PINNED_PUBLISHER_KEY_ID, payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('base64') } as any,
        sums: payload.artifacts.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n',
        descriptorBytes: new Map(descriptors.map(d => [d.name, d.bytes])),
        body: 'Signed Linux container update. Neu: Selbst-Updater-Vorschlag.\u0007',
    }
    const tags = options.tags || [`v${version}`]
    const releases = () => tags.map(tag => ({
        tag_name: tag, draft: false, prerelease: true, body: state.body,
        assets: [MANIFEST_ASSET, CHECKSUM_ASSET, ...descriptors.map(d => d.name)].map(name => ({
            name, state: 'uploaded', size: 1, browser_download_url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/${tag}/${name}`,
        })),
    }))
    const calls: Array<{ url: string; method: string }> = []
    const fetcher = vi.fn(async (input: any, init?: any) => {
        const url = String(input)
        calls.push({ url, method: String(init?.method || 'GET') })
        if (url === API) return new Response(JSON.stringify(releases()))
        if (url.endsWith(`/${MANIFEST_ASSET}`)) return new Response(JSON.stringify(state.signed))
        if (url.endsWith(`/${CHECKSUM_ASSET}`)) return new Response(state.sums)
        const name = url.split('/').pop()!
        const bytes = state.descriptorBytes.get(name)
        if (bytes) return new Response(bytes)
        return new Response('not found', { status: 404 })
    })
    const settings: SelfUpdateSettings = { enabled: true, intervalMinutes: 360, channel: 'stable', publisherKeys: { [PINNED_PUBLISHER_KEY_ID]: pem(keys.publicKey) } }
    return { version, keys, pin, commit, payload, state, fetcher, calls, settings, descriptors }
}

class MemorySink implements ThoughtSink {
    thoughts: Thought[] = []
    async emit(thought: Thought): Promise<void> { this.thoughts.push(thought) }
    proposals(): Thought[] { return this.thoughts.filter(t => t.kind === 'update-proposal' || t.proposal) }
}

async function watch(f: ReturnType<typeof fixture>, sink: ThoughtSink = new MemorySink(), current = '2.80.0') {
    const root = await mkdtemp(join(tmpdir(), 'xaventra-selfupdate-')); roots.push(root)
    return new SelfUpdateWatch({ settings: f.settings, currentVersion: current, sink, statePath: join(root, 'watch-state.json'), fetcher: f.fetcher as any, pin: f.pin, now: () => Date.parse('2026-10-01T12:00:00Z') })
}

describe('self-update release watch (read-only, signed releases only)', () => {
    it('is off by default and pins the production publisher key', () => {
        expect(readSelfUpdateSettings({}).enabled).toBe(false)
        expect(readSelfUpdateSettings({ autonomy: { selfUpdate: { enabled: 'true' } } }).enabled).toBe(false)
        expect(readSelfUpdateSettings({ autonomy: { selfUpdate: { enabled: true, intervalMinutes: 1 } } })).toMatchObject({ enabled: true, intervalMinutes: 30, channel: 'stable' })
        expect(PINNED_PUBLISHER_KEY_ID).toBe('xaventra-update-20260910')
        expect(PINNED_PUBLISHER_SPKI_SHA256).toBe('12c9322618387537b605f9241619a87e48c8cc9f0df6a7bdc5f44438f2af887a')
    })

    it('a valid signed release yields exactly one debounced proposal (stage "fragen")', async () => {
        const f = fixture(), root = await mkdtemp(join(tmpdir(), 'xaventra-thoughts-')); roots.push(root)
        const sink = new JsonlThoughtSink(join(root, 'thoughts.jsonl'))
        const w = await watch(f, sink)
        const [a, b] = await Promise.all([w.tick(), w.tick()])
        expect(a.inspection.state).toBe('verified')
        expect(b.emitted).toBeNull()
        const again = await w.tick()
        expect(again.inspection.state).toBe('verified')
        expect(again.emitted).toBeNull()
        const lines = (await readFile(join(root, 'thoughts.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
        expect(lines).toHaveLength(1)
        const t = lines[0] as Thought
        expect(t).toMatchObject({ kind: 'update-proposal', permission: 'fragen', source: 'self-update' })
        expect(t.text).toContain('2.81.0 verfügbar, geprüft')
        expect(t.text).toContain('Installieren?')
        expect(t.text).toContain('Änderungen:')
        expect(t.text).not.toContain('\u0007')
        expect(t.proposal).toMatchObject({ action: 'self-update.activate', params: { version: '2.81.0', commit: f.commit } })
        // A fresh watcher (restart) still does not repeat the same release.
        const w2 = new SelfUpdateWatch({ settings: f.settings, currentVersion: '2.80.0', sink, statePath: (w as any).deps.statePath, fetcher: f.fetcher as any, pin: f.pin })
        expect((await w2.tick()).emitted).toBeNull()
    })

    it('only reads: GET requests to the release listing, manifest, SHA256SUMS and small descriptors', async () => {
        const f = fixture(), w = await watch(f)
        await w.tick()
        expect(f.calls.every(c => c.method === 'GET')).toBe(true)
        const names = f.calls.map(c => c.url === API ? 'api' : c.url.split('/').pop())
        expect(names.sort()).toEqual(['api', CHECKSUM_ASSET, MANIFEST_ASSET, ...f.descriptors.map(d => d.name)].sort())
    })

    it('wrong signature -> no proposal', async () => {
        const f = fixture(); f.state.signed.payload = { ...f.state.signed.payload, commit: 'd'.repeat(40) }
        const sink = new MemorySink(), r = await (await watch(f, sink)).tick()
        expect(r.inspection.state).toBe('rejected')
        expect(sink.proposals()).toHaveLength(0)
    })

    it('manifest signed by a different key under the pinned key id -> no proposal', async () => {
        const f = fixture(), other = generateKeyPairSync('ed25519')
        f.state.signed.signature = sign(null, Buffer.from(JSON.stringify(f.state.signed.payload)), other.privateKey).toString('base64')
        const sink = new MemorySink(), r = await (await watch(f, sink)).tick()
        expect(r.inspection.state).toBe('rejected')
        expect(sink.proposals()).toHaveLength(0)
    })

    it('an enrolled key that does not match the pinned fingerprint -> no proposal, even with a matching signature', async () => {
        const f = fixture(), other = generateKeyPairSync('ed25519')
        f.settings.publisherKeys = { [PINNED_PUBLISHER_KEY_ID]: pem(other.publicKey) }
        f.state.signed.signature = sign(null, Buffer.from(JSON.stringify(f.state.signed.payload)), other.privateKey).toString('base64')
        const sink = new MemorySink(), r = await (await watch(f, sink)).tick()
        expect(r.inspection).toMatchObject({ state: 'rejected' })
        expect((r.inspection as any).reason).toMatch(/gepinnt|pinned/i)
        expect(sink.proposals()).toHaveLength(0)
        expect(f.calls).toHaveLength(0)
    })

    it('descriptor hash mismatch -> no proposal', async () => {
        const f = fixture(), name = f.descriptors[1].name
        const bytes = Buffer.from(f.state.descriptorBytes.get(name)!); bytes[bytes.length - 1] ^= 1
        f.state.descriptorBytes.set(name, bytes)
        const sink = new MemorySink(), r = await (await watch(f, sink)).tick()
        expect(r.inspection.state).toBe('rejected')
        expect((r.inspection as any).reason).toMatch(/hash/i)
        expect(sink.proposals()).toHaveLength(0)
    })

    it('SHA256SUMS that disagree with the signed manifest -> no proposal', async () => {
        const f = fixture(); f.state.sums = f.state.sums.replace(/^[a-f0-9]/, c => c === 'a' ? 'b' : 'a')
        const sink = new MemorySink(), r = await (await watch(f, sink)).tick()
        expect(r.inspection.state).toBe('rejected')
        expect((r.inspection as any).reason).toContain('SHA256SUMS')
        expect(sink.proposals()).toHaveLength(0)
    })

    it('downgrade or same version -> no proposal', async () => {
        const f = fixture({ version: '2.79.4', tags: ['v2.79.4'] })
        const sink = new MemorySink(), r = await (await watch(f, sink, '2.80.0')).tick()
        expect(r.inspection.state).toBe('none')
        expect(sink.proposals()).toHaveLength(0)
        const same = fixture({ version: '2.80.0' }), sink2 = new MemorySink()
        expect((await (await watch(same, sink2, '2.80.0')).tick()).inspection.state).toBe('none')
        expect(sink2.proposals()).toHaveLength(0)
    })

    it('never downloads an artifact larger than the descriptor budget without approval', async () => {
        const f = fixture({ bigArtifact: true }), sink = new MemorySink(), r = await (await watch(f, sink)).tick()
        expect(r.inspection.state).toBe('rejected')
        expect(f.calls.some(c => c.url.endsWith(f.descriptors[0].name))).toBe(false)
        expect(sink.proposals()).toHaveLength(0)
    })

    it('disabled: no network access, no thought, no timer', async () => {
        const f = fixture(); f.settings.enabled = false
        const sink = new MemorySink(), r = await (await watch(f, sink)).tick()
        expect(r.emitted).toBeNull()
        expect(f.fetcher).not.toHaveBeenCalled()
        expect(startSelfUpdateWatch({ settings: f.settings, currentVersion: '2.80.0', sink, statePath: join(tmpdir(), 'never-written.json') })).toBeNull()
        expect(existsSync(join(tmpdir(), 'never-written.json'))).toBe(false)
    })

    it('a rejected release is reported once as information without a proposal', async () => {
        const f = fixture(); f.state.signed.payload = { ...f.state.signed.payload, commit: 'e'.repeat(40) }
        const sink = new MemorySink(), w = await watch(f, sink)
        await w.tick(); await w.tick()
        expect(sink.thoughts).toHaveLength(1)
        expect(sink.thoughts[0]).toMatchObject({ kind: 'update-rejected', permission: 'selbst' })
        expect(sink.thoughts[0].proposal).toBeUndefined()
    })

    it('inspectLatestRelease is usable without the watcher and binds the plan hash into the proposal', async () => {
        const f = fixture(), r = await inspectLatestRelease({ settings: f.settings, currentVersion: '2.80.0', fetcher: f.fetcher as any, pin: f.pin })
        expect(r.state).toBe('verified')
        if (r.state !== 'verified') return
        expect(r.release.artifacts.map(a => a.arch).sort()).toEqual(['arm64', 'x64'])
        const t = createUpdateProposal(r.release, { planHash: 'f'.repeat(64), summary: 'ns2 → ns1 → nas → spark' }, Date.parse('2026-10-01T12:00:00Z'))
        expect(t.proposal?.params).toMatchObject({ releaseId: r.release.releaseId, planHash: 'f'.repeat(64) })
        expect(t.dedupeKey).toBe(`self-update:${r.release.releaseId}`)
    })

    it('new self-update code never imports child_process or spawns processes', () => {
        for (const file of ['thought-sink.ts', 'release-watch.ts', 'activation-plan.ts', 'fencing-readiness.ts']) {
            const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
            expect(text, file).not.toMatch(/child_process|execFile|execSync|\bspawn\(|(?<![.\w])exec\(|node:worker_threads/)
        }
    })

    it('publisher pin rejects non-Ed25519 keys', async () => {
        const f = fixture(), rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
        f.settings.publisherKeys = { [PINNED_PUBLISHER_KEY_ID]: pem(rsa.publicKey) }
        const r = await inspectLatestRelease({ settings: f.settings, currentVersion: '2.80.0', fetcher: f.fetcher as any, pin: { keyId: PINNED_PUBLISHER_KEY_ID, spkiSha256: spkiSha(createPublicKey(pem(rsa.publicKey))) } })
        expect(r.state).toBe('rejected')
    })
})
