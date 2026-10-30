import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateConnectionSecretsToVault, readConnectionSecrets, writeConnectionSecrets, connectionSecretsPath } from './connection-store.js'

// Sicherheitsbefund 30.10.2026: owner-entered access values (tokens, passwords, HA/OAuth tokens)
// lay as plaintext JSON in <data>/secrets/connections/<id>.json (only 0600). They are now sealed
// (AES-256-GCM, local-sealed-store); existing plaintext files are migrated at start with a
// temporary backup, read back, then the plaintext is gone. Values never appear in logs.
// Fixture value only (built at runtime so secret scanners do not mistake it for a credential).
const SECRET = ['fixture', 'zugang', String(4711)].join('-')
const dirs: string[] = []
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'conn-vault-')); dirs.push(dir); return { dataDir: dir } }
afterEach(() => vi.restoreAllMocks())

function logs(): () => string {
    const lines: string[] = []
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
    return () => lines.join('\n')
}

describe('connection secrets live sealed in the vault', () => {
    it('a new access value is stored sealed, never as plaintext, and reads back', () => {
        const opts = fresh()
        writeConnectionSecrets('c-n8n', { zugang: { N8N_TOKEN: SECRET } }, opts)
        const raw = readFileSync(connectionSecretsPath('c-n8n', opts), 'utf8')
        expect(raw.startsWith('nova-sealed:v1:')).toBe(true)
        expect(raw).not.toContain(SECRET)
        expect(readConnectionSecrets('c-n8n', opts).zugang?.N8N_TOKEN).toBe(SECRET)
        if (process.platform !== 'win32') expect(statSync(connectionSecretsPath('c-n8n', opts)).mode & 0o777).toBe(0o600)
    })

    it('migrates existing plaintext at start: backup, seal, read back, plaintext and backup gone, nothing logged', () => {
        const opts = fresh()
        const dir = join(opts.dataDir, 'secrets', 'connections')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'c-telefon.json'), JSON.stringify({ zugang: { SIP_PASSWORT: SECRET } }), { mode: 0o600 })
        writeFileSync(join(dir, 'c-homeassistant.json'), JSON.stringify({ ha: { accessToken: SECRET + '-ha', expiresAt: 1, clientId: 'x' } }), { mode: 0o600 })
        const output = logs()
        const result = migrateConnectionSecretsToVault(opts)
        expect(result).toEqual({ migrated: ['c-homeassistant', 'c-telefon'], failed: [] })
        for (const name of ['c-telefon.json', 'c-homeassistant.json']) {
            const raw = readFileSync(join(dir, name), 'utf8')
            expect(raw.startsWith('nova-sealed:v1:')).toBe(true)
            expect(raw).not.toContain(SECRET)
        }
        expect(readConnectionSecrets('c-telefon', opts).zugang?.SIP_PASSWORT).toBe(SECRET)
        expect(readConnectionSecrets('c-homeassistant', opts).ha?.accessToken).toBe(SECRET + '-ha')
        expect(readdirSync(dir).filter(name => !name.startsWith('.credential-key')).sort()).toEqual(['c-homeassistant.json', 'c-telefon.json'])
        expect(output()).not.toContain(SECRET)
        // A second start finds nothing left to migrate.
        expect(migrateConnectionSecretsToVault(opts)).toEqual({ migrated: [], failed: [] })
    })

    it('Gegenprobe: an unreadable plaintext file stays untouched and is reported by id only', () => {
        const opts = fresh()
        const dir = join(opts.dataDir, 'secrets', 'connections')
        mkdirSync(dir, { recursive: true })
        const broken = `{"zugang":{"TOKEN":"${SECRET}"`
        writeFileSync(join(dir, 'c-kaputt.json'), broken, { mode: 0o600 })
        const output = logs()
        expect(migrateConnectionSecretsToVault(opts)).toEqual({ migrated: [], failed: ['c-kaputt'] })
        expect(readFileSync(join(dir, 'c-kaputt.json'), 'utf8')).toBe(broken)
        expect(output()).not.toContain(SECRET)
    })

    it('no secrets directory: nothing to do', () => {
        const opts = fresh()
        expect(migrateConnectionSecretsToVault(opts)).toEqual({ migrated: [], failed: [] })
        expect(existsSync(join(opts.dataDir, 'secrets', 'connections'))).toBe(false)
    })
})
