import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfigPath } from './config-path.js'

describe('Xaventra configuration migration', () => {
    it('creates new installations under the public product name', () => {
        const root = mkdtempSync(join(tmpdir(), 'config-path-'))
        expect(resolveConfigPath(root)).toBe(join(root, 'xaventra.config.json'))
    })
    it('keeps legacy installs readable without copying or merging files', () => {
        const root = mkdtempSync(join(tmpdir(), 'config-path-'))
        writeFileSync(join(root, 'nova.config.json'), '{"name":"legacy"}')
        expect(resolveConfigPath(root)).toBe(join(root, 'nova.config.json'))
        expect(readdirSync(root)).toEqual(['nova.config.json'])
        writeFileSync(join(root, 'xaventra.config.json'), '{"name":"current"}')
        expect(JSON.parse(readFileSync(resolveConfigPath(root), 'utf8')).name).toBe('current')
    })
    it('does not silently fall back to old credentials when the new file is invalid', () => {
        const root = mkdtempSync(join(tmpdir(), 'config-path-'))
        writeFileSync(join(root, 'nova.config.json'), '{}')
        writeFileSync(join(root, 'xaventra.config.json'), 'invalid')
        expect(() => JSON.parse(readFileSync(resolveConfigPath(root), 'utf8'))).toThrow()
    })
})
