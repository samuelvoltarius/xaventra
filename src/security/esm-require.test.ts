import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// MI-18: the package is ESM ("type": "module"); a bare require() throws a
// ReferenceError at runtime (vitest supplies require, so this is checked
// statically) and the surrounding catch blocks hid the failure.

const ACTIVE_FILES = [
    'src/security/encrypted-memory.ts',
    'src/mesh/mesh-registry.ts',
    'src/mesh/node-intelligence.ts',
    'src/tts/text-to-speech.ts',
    'src/utils/nova-utils.ts',
    'src/process/nova-watchdog.ts',
]

const writes = vi.hoisted(() => [] as Array<{ path: string; options: unknown }>)
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, writeFileSync: (path: any, data: any, options?: any) => { writes.push({ path: String(path), options }); return actual.writeFileSync(path, data, options) } }
})

describe('MI-18 no CommonJS require in ESM runtime modules', () => {
    it.each(ACTIVE_FILES)('%s has no bare require()', file => {
        const source = readFileSync(join(process.env.NOVA_PROJECT_ROOT || process.cwd(), file), 'utf8')
        const code = source.split('\n').filter(line => !/^\s*(?:\/\/|\*)/.test(line)).join('\n')
        expect(code).not.toMatch(/(^|[^.\w])require\(/m)
    })

    it('encrypted memory writes its master key owner-only and round-trips', async () => {
        const { initEncryption, encrypt, decrypt } = await import('./encrypted-memory.js') as any
        expect(initEncryption('test-password-for-mi18')).toBe(true)
        const keyWrite = writes.find(entry => entry.path.endsWith('master.key'))
        expect(keyWrite?.options).toMatchObject({ mode: 0o600 })
        expect(decrypt(encrypt('geheim'))).toBe('geheim')
    })
})
