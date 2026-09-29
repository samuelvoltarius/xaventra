import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// H6 regression: read_file / list_directory / read_document enforce the
// workspace root for non-owner roles and never return secret files.

vi.mock('../users/multi-user-middleware.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    getUserPermission: (id: string) => id?.startsWith('owner') ? 'owner' : id?.startsWith('user') ? 'user' : 'guest',
}))

import { fileTools } from './complete-registry.js'

const base = join(process.cwd(), '.nova-test-tmp', `file-guard-${randomUUID()}`)
const workspace = join(base, 'workspace')
const outside = join(base, 'outside')
const tool = (name: string) => fileTools.find(t => t.name === name)!
const read = (path: string, authorizationUserId?: string) => tool('read_file').handler({ path, authorizationUserId, channel: 'telegram' }) as Promise<any>
const list = (path: string, authorizationUserId?: string) => tool('list_directory').handler({ path, authorizationUserId, channel: 'telegram' }) as Promise<any>

beforeAll(() => {
    mkdirSync(join(workspace, 'sub'), { recursive: true })
    mkdirSync(join(workspace, '.nova-data', 'multi-user'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(workspace, 'notes.txt'), 'workspace notes')
    writeFileSync(join(workspace, '.env'), 'TOKEN=x')
    writeFileSync(join(workspace, '.env.local'), 'TOKEN=x')
    writeFileSync(join(workspace, 'xaventra.config.json'), '{}')
    writeFileSync(join(workspace, 'nova.config.json'), '{}')
    writeFileSync(join(workspace, 'key.pem'), 'k')
    writeFileSync(join(workspace, 'sub', 'id_ed25519'), 'k')
    writeFileSync(join(workspace, 'sub', 'id_rsa.pub'), 'k')
    writeFileSync(join(workspace, '.nova-data', 'multi-user', 'users.json'), '{}')
    writeFileSync(join(outside, 'outside.txt'), 'outside')
})
afterAll(() => rmSync(base, { recursive: true, force: true }))
afterEach(() => vi.unstubAllEnvs())

describe('file tool workspace boundary (H6)', () => {
    it('lets a user read workspace files by relative and absolute path', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        expect((await read('notes.txt', 'user-1')).content).toBe('workspace notes')
        expect((await read(join(workspace, 'notes.txt'), 'user-1')).content).toBe('workspace notes')
    })

    it('blocks non-owners outside the workspace, including traversal', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        for (const id of ['user-1', 'guest-1', undefined]) {
            expect((await read(join(outside, 'outside.txt'), id)).blocked, String(id)).toBe(true)
            expect((await read('../outside/outside.txt', id)).blocked, String(id)).toBe(true)
            expect((await list(outside, id)).blocked, String(id)).toBe(true)
        }
        expect((await list(workspace, 'user-1')).entries.map((e: any) => e.name)).toContain('notes.txt')
    })

    it('denies secret files to every role by default', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const secrets = ['.env', '.ENV', '.env.local', 'xaventra.config.json', 'nova.config.json', 'key.pem', 'sub/id_ed25519', 'sub/id_rsa.pub', '.nova-data/multi-user/users.json']
        for (const id of ['user-1', 'owner-1']) {
            for (const path of secrets) {
                const result = await read(path, id)
                expect(result.blocked, `${id} ${path}`).toBe(true)
                expect(JSON.stringify(result)).not.toContain('TOKEN=x')
            }
            expect((await list('.nova-data/multi-user', id)).blocked).toBe(true)
            expect((await read(join(homedir(), '.ssh', 'config'), id)).blocked).toBe(true)
        }
        expect((await tool('read_document').handler({ path: '.env', authorizationUserId: 'user-1', channel: 'telegram' }) as any).blocked).toBe(true)
    })

    it('owner may read outside the workspace but secrets only when explicitly configured', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        expect((await read(join(outside, 'outside.txt'), 'owner-1')).content).toBe('outside')
        vi.stubEnv('XAVENTRA_ALLOW_SECRET_FILE_READ', '1')
        expect((await read('.env', 'owner-1')).content).toBe('TOKEN=x')
        expect((await read('.env', 'user-1')).blocked).toBe(true)
    })
})
