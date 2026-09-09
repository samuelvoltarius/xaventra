// Compiled acceptance with a real HTTP fixture and disposable publisher key.
// URL mapping is injected only in this test; production origin rules stay fixed.
import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { GitHubUpdateSource, MANIFEST_ASSET, UPDATE_REPOSITORY } from '../dist/core/github-update.js'
import { upstreamUpdateCommand } from '../dist/core/upstream-update-command.js'

const parent = process.env.XAVENTRA_UPSTREAM_QA_DIR || tmpdir()
await mkdir(parent, { recursive: true })
const root = await mkdtemp(join(parent, 'upstream-'))
const report = { platform: process.platform, arch: process.arch, source: 'compiled code, real HTTP, generated test publisher; no production activation', checks: [], passed: false }
const check = (name, test) => { assert.ok(test, name); report.checks.push(name) }
const keys = generateKeyPairSync('ed25519'), bytes = Buffer.from('opaque fixture package, never extracted')
const artifact = { name: `xaventra-${process.platform}-${process.arch}.tar.gz`, platform: process.platform, arch: process.arch, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
const payload = { schema: 1, repository: UPDATE_REPOSITORY, version: '2.79.0', minUpdater: '2.78.21', commit: 'a'.repeat(40), artifacts: [artifact] }
const manifest = { keyId: 'fixture', payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('base64') }
const release = { tag_name: 'v2.79.0', draft: false, prerelease: false, assets: [MANIFEST_ASSET, artifact.name].map(name => ({ name, state: 'uploaded', browser_download_url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v2.79.0/${name}` })) }
let corrupt = false, requests = 0
const server = createServer((req, res) => {
    requests++
    res.end(req.url === '/releases' ? JSON.stringify([release]) : req.url === '/manifest' ? JSON.stringify(manifest) : corrupt ? Buffer.alloc(bytes.length) : bytes)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const fixtureFetch = (url, options) => fetch(base + (url.includes('api.github.com') ? '/releases' : url.endsWith(MANIFEST_ASSET) ? '/manifest' : '/package'), options)
const policy = { publisherKeys: { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }
try {
    const source = new GitHubUpdateSource(root, policy, '2.78.21', undefined, fixtureFetch)
    const available = await source.check()
    check('publisher-authenticated discovery over actual HTTP', available.state === 'available' && available.originVerified)
    const prepared = await source.prepare(available.releaseId)
    check('downloaded bytes match expected package', prepared.state === 'prepared' && (await readFile(prepared.packagePath)).equals(bytes))
    const restarted = new GitHubUpdateSource(root, policy, '2.78.21', undefined, fixtureFetch)
    check('status survives source restart', (await restarted.status()).state === 'prepared')
    const changedTrust = new GitHubUpdateSource(root, {}, '2.78.21', undefined, fixtureFetch)
    check('changed trust cannot reuse verified cache', (await changedTrust.status()).state === 'unknown')
    const before = requests
    check('user cannot download', (await upstreamUpdateCommand(`prepare ${available.releaseId}`, 'user', source)).includes('Owner/Admin') && requests === before)
    const deploy = await upstreamUpdateCommand(`deploy ${available.releaseId}`, 'owner', source)
    check('prepared is not a false activation success', deploy.includes('Kein Rollout gestartet'))
    corrupt = true
    check('changed package rejected over actual HTTP', (await restarted.prepare(available.releaseId)).state === 'unknown')
    report.passed = true
} catch (e) { report.error = String(e); process.exitCode = 1 }
finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ...report, report: join(root, 'report.json') }))
}
