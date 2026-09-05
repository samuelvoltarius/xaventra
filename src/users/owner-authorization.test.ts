import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let mu: typeof import('./multi-user-middleware.js')
const usersFile = join(process.cwd(), '.nova-data', 'multi-user', 'users.json')
const configure = (allowFrom: string[]) => writeFileSync('nova.config.json', JSON.stringify({ channels: { telegram: { allowFrom } } }))
const legacy = (id: string, permission: 'owner' | 'admin') => ({ id, channel: 'Telegram', permission, firstSeen: 1, lastSeen: 1, messageCount: 0, onboarded: true })

beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('NOVA_OS_MODE', 'true')
    configure([])
    mkdirSync(join(process.cwd(), '.nova-data', 'multi-user'), { recursive: true })
    rmSync(usersFile, { force: true })
    mu = await import('./multi-user-middleware.js')
})
afterEach(() => vi.unstubAllEnvs())

describe('explicit owner authority in OS mode', () => {
    it('never grants an unknown or new principal owner from OS mode alone', () => {
        expect(mu.getUserPermission('unknown')).toBe('guest')
        expect(mu.isToolAllowed('unknown', 'run_command')).toBe(false)
        for (const channel of ['Telegram', 'Discord', 'rest-api']) {
            const id = `unlisted-${channel}`
            expect(mu.checkAuth(id, channel).permission).toBe('user')
            expect(mu.isToolAllowed(id, 'run_command')).toBe(false)
        }
    })

    it('revokes persisted, unproven legacy owner and admin grants', () => {
        writeFileSync(usersFile, JSON.stringify({ oldOwner: legacy('oldOwner', 'owner'), oldAdmin: legacy('oldAdmin', 'admin') }))
        mu.loadUsers()
        for (const id of ['oldOwner', 'oldAdmin']) {
            expect(mu.getUserPermission(id)).toBe('user')
            expect(mu.isToolAllowed(id, 'run_command')).toBe(false)
            expect(JSON.parse(readFileSync(usersFile, 'utf8'))[id].permission).toBe('user')
        }
        expect(mu.handleUserCommand('promote', 'oldAdmin admin', 'oldOwner')).toContain('Nur der Owner')
    })

    it('preserves explicit local CLI and authenticated Desktop grants across reload', () => {
        for (const [id, channel] of [['cli', 'cli'], ['desktop:sample', 'desktop']]) {
            mu.getOrCreateUser(id, channel)
            expect(mu.setUserPermission(id, 'owner')).toBe(true)
        }
        mu.getOrCreateUser('delegated', 'Telegram')
        expect(mu.handleUserCommand('promote', 'delegated admin', 'cli')).toContain('admin')
        mu.loadUsers()
        expect(mu.getUserPermission('cli')).toBe('owner')
        expect(mu.getUserPermission('desktop:sample')).toBe('owner')
        expect(mu.getUserPermission('delegated')).toBe('admin')
    })

    it('keeps configured Telegram ownership but rejects foreign channel aliases', () => {
        configure(['123'])
        expect(mu.checkAuth('123', 'Telegram').permission).toBe('owner')
        expect(mu.isConfiguredOwner('telegram:123', 'Telegram', ['123'])).toBe(true)
        expect(mu.isConfiguredOwner('123', 'Discord', ['123'])).toBe(false)
        expect(mu.isConfiguredOwner('telegram:123', 'Discord', ['telegram:123'])).toBe(false)
        expect(mu.isConfiguredOwner('discord:123', 'Telegram', ['123'])).toBe(false)
    })

    it('does not reuse a raw-ID owner record from another channel', () => {
        configure(['123'])
        mu.checkAuth('123', 'Telegram')
        for (let pass = 0; pass < 2; pass++) {
            const denied = mu.checkAuth('123', 'Discord')
            expect(denied.allowed).toBe(false)
            expect(denied.permission).not.toBe('owner')
            expect(mu.getUserPermission('123', 'Discord')).toBe('guest')
            expect(mu.isToolAllowed('123', 'run_command', 'Discord')).toBe(false)
            expect(mu.getUserPermission('123', 'Telegram')).toBe('owner')
            mu.loadUsers()
        }
    })
})
