import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isLeakedTailnetAddress, parseDenylist, scanText, scanRepository, loadDenylist } from '../../scripts/check-infra-leaks.mjs'

// Addresses outside the placeholder block are assembled at runtime so this file
// does not trip the check it tests.
const ip = (...parts: number[]) => parts.join('.')
const OUTSIDE = ip(100, 65, 1, 2)
const UPPER_MID = ip(100, 126, 9, 9)

describe('infra leak check', () => {
    it('allows only the tailnet placeholder blocks', () => {
        for (const allowed of ['100.64.0.10', '100.64.255.254', '100.127.255.254', '100.100.100.100', '100.63.1.1', '100.128.0.1', '192.0.2.10', '8.8.8.8']) expect(isLeakedTailnetAddress(allowed), allowed).toBe(false)
        for (const leaked of [OUTSIDE, UPPER_MID, ip(100, 100, 1, 2)]) expect(isLeakedTailnetAddress(leaked), leaked).toBe(true)
    })

    it('finds addresses in URLs, ssh targets and mapped IPv6, but not in longer dotted numbers', () => {
        const text = [`http://${OUTSIDE}:8000/v1`, `user@${OUTSIDE}`, `::ffff:${OUTSIDE}`, `version 1.${OUTSIDE}.4`, 'http://100.64.0.10:8000'].join('\n')
        expect(scanText('a.ts', text).map(finding => finding.line)).toEqual([1, 2, 3])
    })

    it('matches private denylist entries without echoing them', () => {
        const denylist = parseDenylist(['# comment', 'Internal-Host', 're:corp\\d+\\.example', ''].join('\n'))
        const findings = scanText('b.md', 'see internal-host\nok\nCORP42.example.org', denylist)
        expect(findings).toEqual([
            { path: 'b.md', line: 1, rule: 'private-denylist', detail: 'entry #1' },
            { path: 'b.md', line: 3, rule: 'private-denylist', detail: 'entry #2' },
        ])
        expect(JSON.stringify(findings)).not.toMatch(/internal-host|corp/i)
    })

    it('merges the env denylist with the untracked file', () => {
        const root = mkdtempSync(join(tmpdir(), 'leak-denylist-'))
        try {
            writeFileSync(join(root, '.leak-denylist'), 'from-file\n')
            expect(loadDenylist(root, { XAVENTRA_LEAK_DENYLIST: 'from-env' })).toEqual(['from-env', 'from-file'])
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('fails closed when a required private denylist is unavailable', () => {
        const root = mkdtempSync(join(tmpdir(), 'leak-required-'))
        try {
            expect(() => loadDenylist(root, { XAVENTRA_REQUIRE_LEAK_DENYLIST: '1' })).toThrow(/unavailable/)
            expect(loadDenylist(root, {})).toEqual([])
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('does not reveal an invalid private regex in its exception', () => {
        const value = 'private-fixture['
        let message = ''
        try { parseDenylist(`re:${value}`) } catch (error) { message = String(error) }
        expect(message).toContain('entry #1')
        expect(message).not.toContain(value)
    })

    it('scans tracked text files of a real repository only', () => {
        const root = mkdtempSync(join(tmpdir(), 'leak-repo-'))
        const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
        try {
            git('init')
            writeFileSync(join(root, 'tracked.test.ts'), `const host = '${OUTSIDE}'\n`)
            writeFileSync(join(root, 'untracked.md'), `${OUTSIDE}\n`)
            writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, ...Buffer.from(OUTSIDE)]))
            git('add', 'tracked.test.ts', 'blob.bin')
            const report = scanRepository(root, [])
            expect(report.findings.map(finding => `${finding.path}:${finding.line}`)).toEqual(['tracked.test.ts:1'])
        } finally { rmSync(root, { recursive: true, force: true }) }
    })

    it('this repository passes the generic rule', () => {
        expect(scanRepository(process.env.NOVA_PROJECT_ROOT || process.cwd(), []).findings).toEqual([])
    })
})
