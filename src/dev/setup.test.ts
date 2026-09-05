import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findNpmCli, seedConfiguration } from '../../scripts/setup.mjs'

describe('portable source installer', () => {
    it('locates npm without a shell command or platform-specific quoting', () => {
        expect(findNpmCli()).toMatch(/npm-cli\.js$/)
    })
    it('seeds private inert configuration and preserves credentials on rerun', () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra setup spaces-'))
        const configPath = seedConfiguration(root)
        const config = JSON.parse(readFileSync(configPath, 'utf8'))
        expect(config.name).toBe('Xaventra')
        expect(config.mesh.update.nodes).toEqual([])
        expect(config.server.host).toBe('127.0.0.1')
        const env = readFileSync(join(root, '.env'), 'utf8')
        expect(env).toMatch(/NOVA_API_TOKEN=[a-f0-9]{64}/)
        seedConfiguration(root)
        expect(readFileSync(join(root, '.env'), 'utf8')).toBe(env)
    })
    it('never migrates or overwrites an existing legacy configuration', () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra-legacy-'))
        const config = join(root, 'nova.config.json')
        writeFileSync(config, '{"name":"existing"}')
        expect(seedConfiguration(root)).toBe(config)
        expect(readFileSync(config, 'utf8')).toBe('{"name":"existing"}')
    })
})
