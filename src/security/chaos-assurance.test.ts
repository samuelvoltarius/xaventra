import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isExpectedWorkingDirectory, runChaosAssurance } from './chaos-assurance.js'

describe('chaos assurance', () => {
    const roots: string[] = []
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

    it('keeps policy, workspace, plugins and evidence fail closed', async () => {
        const report = await runChaosAssurance()
        expect(report.passed, JSON.stringify(report.checks.filter(check => !check.passed), null, 2)).toBe(true)
        expect(report.checks.every(check => check.passed)).toBe(true)
    })

    it('accepts canonical cwd through a directory alias on every platform', () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra-cwd-'))
        roots.push(root)
        const canonical = join(root, 'canonical')
        const alias = join(root, 'alias')
        mkdirSync(canonical)
        symlinkSync(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir')
        expect(alias).not.toBe(canonical)
        expect(isExpectedWorkingDirectory(alias, canonical)).toBe(true)
        expect(isExpectedWorkingDirectory(canonical, alias)).toBe(true)
    })

    it('rejects a different directory, missing paths and files', () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra-cwd-'))
        roots.push(root)
        const other = join(root, 'other')
        const file = join(root, 'file.txt')
        mkdirSync(other)
        writeFileSync(file, 'not a directory')
        expect(isExpectedWorkingDirectory(root, other)).toBe(false)
        expect(isExpectedWorkingDirectory(root, join(root, 'missing'))).toBe(false)
        expect(isExpectedWorkingDirectory(file, file)).toBe(false)
    })
})
