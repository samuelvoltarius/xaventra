import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LifecyclePolicy } from './lifecycle-policy.js'

describe('lifecycle audit log hygiene (R2 UEB-24)', () => {
    it('redacts secrets and truncates large values', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-policy-audit-'))
        const file = join(dir, 'audit.jsonl')
        const policy = new LifecyclePolicy(file)
        await policy.run('tool.before', { toolName: 'write_file', input: { apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456', content: 'x'.repeat(50_000) } })
        const log = readFileSync(file, 'utf8')
        expect(log).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456')
        expect(log.length).toBeLessThan(10_000)
        rmSync(dir, { recursive: true, force: true })
    })

    it('rotates the file instead of growing without bound', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-policy-audit-'))
        const file = join(dir, 'audit.jsonl')
        writeFileSync(file, 'x'.repeat(6 * 1024 * 1024))
        await new LifecyclePolicy(file).run('tool.before', { toolName: 'demo', input: {} })
        expect(existsSync(`${file}.1`)).toBe(true)
        expect(statSync(file).size).toBeLessThan(10_000)
        rmSync(dir, { recursive: true, force: true })
    })
})
