import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
let configPath = ''

vi.mock('../config/config-path.js', () => ({
    resolveConfigPath: () => configPath,
}))

const { AutoObserver, registerOwnerAlias } = await import('./auto-observer.js')

const readAliases = () => JSON.parse(readFileSync(configPath, 'utf-8')).userAliases || {}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-observer-alias-'))
    configPath = join(root, 'xaventra.config.json')
    writeFileSync(configPath, JSON.stringify({ userAliases: { '111': 'Alfred' } }, null, 2))
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

describe('auto-observer alias registration (R2 MA-1)', () => {
    it('does not register an alias for a guest who claims a name', async () => {
        const observer = new AutoObserver({ dataDir: join(root, 'observer') })
        await observer.observe('222', 'Hallo, ich heiße Elena', 'user', 's1', { permission: 'guest' })
        expect(readAliases()['222']).toBeUndefined()
    })

    it('does not register an alias when the caller passes no permission (fail-closed)', async () => {
        const observer = new AutoObserver({ dataDir: join(root, 'observer') })
        await observer.observe('333', 'Hallo, ich heiße Bernhard', 'user', 's1')
        expect(readAliases()['333']).toBeUndefined()
    })

    it('registers an alias for the owner', async () => {
        writeFileSync(configPath, JSON.stringify({ userAliases: {} }, null, 2))
        const observer = new AutoObserver({ dataDir: join(root, 'observer') })
        await observer.observe('111', 'Hallo, ich heiße Alfred', 'user', 's1', { permission: 'owner' })
        expect(readAliases()['111']).toBe('Alfred')
    })

    it('refuses a name that is already used by another id', () => {
        expect(registerOwnerAlias(configPath, '444', 'alfred')).toBe(false)
        expect(registerOwnerAlias(configPath, '444', 'Alfred')).toBe(false)
        expect(readAliases()['444']).toBeUndefined()
    })

    it('refuses lowercase words such as "müde"', () => {
        expect(registerOwnerAlias(configPath, '555', 'müde')).toBe(false)
        expect(readAliases()['555']).toBeUndefined()
    })

    it('writes atomically without leaving temp files', () => {
        expect(registerOwnerAlias(configPath, '666', 'Claudia')).toBe(true)
        expect(readAliases()['666']).toBe('Claudia')
        expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
        expect(existsSync(configPath)).toBe(true)
    })
})
