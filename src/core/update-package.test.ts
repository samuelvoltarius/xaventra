import { it, expect, afterEach } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { gzipSync, gunzipSync } from 'node:zlib'
import { decodeUpdatePackage, encodeUpdatePackage, type ContainerUpdatePackage } from './update-package.js'
import { verifyUpstreamManifest } from './github-update.js'
const roots: string[] = []; afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
const value: ContainerUpdatePackage = { schema: 1, kind: 'docker', repository: 'samuelvoltarius/xaventra', version: '2.79.0', commit: 'a'.repeat(40), platform: 'linux', arch: 'x64', image: `ghcr.io/samuelvoltarius/xaventra@sha256:${'b'.repeat(64)}` }
const manifest: any = { version: value.version, commit: value.commit }
it('decodes one bound descriptor without extracting archive paths', () => { expect(decodeUpdatePackage(encodeUpdatePackage(value), manifest, 'x64')).toEqual(value) })
it.each(['wrong-origin', 'tag', 'architecture', 'commit'])('rejects descriptor %s', kind => {
    const v = { ...value }
    if (kind === 'wrong-origin') v.image = `attacker.example/image@sha256:${'b'.repeat(64)}`
    if (kind === 'tag') v.image = 'ghcr.io/samuelvoltarius/xaventra:latest'
    if (kind === 'architecture') v.arch = 'arm64'
    if (kind === 'commit') v.commit = 'c'.repeat(40)
    expect(() => decodeUpdatePackage(encodeUpdatePackage(v), manifest, 'x64')).toThrow('identity')
})
it('rejects malformed headers, extra entries and decompression bombs', () => {
    const raw = gunzipSync(encodeUpdatePackage(value)); raw[0] = 46
    expect(() => decodeUpdatePackage(gzipSync(raw), manifest, 'x64')).toThrow()
    expect(() => decodeUpdatePackage(gzipSync(Buffer.concat([gunzipSync(encodeUpdatePackage(value)), Buffer.alloc(512)])), manifest, 'x64')).toThrow()
    expect(() => decodeUpdatePackage(gzipSync(Buffer.alloc(200_000)), manifest, 'x64')).toThrow()
})
it('actual standalone publisher signs both architecture packages accepted by runtime verifier', () => {
    const root = mkdtempSync(join(tmpdir(), 'update-publisher-')); roots.push(root)
    const keys = generateKeyPairSync('ed25519')
    execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/publish-update.mjs', import.meta.url)), value.version, value.commit, root, value.image, value.image], {
        cwd: process.cwd(), env: { ...process.env, XAVENTRA_UPDATE_PUBLISHER_ID: 'fixture', XAVENTRA_UPDATE_PUBLISHER_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, stdio: 'pipe' })
    const signed = JSON.parse(readFileSync(join(root, 'xaventra-update.json'), 'utf8'))
    const m = verifyUpstreamManifest(signed, { publisherKeys: { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }, value.version, '2.78.22')
    for (const a of m.artifacts) {
        const bytes = readFileSync(join(root, a.name))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(a.sha256); expect(bytes.length).toBe(a.size)
        expect(decodeUpdatePackage(bytes, m, a.arch).arch).toBe(a.arch)
    }
})
