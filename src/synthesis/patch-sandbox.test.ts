import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', () => mocks)
import { assertPatchSourcePath, validatePatchInSandbox } from './patch-sandbox.js'

describe('repair sandbox boundary (scripted Docker, not live isolation proof)', () => {
    let root: string
    const image = `sha256:${'a'.repeat(64)}`
    const tracked = ['src/value.ts', 'src/value.test.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'xaventra.config.example.json']
    let runCodes: number[], runInputs: any[], calls: string[][], failCleanup: boolean
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'repair-unit-')); mkdirSync(join(root, 'src'))
        for (const file of tracked) writeFileSync(join(root, file), file === 'src/value.ts' ? 'export const value = 1' : '{}')
        writeFileSync(join(root, 'xaventra.config.json'), 'private-canary')
        vi.stubEnv('XAVENTRA_REPAIR_SANDBOX_IMAGE', image); vi.stubEnv('TELEGRAM_BOT_TOKEN', 'host-canary')
        mocks.execFileSync.mockReturnValue([...tracked, 'xaventra.config.json'].join('\0') + '\0')
        runCodes = []; runInputs = []; calls = []; failCleanup = false
        mocks.spawn.mockImplementation((_command, args: string[], options) => {
            expect(options.env.TELEGRAM_BOT_TOKEN).toBeUndefined()
            calls.push(args)
            const child: any = new EventEmitter()
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
            child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true })
            let input = ''; child.stdin.on('data', chunk => input += chunk.toString())
            child.stdin.on('finish', () => queueMicrotask(() => {
                let code = 0, output = ''
                if (args[0] === 'image') output = JSON.stringify([{ Id: image, Os: 'linux', Config: { Labels: {
                    'org.xaventra.sandbox.lock-sha256': createHash('sha256').update('{}').digest('hex'),
                } } }])
                if (args[0] === 'run') {
                    const data = JSON.parse(input); runInputs.push(data); code = runCodes.shift() ?? 0
                    if (data.command.includes('--reporter=json')) output = JSON.stringify({ numTotalTests: 1, numFailedTests: code === 10 ? 1 : 0, success: code === 0 })
                }
                if (args[0] === 'rm' && failCleanup) code = 1
                child.stdout.write(output); child.emit('close', code)
            }))
            return child
        })
    })
    afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); rmSync(root, { recursive: true, force: true }) })
    const request = (root: string) => ({ projectRoot: root, file: 'src/value.ts', search: '= 1', replace: '= 2' })
    it('runs baseline, candidate, rollback and clean recovery without changing the host', async () => {
        const result = await validatePatchInSandbox(request(root))
        expect(result).toMatchObject({ verified: true, rollbackPassed: true, recoveryPassed: true, cleanupVerified: true, symptomVerified: false })
        expect(result.phases.map(p => p.phase)).toEqual(['baseline', 'candidate', 'rollback', 'recovery'])
        expect(result.phases.map(p => p.snapshotHash)).toEqual([result.baselineHash, result.candidateHash, result.baselineHash, result.candidateHash])
        expect(readFileSync(join(root, 'src/value.ts'), 'utf8')).toBe('export const value = 1')
        expect(runInputs).toHaveLength(8)
        for (const input of runInputs) expect(input.files['xaventra.config.json']).toBeUndefined()
        for (const call of calls.filter(c => c[0] === 'run')) {
            for (const flag of ['--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=128', '--memory=4g', '--cpus=2', '--pull=never']) expect(call).toContain(flag)
            expect(call.join(' ')).not.toMatch(/--privileged|--mount|--volume|--env-file|--passWithNoTests/)
        }
    })
    it('requires the same symptom to fail before/after rollback and pass after each application', async () => {
        runCodes = [0, 0, 10, 0, 0, 0, 0, 0, 10, 0, 0, 0]
        const result = await validatePatchInSandbox({ ...request(root), reproductionTest: 'src/value.test.ts' })
        expect(result.verified).toBe(true); expect(result.reproductionPassed).toBe(true)
        expect(result.symptomVerified).toBe(false)
        expect(result.phases.map(p => p.reproductionPassed)).toEqual([false, true, false, true])
    })
    it('permits compiler repairs and verifies the failed original build on rollback', async () => {
        runCodes = [10, 0, 0, 0, 10, 0, 0, 0]
        const result = await validatePatchInSandbox(request(root))
        expect(result.verified).toBe(true)
        expect(result.phases.map(p => p.buildPassed)).toEqual([false, true, false, true])
    })
    it('does not mistake infrastructure failure for the original symptom', async () => {
        runCodes = [0, 0, 2]
        const result = await validatePatchInSandbox({ ...request(root), reproductionTest: 'src/value.test.ts' })
        expect(result.verified).toBe(false); expect(result.symptomVerified).toBe(false)
    })
    it.each([0, 1, 2, 3, 4, 5, 6, 7])('fails closed when command %i fails', async index => {
        runCodes = Array(index).fill(0).concat(1)
        expect((await validatePatchInSandbox(request(root))).verified).toBe(false)
        expect(calls.filter(c => c[0] === 'rm')).toHaveLength(index + 1)
    })
    it('does not certify cleanup failure', async () => {
        failCleanup = true
        expect(await validatePatchInSandbox(request(root))).toMatchObject({ verified: false, cleanupVerified: false })
    })
    it('rejects unavailable/unpinned isolation without a host fallback', async () => {
        vi.stubEnv('XAVENTRA_REPAIR_SANDBOX_IMAGE', 'node:latest')
        expect((await validatePatchInSandbox(request(root))).output).toContain('SANDBOX_UNAVAILABLE')
        expect(mocks.spawn).not.toHaveBeenCalled()
    })
    it.each(['../src/value.ts', '/src/value.ts', 'C:/src/value.ts', 'src/../value.ts', 'src\\value.ts', 'src-other/value.ts', 'src//value.ts', 'src/value.ts:stream'])('rejects path alias %s before execution', async file => {
        expect((await validatePatchInSandbox({ ...request(root), file })).verified).toBe(false)
        expect(mocks.spawn).not.toHaveBeenCalled()
    })
    it('rejects linked target ancestors and hard-linked inputs', () => {
        mkdirSync(join(root, 'other')); writeFileSync(join(root, 'other', 'file.ts'), 'x')
        symlinkSync(join(root, 'other'), join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
        expect(() => assertPatchSourcePath(root, 'src/linked/file.ts')).toThrow()
        linkSync(join(root, 'other', 'file.ts'), join(root, 'src', 'hard.ts'))
        expect(() => assertPatchSourcePath(root, 'src/hard.ts')).toThrow()
    })
    it('preserves legitimate bracketed and Unicode source paths', async () => {
        const file = 'src/[gerät].ts'
        writeFileSync(join(root, file), 'export const value = 1')
        mocks.execFileSync.mockReturnValue([...tracked, file].join('\0') + '\0')
        expect((await validatePatchInSandbox({ ...request(root), file })).verified).toBe(true)
    })
    it('rejects oracle changes and untracked reproduction tests', async () => {
        expect((await validatePatchInSandbox({ ...request(root), file: 'src/value.test.ts' })).verified).toBe(false)
        expect((await validatePatchInSandbox({ ...request(root), reproductionTest: 'src/missing.test.ts' })).verified).toBe(false)
        expect(mocks.spawn).not.toHaveBeenCalled()
    })
    it('rejects source mutation while checks run', async () => {
        const previous = mocks.execFileSync.getMockImplementation()
        let reads = 0
        mocks.execFileSync.mockImplementation((...args) => {
            if (++reads === 2) writeFileSync(join(root, 'src/value.ts'), 'changed by another worker')
            return previous(...args)
        })
        const result = await validatePatchInSandbox(request(root))
        expect(result.verified).toBe(false); expect(result.output).toContain('Source changed')
    })
})
