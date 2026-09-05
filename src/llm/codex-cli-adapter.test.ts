import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findCodexBinary, resetCodexBinaryCacheForTests, resolveCodexCommand } from './codex-cli-adapter.js'

const originalManagedBinary = process.env.NOVA_CODEX_BIN
const testRoot = join(process.cwd(), '.nova-test-tmp', 'managed-codex-binary')

afterEach(() => {
    if (originalManagedBinary === undefined) delete process.env.NOVA_CODEX_BIN
    else process.env.NOVA_CODEX_BIN = originalManagedBinary
    resetCodexBinaryCacheForTests()
    rmSync(testRoot, { recursive: true, force: true })
})

describe('Codex CLI process invocation', () => {
    it('runs JavaScript entrypoints through the current Node runtime', () => {
        expect(resolveCodexCommand('C:\\codex\\bin\\codex.js', ['--version'])).toEqual({
            command: process.execPath,
            args: ['C:\\codex\\bin\\codex.js', '--version'],
        })
    })

    it('runs native binaries directly', () => {
        expect(resolveCodexCommand('/usr/local/bin/codex', ['--version'])).toEqual({
            command: '/usr/local/bin/codex',
            args: ['--version'],
        })
    })

    it('discovers Nova-managed persistent Codex before global locations', () => {
        mkdirSync(testRoot, { recursive: true })
        const binary = join(testRoot, process.platform === 'win32' ? 'codex.exe' : 'codex')
        writeFileSync(binary, '')
        process.env.NOVA_CODEX_BIN = binary
        resetCodexBinaryCacheForTests()

        expect(findCodexBinary()).toBe(binary)
    })
})
