import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readPatchSnapshot } from '../synthesis/patch-sandbox.js'

const file = (name: string) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8')

describe('Installer-Weg per Doppelklick (2.85 Paket B, Punkt 5)', () => {
    it('install.cmd runs the same portable setup with the Desktop app, without admin rights or policy changes', () => {
        const cmd = file('install.cmd')
        expect(cmd).toContain('node "%~dp0scripts\\setup.mjs" --desktop')
        expect(cmd).not.toMatch(/Set-ExecutionPolicy|runas|reg add|netsh|sc create|curl|Invoke-WebRequest|iwr /i)
        expect(cmd).toMatch(/pause/i)
    })

    it('start.cmd starts the Core without a rebuild and opens the Desktop app; first start sets itself up', () => {
        const cmd = file('start.cmd')
        expect(cmd).toContain('dist\\daemon.js')
        expect(cmd).toContain('desktop\\node_modules\\.bin\\electron.cmd')
        expect(cmd).not.toMatch(/Set-ExecutionPolicy|runas|reg add|netsh|sc create|curl|Invoke-WebRequest/i)
    })

    it('the setup no longer sends new users to the terminal questionnaire first', () => {
        const setup = file('scripts/setup.mjs')
        expect(setup).not.toContain('Next: npm run cli -- setup')
        expect(file('docs/QUICKSTART.md')).toContain('install.cmd')
        expect(file('docs/FIRST_START.md')).toContain('registerConnectionsProvider(listConnections)')
    })

    it('the repair sandbox snapshot carries the double-click scripts, so the suite runs there too', () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra-snapshot-cmd-'))
        for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'xaventra.config.example.json']) writeFileSync(join(root, name), '{}')
        writeFileSync(join(root, 'vitest.config.ts'), 'export default {}')
        writeFileSync(join(root, 'install.cmd'), '@echo off')
        writeFileSync(join(root, 'notes.txt'), 'not an input')
        execFileSync('git', ['init', '-q'], { cwd: root })
        execFileSync('git', ['add', '-A'], { cwd: root })
        const files = Object.keys(readPatchSnapshot(root))
        expect(files).toContain('install.cmd')
        expect(files).not.toContain('notes.txt')
    })
})
