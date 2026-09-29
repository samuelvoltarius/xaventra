import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// R2 T23: code_search, find_files, code_outline and view_code_item use the
// same boundary as read_file (H6): workspace root for non-owners, no secrets.

vi.mock('../users/multi-user-middleware.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    getUserPermission: (id: string) => id?.startsWith('owner') ? 'owner' : id?.startsWith('admin') ? 'admin' : 'guest',
}))

import { codeSearchTool, findByNameTool } from './code-search.js'
import { codeOutlineTool, viewCodeItemTool } from './code-outline.js'

const base = join(process.cwd(), '.nova-test-tmp', `code-guard-${randomUUID()}`)
const workspace = join(base, 'workspace')
const outside = join(base, 'outside')
beforeAll(async () => {
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(join(workspace, '.ssh'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export function hello() { return "PRIVATE_MARK in code" }\n')
    writeFileSync(join(workspace, '.env'), 'TOKEN=PRIVATE_MARK_ENV\n')
    writeFileSync(join(workspace, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY----- PRIVATE_MARK_KEY\n')
    writeFileSync(join(outside, 'x.ts'), 'export const y = "PRIVATE_MARK outside"\n')
    await import('./complete-registry.js')
}, 120_000)
afterAll(() => rmSync(base, { recursive: true, force: true }))
beforeEach(() => vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace))

const admin = { authorizationUserId: 'admin-1', channel: 'telegram' }
const owner = { authorizationUserId: 'owner-1', channel: 'telegram' }

describe('R2 T23: code tools respect the file boundary', () => {
    it('non-owners cannot search, list or outline outside the workspace', async () => {
        expect(await codeSearchTool.handler({ ...admin, path: outside, query: 'PRIVATE_MARK' })).toMatchObject({ blocked: true })
        expect(await findByNameTool.handler({ ...admin, path: outside, pattern: '*.ts' })).toMatchObject({ blocked: true })
        expect(await codeOutlineTool.handler({ ...admin, path: join(outside, 'x.ts') })).toMatchObject({ blocked: true })
        expect(await viewCodeItemTool.handler({ ...admin, path: join(outside, 'x.ts'), name: 'y' })).toMatchObject({ blocked: true })
    })
    it('a recursive search never returns secret file contents, also for the owner', async () => {
        const result = await codeSearchTool.handler({ ...owner, path: workspace, query: 'PRIVATE_MARK' }) as any
        const text = JSON.stringify(result)
        expect(text).toContain('PRIVATE_MARK in code')
        expect(text).not.toContain('PRIVATE_MARK_ENV')
        expect(text).not.toContain('PRIVATE_MARK_KEY')
        expect(await codeSearchTool.handler({ ...owner, path: join(workspace, '.ssh'), query: 'PRIVATE' })).toMatchObject({ blocked: true })
    })
})
