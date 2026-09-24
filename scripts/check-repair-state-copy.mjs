import { createRepairStateCopyScript } from '../dist/doctor/docker-repair-state.js'
import { mkdtempSync, mkdirSync, openSync, closeSync, ftruncateSync, writeSync, readSync, statSync, statfsSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const size = Number(process.env.XAVENTRA_STATE_COPY_TEST_BYTES || 129 * 1024 ** 2)
assert(Number.isSafeInteger(size) && size >= 129 * 1024 ** 2 && size <= 16 * 1024 ** 3, 'Invalid fixture size')
const base = tmpdir(), space = statfsSync(base)
assert(space.bavail * space.bsize >= size * 2 + 1024 ** 3, 'Insufficient fixture disk headroom')
const root = mkdtempSync(join(base, 'xaventra-state-copy-'))
const source = join(root, 'source'), destination = join(root, 'destination')
const marker = Buffer.from('xaventra-state-copy-fixture')
const started = Date.now()
try {
    mkdirSync(source); mkdirSync(destination)
    const fd = openSync(join(source, 'large-audit'), 'wx')
    try {
        ftruncateSync(fd, size)
        writeSync(fd, marker, 0, marker.length, 0)
        writeSync(fd, marker, 0, marker.length, size - marker.length)
    } finally { closeSync(fd) }
    const script = createRepairStateCopyScript({ maxBytes: size, maxFileBytes: size, timeoutMs: 540_000 })
        .replaceAll("'/source'", JSON.stringify(source)).replaceAll("'/destination'", JSON.stringify(destination))
    execFileSync(process.execPath, ['--max-old-space-size=48', '-e', script], { timeout: 540_000, stdio: 'pipe' })
    assert.equal(statSync(join(destination, 'large-audit')).size, size)
    const output = openSync(join(destination, 'large-audit'), 'r')
    try {
        for (const position of [0, size - marker.length]) {
            const bytes = Buffer.alloc(marker.length)
            assert.equal(readSync(output, bytes, 0, bytes.length, position), marker.length)
            assert.deepEqual(bytes, marker)
        }
    } finally { closeSync(output) }
    console.log(JSON.stringify({ passed: true, bytes: size, verifiedHashPasses: 3,
        fixture: 'disposable-filesystem-only', elapsedMs: Date.now() - started }))
} finally {
    assert.equal(dirname(root), base)
    assert(basename(root).startsWith('xaventra-state-copy-'))
    rmSync(root, { recursive: true, force: true })
}
