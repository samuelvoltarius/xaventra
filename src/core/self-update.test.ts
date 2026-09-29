import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// R2 core-n-z #35 (latent, dashboard approve path): path check by includes(),
// "$&" patterns in replace() and a shell-string git commit.

const dir = mkdtempSync(join(tmpdir(), 'nova-self-update-'))
vi.spyOn(process, 'cwd').mockReturnValue(dir)
vi.spyOn(console, 'log').mockImplementation(() => undefined)
vi.spyOn(console, 'error').mockImplementation(() => undefined)

const childProcess = vi.hoisted(() => ({
    execSync: vi.fn((_command: string) => ''),
    execFileSync: vi.fn((_file: string, _args: string[]) => ''),
}))
vi.mock('node:child_process', async importOriginal => ({
    ...(await importOriginal<any>()),
    execSync: childProcess.execSync,
    execFileSync: childProcess.execFileSync,
}))

// Dynamic import: the module resolves its data dir from cwd at load time,
// which must already point at the temp dir (static imports are hoisted).
const { applyUpdate, commitAndPush, proposeUpdate } = await import('./self-update.js')

beforeEach(() => {
    childProcess.execSync.mockClear()
    childProcess.execFileSync.mockClear()
})
afterAll(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
})

describe('self-update safety (R2 NZ-35)', () => {
    it('rejects a path that only contains an allowed directory name', async () => {
        // Victim one level above the fake repo (inside this test's temp dir).
        const repo = join(dir, 'repo')
        mkdirSync(join(repo, 'src', 'core'), { recursive: true })
        const victim = join(dir, 'victim.ts')
        writeFileSync(victim, 'const a = 1\n')
        const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repo)
        try {
            const proposal = proposeUpdate('src/core/../../victim.ts', 'bugfix', 'x', 'const a = 1', 'const a = 2', 'r', 90)
            expect((await applyUpdate(proposal.id)).success).toBe(false)
            const forced = proposeUpdate('../victim.ts', 'bugfix', 'x', 'const a = 1', 'const a = 2', 'r', 90)
            expect((await applyUpdate(forced.id, true)).success).toBe(false)
            expect(readFileSync(victim, 'utf-8')).toBe('const a = 1\n')
        } finally {
            cwd.mockReturnValue(dir)
        }
    })

    it('keeps every proposal (saving must not reload and drop the new one)', () => {
        const first = proposeUpdate('src/core/a.ts', 'bugfix', 'first', 'a', 'b', 'r', 90)
        const second = proposeUpdate('src/core/b.ts', 'bugfix', 'second', 'a', 'b', 'r', 90)
        const saved = JSON.parse(readFileSync(join(dir, '.nova-data', 'self-updates', 'history.json'), 'utf-8'))
        const ids = saved.proposals.map((p: any) => p.id)
        expect(ids).toContain(first.id)
        expect(ids).toContain(second.id)
    })

    it('inserts newCode literally, without $& replacement patterns', async () => {
        mkdirSync(join(dir, 'src', 'core'), { recursive: true })
        const file = join(dir, 'src', 'core', 'sample.ts')
        writeFileSync(file, 'const value = 1\n')
        const proposal = proposeUpdate('src/core/sample.ts', 'bugfix', 'x', 'const value = 1', "const value = '$&'", 'r', 90)
        const result = await applyUpdate(proposal.id)
        expect(result.success).toBe(true)
        expect(readFileSync(file, 'utf-8')).toBe("const value = '$&'\n")
    })

    it('commits via argv, not a shell string', async () => {
        await commitAndPush('fix "quoted" $(touch pwned)')
        const commit = childProcess.execFileSync.mock.calls.find(call => call[1]?.[0] === 'commit')
        expect(commit?.[0]).toBe('git')
        expect(commit?.[1]).toEqual(['commit', '-m', '[Nova Auto] fix "quoted" $(touch pwned)'])
        expect(childProcess.execSync.mock.calls.some(call => String(call[0]).includes('git commit'))).toBe(false)
    })
})
