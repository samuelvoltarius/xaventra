// Build-time dependency contracts; run after npm ci --prefix desktop.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadArtifact, ElectronDownloadCacheMode } from '@electron/get'
// Deliberately inspect the pinned builder's transport boundary, not an app API.
const { shouldRetryDownloadError } = await import(new URL('./util/electronGet.js', import.meta.resolve('app-builder-lib')))
const { validateConfiguration } = await import(new URL('./util/config/config.js', import.meta.resolve('app-builder-lib')))

test('all platform packaging options match the pinned builder schema', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await validateConfiguration(pkg.build, { isEnabled: false })
  assert.equal(pkg.build.linux.maintainer, pkg.author)
  assert.match(pkg.build.deb.packageName, /^[a-z0-9][a-z0-9+.-]+$/)
})

test('locked build graph contains no vulnerable HTTP cache implementation, including nested copies', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  for (const name of Object.keys(lock.packages)) {
    assert.ok(!/(?:^|\/)node_modules\/(?:got|cacheable-request|http-cache-semantics)$/.test(name), name)
  }
  assert.equal(lock.packages['node_modules/electron-builder'].version, '27.0.0-alpha.9')
})

test('fetch download preserves headers, checksum validation, cache reuse and bounded cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xaventra-build-download-'))
  const body = Buffer.from('isolated build artifact')
  const checksum = createHash('sha256').update(body).digest('hex')
  let requests = 0
  const server = createServer((req, res) => {
    if (req.url === '/stall') return
    requests++
    if (req.headers['x-fixture'] !== 'build-contract') { res.writeHead(403).end(); return }
    res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const options = {
    version: '44.0.0', isGeneric: true, artifactName: 'fixture.bin',
    cacheRoot: join(directory, 'cache'), tempDirectory: directory,
    checksums: { 'fixture.bin': checksum },
    mirrorOptions: { resolveAssetURL: async () => `${base}/artifact` },
    downloadOptions: { quiet: true, headers: { 'x-fixture': 'build-contract' }, signal: AbortSignal.timeout(5000) },
  }
  try {
    const first = await downloadArtifact(options)
    assert.deepEqual(await readFile(first), body)
    assert.equal(await downloadArtifact(options), first)
    assert.equal(requests, 1, 'validated artifact cache remains usable')
    await assert.rejects(downloadArtifact({ ...options, cacheMode: ElectronDownloadCacheMode.Bypass,
      checksums: { 'fixture.bin': '0'.repeat(64) } }), /checksum/i)
    // A different expected checksum must also invalidate a previously cached artifact.
    await assert.rejects(downloadArtifact({ ...options, checksums: { 'fixture.bin': '1'.repeat(64) } }), /checksum/i)
    await assert.rejects(downloadArtifact({ ...options, cacheMode: ElectronDownloadCacheMode.Bypass,
      mirrorOptions: { resolveAssetURL: async () => `${base}/stall` },
      downloadOptions: { quiet: true, signal: AbortSignal.timeout(100) },
    }), /abort|timeout/i)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('builder recognizes fetch HTTP and wrapped network errors without retrying permanent failures', () => {
  assert.equal(shouldRetryDownloadError({ name: 'HTTPError', response: { status: 503 } }), true)
  assert.equal(shouldRetryDownloadError({ name: 'HTTPError', response: { status: 429 } }), true)
  assert.equal(shouldRetryDownloadError({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), true)
  assert.equal(shouldRetryDownloadError({ name: 'HTTPError', response: { status: 403 } }), false)
  assert.equal(shouldRetryDownloadError(new Error('checksum mismatch')), false)
})
