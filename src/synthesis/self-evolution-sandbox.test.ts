import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const boundary = vi.hoisted(() => ({ validate: vi.fn(), git: vi.fn() }))
vi.mock('./patch-sandbox.js', () => ({ validatePatchInSandbox: boundary.validate, assertPatchSourcePath: () => {} }))
vi.mock('node:child_process', () => ({
    execSync: boundary.git, spawn: () => { throw new Error('Host spawn forbidden in this test') },
}))
import { evolve, isEvolutionActive } from './self-evolution.js'

describe('actual evolve caller / scripted sandbox receipts', () => {
    const proposalFile = join(process.cwd(), '.nova-data', 'patch-proposals.json')
    const request = { file: 'src/repair-fixture.ts', description: 'fixture', search: '= 1', replace: '= 2', reproductionTest: 'src/reproduce.test.ts' }
    beforeEach(() => {
        boundary.validate.mockReset()
        boundary.git.mockReset().mockImplementation((command: string) => {
            if (command === 'git rev-parse --is-inside-work-tree') return 'true'
            throw new Error(`Unexpected host action: ${command}`)
        })
        mkdirSync(join(process.cwd(), 'src'), { recursive: true })
        writeFileSync(join(process.cwd(), request.file), 'export const value = 1')
        if (existsSync(proposalFile)) rmSync(proposalFile)
    })
    it('never queues a failed or unverified sandbox', async () => {
        boundary.validate.mockResolvedValue({ verified: false, output: 'SANDBOX_UNAVAILABLE' })
        expect(await evolve(request)).toMatchObject({ success: false })
        expect(existsSync(proposalFile)).toBe(false)
    })
    it('queues evidence and reproduction without granting application', async () => {
        boundary.validate.mockResolvedValue({ verified: true, rollbackPassed: true, recoveryPassed: true, output: '' })
        expect(await evolve({ ...request, approvalToken: 'must-not-persist' })).toMatchObject({ success: false, queued: true })
        const raw = readFileSync(proposalFile, 'utf8')
        expect(raw).not.toContain('must-not-persist')
        expect(JSON.parse(raw)[0]).toMatchObject({ reproductionTest: request.reproductionTest, sandbox: { rollbackPassed: true, recoveryPassed: true } })
        expect(readFileSync(join(process.cwd(), request.file), 'utf8')).toBe('export const value = 1')
    })
    it('holds exclusive ownership during asynchronous isolation', async () => {
        let finish: (value: any) => void
        boundary.validate.mockReturnValue(new Promise(resolve => { finish = resolve }))
        const first = evolve(request)
        expect(await evolve(request)).toMatchObject({ success: false, error: expect.stringContaining('bereits aktiv') })
        finish({ verified: false, output: 'fixture failure' })
        await first
    })
    it('keeps ownership until the outer approved-attempt promise settles', async () => {
        vi.stubEnv('NOVA_PATCH_GATE_TOKEN', 'fixture-only-approval')
        let competing: ReturnType<typeof evolve>
        boundary.validate.mockResolvedValue({ verified: true, output: '' })
        boundary.git.mockImplementation((command: string) => {
            if (command === 'git rev-parse --is-inside-work-tree') return 'true'
            if (command === 'git branch --show-current') return 'main'
            if (command === 'git status --porcelain') return ''
            if (command.startsWith('git checkout -b')) throw new Error('fixture branch rejection')
            if (command === 'git checkout "main" --force') {
                queueMicrotask(() => queueMicrotask(() => { competing = evolve(request) }))
                return ''
            }
            if (command.startsWith('git branch -D')) return ''
            throw new Error(`Unexpected host action: ${command}`)
        })
        try {
            await evolve({ ...request, apply: true, approvalToken: 'fixture-only-approval' })
            expect(await competing).toMatchObject({ success: false, error: expect.stringContaining('bereits aktiv') })
            expect(boundary.validate).toHaveBeenCalledTimes(1)
            expect(isEvolutionActive()).toBe(false)
        } finally { vi.unstubAllEnvs() }
    })
})
