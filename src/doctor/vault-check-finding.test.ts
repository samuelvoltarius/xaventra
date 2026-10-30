import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// 2.92.0: a sealed store no key opens is one error finding per path (recordErrorFinding): repeated /doctor runs raise
// its count instead of adding findings; the check still lists it. The finding names the path, never a value.
const record = vi.hoisted(() => ({ calls: [] as any[] }))
vi.mock('../core/self-doctor.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    recordErrorFinding: (input: unknown) => { record.calls.push(input); return null },
}))

describe('Doctor: unreadable vault store is one finding', () => {
    it('records one finding per store with source vault, stable over runs', async () => {
        const { checkVault } = await import('./vault-check.js')
        const dir = mkdtempSync(join(tmpdir(), 'vault-finding-'))
        mkdirSync(join(dir, 'secrets', 'connections'), { recursive: true })
        writeFileSync(join(dir, 'secrets', 'connections', 'ha.json'), 'nova-sealed:not-decryptable')
        const first = checkVault([dir])
        checkVault([dir])
        expect(first.ok).toBe(false)
        expect(first.issues.some(item => item.code === 'VAULT_STORE_UNREADABLE')).toBe(true)
        expect(record.calls).toHaveLength(2)
        expect(record.calls[0]).toMatchObject({ source: 'vault', severity: 'critical' })
        expect(record.calls[0].key).toBe(record.calls[1].key)
        expect(record.calls[0].line).toContain('secrets/connections/ha.json')
        expect(JSON.stringify(record.calls[0])).not.toContain('not-decryptable')
    })
})
