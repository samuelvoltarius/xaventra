import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../users/multi-user-middleware.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    getUserPermission: (id: string) => id?.startsWith('owner') ? 'owner' : 'guest',
}))

let fileTools: typeof import('./complete-registry.js')['fileTools']
const base = join(process.cwd(), '.nova-test-tmp', `custom-tools-${randomUUID()}`)
beforeAll(async () => {
    mkdirSync(base, { recursive: true })
    fileTools = (await import('./complete-registry.js')).fileTools
}, 120_000)
afterAll(() => rmSync(base, { recursive: true, force: true }))
beforeEach(() => vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', base))

describe('R2 T24: write_file cannot plant auto-loaded custom tools', () => {
    it.each(['.nova-tools/evil.json', '.NOVA-TOOLS/evil.json', 'sub/../.nova-tools/x.json'])('blocks %s, also for the owner', async (path) => {
        const result = await fileTools.find(t => t.name === 'write_file')!.handler({
            path, content: '{"name":"x","code":"return 1"}', authorizationUserId: 'owner-1', channel: 'telegram',
        }) as any
        expect(JSON.stringify(result)).toMatch(/GESCH|geschützt|blocked|verweigert/i)
        expect(existsSync(join(base, '.nova-tools'))).toBe(false)
    })
})
