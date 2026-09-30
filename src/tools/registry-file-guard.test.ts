import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// INT-9 regression: the legacy registry's read_file / write_file /
// list_directory ignored the workspace boundary, the secret-file deny list and
// the write protection list of complete-registry.

vi.mock('../users/multi-user-middleware.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    getUserPermission: (id: string) => id?.startsWith('owner') ? 'owner' : 'guest',
}))

import { ToolRegistry, registerBuiltinTools } from './registry.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

const base = join(process.cwd(), '.nova-test-tmp', `legacy-file-guard-${randomUUID()}`)
const workspace = join(base, 'workspace')
const outside = join(base, 'outside')

function legacy() {
    const registry = new ToolRegistry()
    registerBuiltinTools(registry)
    return (name: string, args: Record<string, unknown>) => registry.execute({ id: `c-${name}`, name, arguments: args }, true)
}

beforeAll(() => {
    mkdirSync(join(workspace, 'notes'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(workspace, 'notes', 'a.txt'), 'workspace text')
    writeFileSync(join(workspace, '.env'), 'TOKEN=secret')
    writeFileSync(join(workspace, 'xaventra.config.json'), '{"secret":true}')
    writeFileSync(join(outside, 'o.txt'), 'outside text')
})
afterAll(() => rmSync(base, { recursive: true, force: true }))
afterEach(() => vi.unstubAllEnvs())

describe('legacy registry file tools use the complete-registry guards (INT-9)', () => {
    it('reads and lists inside the workspace', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const run = legacy()
        const read = await run('read_file', { path: 'notes/a.txt' })
        expect(read.success).toBe(true)
        expect((read.result as any).content).toBe('workspace text')
        const list = await run('list_directory', { path: 'notes' })
        expect(list.success).toBe(true)
        expect(JSON.stringify(list.result)).toContain('a.txt')
    })

    it('blocks reads/lists outside the workspace and traversal, even with a model-supplied owner id', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const run = legacy()
        for (const args of [{ path: join(outside, 'o.txt') }, { path: '../outside/o.txt' }, { path: join(outside, 'o.txt'), authorizationUserId: 'owner-1', channel: 'telegram' }]) {
            const result = await run('read_file', args)
            expect(result.success, JSON.stringify(args)).toBe(false)
            expect(JSON.stringify(result.result)).not.toContain('outside text')
        }
        expect((await run('list_directory', { path: outside })).success).toBe(false)
    })

    it('never returns secret files', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const run = legacy()
        for (const path of ['.env', 'xaventra.config.json']) {
            const result = await run('read_file', { path })
            expect(result.success, path).toBe(false)
            expect(JSON.stringify(result.result)).not.toContain('secret')
        }
    })

    it('enforces the write protection list and the workspace root', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const run = legacy()
        for (const path of ['xaventra.config.json', '.env', 'src/core/evil.ts', 'dist/daemon.js', '../outside/new.txt', join(outside, 'new.txt')]) {
            const result = await run('write_file', { path, content: 'x' })
            expect(result.success, path).toBe(false)
        }
        expect(readFileSync(join(workspace, 'xaventra.config.json'), 'utf8')).toBe('{"secret":true}')
        expect(existsSync(join(outside, 'new.txt'))).toBe(false)
        const ok = await run('write_file', { path: 'notes/new.txt', content: 'hello' })
        expect(ok.success, JSON.stringify(ok.result)).toBe(true)
        expect(readFileSync(join(workspace, 'notes', 'new.txt'), 'utf8')).toBe('hello')
    })

    it('uses the server-side execution context for the owner, never model arguments', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const run = legacy()
        const result = await withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram', runId: 'r1' },
            () => run('read_file', { path: join(outside, 'o.txt') }))
        expect(result.success, JSON.stringify(result.result)).toBe(true)
        expect((result.result as any).content).toBe('outside text')
    })
})
