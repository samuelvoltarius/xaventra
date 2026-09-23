import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertReleaseSource } from '../../scripts/release-source-provenance.mjs'

describe('release source provenance with real Git', () => {
    for (const mutation of ['clean', 'tracked', 'staged', 'digest']) {
        it(`checks ${mutation} source before Docker execution`, () => {
            const root = mkdtempSync(join(tmpdir(), 'release-source-'))
            const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
            try {
                git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
                writeFileSync(join(root, 'source.txt'), 'committed')
                git('add', 'source.txt'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
                if (mutation === 'digest') writeFileSync(join(root, 'image-x64.txt'), 'generated')
                if (mutation === 'tracked' || mutation === 'staged') writeFileSync(join(root, 'source.txt'), 'changed')
                if (mutation === 'staged') git('add', 'source.txt')
                if (mutation === 'clean') expect(assertReleaseSource(root)).toMatch(/^[a-f0-9]{40}$/)
                else expect(() => assertReleaseSource(root)).toThrow('Release source is dirty')
            } finally { rmSync(root, { recursive: true, force: true }) }
        })
    }
})
