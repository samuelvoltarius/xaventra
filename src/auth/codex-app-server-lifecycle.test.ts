import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

// R2 M-1 / M-2 regressions. Before: every principal got its own
// `codex app-server` process that was never ended (unbounded processes), and
// after one crash `ready` stayed resolved on the dead process, so every later
// request of that principal failed until the daemon restarted.

const sandbox = join(process.cwd(), '.nova-test-tmp', `codex-lifecycle-${randomUUID()}`)
const fakeDir = join(sandbox, 'fake')
const fakeCodex = join(fakeDir, 'fake-codex.js')
const pidFile = join(sandbox, 'pids.txt')
mkdirSync(fakeDir, { recursive: true })
writeFileSync(join(fakeDir, 'package.json'), '{"type":"commonjs"}')
writeFileSync(pidFile, '')
writeFileSync(fakeCodex, `
const fs = require('fs')
fs.appendFileSync(process.env.FAKE_CODEX_PIDS, process.pid + '\\n')
const out = message => process.stdout.write(JSON.stringify(message) + '\\n')
require('readline').createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') out({ id: message.id, result: {} })
    if (message.method === 'account/read') {
        out({ id: message.id, result: { account: { type: 'chatgpt', planType: 'pro' } } })
        if (process.env.FAKE_CODEX_EXIT_AFTER_READ === '1') setTimeout(() => process.exit(0), 20)
    }
})
setInterval(() => undefined, 1000)
`)

vi.mock('../llm/codex-cli-adapter.js', () => ({ findCodexBinary: () => fakeCodex }))
process.env.NOVA_CODEX_AUTH_ROOT = join(sandbox, 'auth')
process.env.FAKE_CODEX_PIDS = pidFile

const { readCodexStatus } = await import('./codex-app-server.js')

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const pids = () => readFileSync(pidFile, 'utf-8').split('\n').filter(Boolean).map(Number)
const settle = () => new Promise(resolve => setTimeout(resolve, 300))

afterAll(() => {
    for (const pid of pids()) if (alive(pid)) try { process.kill(pid) } catch { /* gone */ }
    delete process.env.FAKE_CODEX_EXIT_AFTER_READ
    delete process.env.NOVA_CODEX_MAX_SESSIONS
})

describe('Codex app-server lifecycle', () => {
    it('restarts the process after it died instead of staying broken (M-2)', async () => {
        process.env.FAKE_CODEX_EXIT_AFTER_READ = '1'
        expect((await readCodexStatus('telegram:crash', 'node-a')).authenticated).toBe(true)
        await settle()
        expect((await readCodexStatus('telegram:crash', 'node-a')).authenticated).toBe(true)
        delete process.env.FAKE_CODEX_EXIT_AFTER_READ
    }, 20_000)

    it('keeps at most NOVA_CODEX_MAX_SESSIONS processes alive (M-1)', async () => {
        delete process.env.FAKE_CODEX_EXIT_AFTER_READ
        process.env.NOVA_CODEX_MAX_SESSIONS = '2'
        const before = new Set(pids())
        for (const principal of ['guest:1', 'guest:2', 'guest:3', 'guest:4', 'guest:5'])
            expect((await readCodexStatus(principal, 'node-b')).authenticated).toBe(true)
        await settle()
        const started = pids().filter(pid => !before.has(pid))
        expect(started).toHaveLength(5)
        expect(started.filter(alive).length).toBeLessThanOrEqual(2)
    }, 30_000)
})
