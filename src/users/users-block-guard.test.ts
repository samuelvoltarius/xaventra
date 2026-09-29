import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// R2 N-5 regression: an admin could block an explicitly granted owner or other
// admins, and `/users unblock` demoted any (non-blocked) user to guest.

let mu: typeof import('./multi-user-middleware.js')
const usersFile = join(process.cwd(), '.nova-data', 'multi-user', 'users.json')

beforeEach(async () => {
    vi.resetModules()
    writeFileSync('xaventra.config.json', JSON.stringify({ channels: { telegram: { allowFrom: ['1'] } } }))
    mkdirSync(join(process.cwd(), '.nova-data', 'multi-user'), { recursive: true })
    rmSync(usersFile, { force: true })
    mu = await import('./multi-user-middleware.js')
    mu.getOrCreateUser('cli', 'cli')
    mu.setUserPermission('cli', 'owner')
    for (const id of ['admin-a', 'admin-b', 'member']) mu.getOrCreateUser(id, 'Telegram')
    mu.setUserPermission('admin-a', 'admin')
    mu.setUserPermission('admin-b', 'admin')
    mu.setUserPermission('member', 'user')
})

describe('/users block and unblock (N-5)', () => {
    it('an admin cannot block the owner or another admin', () => {
        expect(mu.handleUserCommand('block', 'cli', 'admin-a')).toContain('Owner')
        expect(mu.getUserPermission('cli')).toBe('owner')
        expect(mu.handleUserCommand('block', 'admin-b', 'admin-a')).toContain('Nur der Owner')
        expect(mu.getUserPermission('admin-b')).toBe('admin')
    })

    it('an admin can still block a normal user; the owner can block an admin', () => {
        expect(mu.handleUserCommand('block', 'member', 'admin-a')).toContain('blockiert')
        expect(mu.getUserPermission('member')).toBe('blocked')
        expect(mu.handleUserCommand('block', 'admin-b', 'cli')).toContain('blockiert')
        expect(mu.getUserPermission('admin-b')).toBe('blocked')
    })

    it('unblock never demotes a user that is not blocked', () => {
        expect(mu.handleUserCommand('unblock', 'admin-b', 'admin-a')).toContain('nicht blockiert')
        expect(mu.getUserPermission('admin-b')).toBe('admin')
        mu.handleUserCommand('block', 'member', 'admin-a')
        expect(mu.handleUserCommand('unblock', 'member', 'admin-a')).toContain('entblockt')
        expect(mu.getUserPermission('member')).toBe('guest')
    })
})
