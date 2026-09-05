import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { purgeLegacyCodexCredentialCopies } from './legacy-codex-migration.js'

const dirs: string[] = []
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('legacy Codex credential migration', () => {
    it('removes OAuth copies while preserving API keys and unrelated providers', () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-codex-migration-'))
        dirs.push(root)
        const data = join(root, '.nova-data')
        mkdirSync(data)
        writeFileSync(join(data, 'openai-auth.json'), JSON.stringify({ access: 'secret', refresh: 'refresh-secret' }))
        writeFileSync(join(data, 'auth.json'), JSON.stringify({
            version: 1,
            profiles: {
                'openai-codex': { type: 'oauth', provider: 'openai-codex', access: 'a', refresh: 'r', expires: 1 },
                openai: { type: 'api_key', provider: 'openai', key: 'sk-kept' },
                anthropic: { type: 'api_key', provider: 'anthropic', key: 'kept' },
            },
        }))

        expect(purgeLegacyCodexCredentialCopies(data)).toEqual({ removedFiles: 1, removedProfiles: 1 })
        expect(existsSync(join(data, 'openai-auth.json'))).toBe(false)
        const persisted = JSON.parse(readFileSync(join(data, 'auth.json'), 'utf8'))
        expect(persisted.profiles['openai-codex']).toBeUndefined()
        expect(persisted.profiles.openai.key).toBe('sk-kept')
        expect(persisted.profiles.anthropic.key).toBe('kept')
    })
})
