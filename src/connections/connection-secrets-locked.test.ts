import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Bedingung Koordinator 30.10.2026: a sealed store that cannot be opened (vault key missing/wrong)
// must never silently look like "no access" or "login expired" (B3 class). The connection shows
// „Schlüssel fehlt“ with its reason, the Doctor reports the store, nothing is deleted or overwritten,
// and with the right key everything is normal again.
const VALUE = ['fixture', 'zugang', String(4711)].join('-')
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

const record = (id: string, connectorId: string, auth: any, extra: Record<string, unknown> = {}) => ({
    id, connectorId, trust: 'geprueft', title: id, kategorie: 'weitere', datenklasse: 'privat', auth, transport: { art: 'http', url: 'http://192.0.2.10/mcp' },
    status: 'verbunden', createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', approvedBy: 'owner', erlaubteWerkzeuge: [], ...extra,
}) as any

async function withKey(dir: string, name: string) {
    vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', join(dir, name))
    vi.resetModules()
    return {
        store: await import('./connection-store.js'),
        state: await import('./connection-state.js'),
        login: await import('./connector-login.js'),
        vault: await import('../doctor/vault-check.js'),
    }
}

describe('a locked vault store is visible, never silent', () => {
    it('wrong key: status „Schlüssel fehlt“ with reason, file untouched; right key: connected again', async () => {
        const data = mkdtempSync(join(tmpdir(), 'xv-locked-')), keys = mkdtempSync(join(tmpdir(), 'xv-keys-'))
        writeFileSync(join(keys, 'b.key'), Buffer.alloc(32, 9), { mode: 0o600 })
        let m = await withKey(keys, 'a.key')
        m.store.saveConnection(record('c-n8n', 'n8n', 'token'), { dataDir: data })
        m.store.writeConnectionSecrets('c-n8n', { zugang: { N8N_TOKEN: VALUE } }, { dataDir: data })
        const sealed = readFileSync(join(data, 'secrets', 'connections', 'c-n8n.json'), 'utf8')

        m = await withKey(keys, 'b.key')
        expect(m.store.readConnectionSecrets('c-n8n', { dataDir: data })).toEqual({})
        const locked = m.store.getConnection('c-n8n', { dataDir: data })!
        expect(locked.status).toBe('schluessel-fehlt')
        expect(locked.schluesselFehlt).toMatchObject({ vorher: 'verbunden' })
        const stand = m.state.connectionState(data, { verbindung: locked } as any)
        expect(stand.grund).toContain('Schlüssel fehlt')
        expect(stand.grund).toContain('nichts gelöscht')
        expect(readFileSync(join(data, 'secrets', 'connections', 'c-n8n.json'), 'utf8')).toBe(sealed)
        const view = await import('./connections-view.js')
        const text = await view.formatConnectionsText({ dataDir: data, connections: () => [m.store.getConnection('c-n8n', { dataDir: data })!], devices: () => [], accounts: () => [] })
        expect(text).toContain('Schlüssel fehlt')
        expect(text).not.toContain('Anmeldung fehlt')
        const doctor = m.vault.checkVault([data])
        expect(doctor.ok).toBe(false)
        expect(doctor.issues.map(i => i.message)).toContain('Tresor-Speicher nicht lesbar: secrets/connections/c-n8n.json')

        // Gegenprobe: the right key again → normal, status restored, Doctor clean.
        m = await withKey(keys, 'a.key')
        expect(m.store.readConnectionSecrets('c-n8n', { dataDir: data }).zugang?.N8N_TOKEN).toBe(VALUE)
        expect(m.store.getConnection('c-n8n', { dataDir: data })!.status).toBe('verbunden')
        expect(m.store.getConnection('c-n8n', { dataDir: data })!.schluesselFehlt).toBeUndefined()
        expect(m.vault.checkVault([data]).issues.filter(i => i.severity === 'error')).toEqual([])
    })

    it('Home Assistant with a locked store is never marked „Anmeldung abgelaufen“ and asks no new login', async () => {
        const data = mkdtempSync(join(tmpdir(), 'xv-ha-locked-')), keys = mkdtempSync(join(tmpdir(), 'xv-ha-keys-'))
        writeFileSync(join(keys, 'b.key'), Buffer.alloc(32, 9), { mode: 0o600 })
        let m = await withKey(keys, 'a.key')
        m.store.saveConnection(record('c-homeassistant', 'home-assistant', 'ha-login', { basis: 'http://192.0.2.20:8123' }), { dataDir: data })
        m.store.writeConnectionSecrets('c-homeassistant', { ha: { accessToken: VALUE, expiresAt: Date.now() + 3_600_000, clientId: 'x' } }, { dataDir: data })
        m = await withKey(keys, 'b.key')
        const askLogin = vi.fn(), fetchFn = vi.fn()
        const call = m.login.haBearerFetch('c-homeassistant', { dataDir: data, redirectBase: 'http://127.0.0.1:3011', askLogin, fetchFn } as any)
        await expect(call('http://192.0.2.20:8123/api/mcp', {})).rejects.toThrow(/Schlüssel fehlt/)
        expect(m.store.getConnection('c-homeassistant', { dataDir: data })!.status).toBe('schluessel-fehlt')
        expect(askLogin).not.toHaveBeenCalled()
        expect(fetchFn).not.toHaveBeenCalled()
    })

    it('Doctor warns when the vault key lies in the data tree', async () => {
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', '')
        vi.resetModules()
        const { checkVault } = await import('../doctor/vault-check.js')
        const result = checkVault([mkdtempSync(join(tmpdir(), 'xv-empty-'))])
        if (!existsSync('/run/secrets/xaventra-credential-key'))
            expect(result.issues.map(i => i.code)).toContain('VAULT_KEY_IN_DATA_TREE')
    })
})
