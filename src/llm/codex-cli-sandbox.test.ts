import { EventEmitter } from 'node:events'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[]; options: any }> }))

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        spawn: (command: string, args: string[], options: any) => {
            spawned.calls.push({ command, args, options })
            const proc: any = new EventEmitter()
            proc.stdin = new PassThrough()
            proc.stdout = new PassThrough()
            proc.stderr = new PassThrough()
            proc.kill = () => true
            setTimeout(() => {
                proc.stdout.end(JSON.stringify({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'OK' } }) + '\n')
                proc.stderr.end()
                proc.emit('close', 0)
            }, 0)
            return proc
        },
    }
})

import { CodexCLIAdapter, resetCodexBinaryCacheForTests } from './codex-cli-adapter.js'

const originalManagedBinary = process.env.NOVA_CODEX_BIN
const testRoot = join(process.cwd(), '.nova-test-tmp', 'codex-sandbox')

afterEach(() => {
    if (originalManagedBinary === undefined) delete process.env.NOVA_CODEX_BIN
    else process.env.NOVA_CODEX_BIN = originalManagedBinary
    resetCodexBinaryCacheForTests()
    rmSync(testRoot, { recursive: true, force: true })
    spawned.calls = []
})

function fakeBinary(): void {
    mkdirSync(testRoot, { recursive: true })
    const binary = join(testRoot, process.platform === 'win32' ? 'codex.exe' : 'codex')
    writeFileSync(binary, '')
    process.env.NOVA_CODEX_BIN = binary
    resetCodexBinaryCacheForTests()
}

function expectSandboxed(call: { args: string[]; options: any }): void {
    const sandboxAt = call.args.indexOf('--sandbox')
    expect(sandboxAt).toBeGreaterThan(-1)
    expect(call.args[sandboxAt + 1]).toBe('read-only')
    const cdAt = call.args.indexOf('-C')
    expect(cdAt).toBeGreaterThan(-1)
    const workdir = call.args[cdAt + 1]
    expect(workdir).not.toBe(process.cwd())
    expect(call.options.cwd).toBe(workdir)
    expect(readdirSync(workdir)).toEqual([])
}

describe('R2 L7: Codex LLM proxy runs read-only in an empty workdir', () => {
    it('complete() passes --sandbox read-only and -C to an empty directory', async () => {
        fakeBinary()
        const adapter = new CodexCLIAdapter('gpt-test')

        const result = await adapter.complete('hi')

        expect(result.content).toBe('OK')
        expect(spawned.calls).toHaveLength(1)
        expectSandboxed(spawned.calls[0])
    })

    it('stream() uses the same sandbox', async () => {
        fakeBinary()
        const adapter = new CodexCLIAdapter('gpt-test')

        for await (const _chunk of adapter.stream('hi')) { /* drain */ }

        expect(spawned.calls).toHaveLength(1)
        expectSandboxed(spawned.calls[0])
    })
})
