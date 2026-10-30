import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Auflage Koordinator 30.10.2026: the one vault key must not sit inside the data tree that is
// copied for backups, peer swaps and the rollback copy of the runtime. Key sources, in order:
// systemd LoadCredential ($CREDENTIALS_DIRECTORY/xaventra-credential-key), NOVA_CREDENTIAL_KEY_FILE
// (absolute path outside the data tree), Docker secret /run/secrets/xaventra-credential-key;
// only without any of them the old per-directory key in the data tree (with a start warning).
const VALUE = ['fixture', 'zugang', String(4711)].join('-')
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
}
async function modules() {
    const store = await import('../connections/connection-store.js')
    const sealed = await import('./local-sealed-store.js')
    return { ...store, ...sealed }
}

describe('vault key outside the data tree', () => {
    it('with NOVA_CREDENTIAL_KEY_FILE the key is created there (0600) and never inside the data tree', async () => {
        const root = mkdtempSync(join(tmpdir(), 'xv-native-'))
        mkdirSync(join(root, 'secrets'), { recursive: true }); mkdirSync(join(root, 'runtime'), { recursive: true })
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', join(root, 'secrets', 'credential.key'))
        const m = await modules()
        m.writeConnectionSecrets('c-n8n', { zugang: { N8N_TOKEN: VALUE } }, { dataDir: join(root, 'runtime') })
        expect(existsSync(join(root, 'secrets', 'credential.key'))).toBe(true)
        if (process.platform !== 'win32') expect(statSync(join(root, 'secrets', 'credential.key')).mode & 0o777).toBe(0o600)
        expect(walk(join(root, 'runtime')).some(path => path.endsWith('.credential-key'))).toBe(false)
        expect(m.readConnectionSecrets('c-n8n', { dataDir: join(root, 'runtime') }).zugang?.N8N_TOKEN).toBe(VALUE)
    })

    it('systemd LoadCredential wins and is only read, never created', async () => {
        const creds = mkdtempSync(join(tmpdir(), 'xv-creds-'))
        writeFileSync(join(creds, 'xaventra-credential-key'), Buffer.alloc(32, 7))
        vi.stubEnv('CREDENTIALS_DIRECTORY', creds)
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', join(creds, 'never-used.key'))
        const m = await modules()
        expect(m.vaultKeySource()).toMatchObject({ kind: 'systemd' })
        const data = mkdtempSync(join(tmpdir(), 'xv-data-'))
        m.writeConnectionSecrets('c-telefon', { zugang: { SIP_PASSWORT: VALUE } }, { dataDir: data })
        expect(existsSync(join(creds, 'never-used.key'))).toBe(false)
        expect(m.readConnectionSecrets('c-telefon', { dataDir: data }).zugang?.SIP_PASSWORT).toBe(VALUE)
    })

    it('re-keys existing in-tree sealed stores to the external key and removes the in-tree keys afterwards', async () => {
        const data = mkdtempSync(join(tmpdir(), 'xv-rekey-'))
        // 1) Old state: sealed with the per-directory key inside the data tree.
        let m = await modules()
        m.writeConnectionSecrets('c-homeassistant', { ha: { accessToken: VALUE, expiresAt: 1, clientId: 'x' } }, { dataDir: data })
        mkdirSync(join(data, 'secrets', 'tresor'), { recursive: true })
        m.writeSecretJson(join(data, 'secrets', 'tresor', 'werte.json'), { github: { geheim: VALUE } })
        expect(walk(data).filter(path => path.endsWith('.credential-key'))).toHaveLength(2)
        // 2) Operator sets the external key; start migration re-keys.
        const keyDir = mkdtempSync(join(tmpdir(), 'xv-key-'))
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', join(keyDir, 'credential.key'))
        vi.resetModules(); m = await modules()
        const result = m.rekeySealedStores(data)
        expect(result.failed).toEqual([])
        expect(result.rekeyed.length).toBe(2)
        expect(walk(data).filter(path => path.endsWith('.credential-key'))).toEqual([])
        expect(m.readConnectionSecrets('c-homeassistant', { dataDir: data }).ha?.accessToken).toBe(VALUE)
        expect(m.readSecretJson(join(data, 'secrets', 'tresor', 'werte.json')).github.geheim).toBe(VALUE)
        expect(readFileSync(join(data, 'secrets', 'tresor', 'werte.json'), 'utf8')).not.toContain(VALUE)
    })

    it('Gegenprobe: a wrong external key never destroys data — nothing is re-keyed or deleted', async () => {
        const data = mkdtempSync(join(tmpdir(), 'xv-wrongkey-'))
        const keyDir = mkdtempSync(join(tmpdir(), 'xv-key-a-'))
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', join(keyDir, 'a.key'))
        let m = await modules()
        m.writeConnectionSecrets('c-n8n', { zugang: { N8N_TOKEN: VALUE } }, { dataDir: data })
        const before = readFileSync(join(data, 'secrets', 'connections', 'c-n8n.json'), 'utf8')
        const other = mkdtempSync(join(tmpdir(), 'xv-key-b-'))
        writeFileSync(join(other, 'b.key'), Buffer.alloc(32, 9), { mode: 0o600 })
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', join(other, 'b.key'))
        vi.resetModules(); m = await modules()
        expect(m.rekeySealedStores(data).failed).toEqual(['secrets/connections/c-n8n.json'])
        expect(readFileSync(join(data, 'secrets', 'connections', 'c-n8n.json'), 'utf8')).toBe(before)
        expect(() => m.writeConnectionSecrets('c-n8n', { zugang: { N8N_TOKEN: 'x' } }, { dataDir: data })).toThrow()
    })

    it('native update copy (cp -a secrets + runtime, path swap in service.env) keeps everything readable; the rollback runtime copy holds no key', async () => {
        const oldRoot = mkdtempSync(join(tmpdir(), 'xaventra-native-old-'))
        for (const dir of ['secrets', 'runtime']) mkdirSync(join(oldRoot, dir), { recursive: true })
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', join(oldRoot, 'secrets', 'credential.key'))
        let m = await modules()
        m.writeConnectionSecrets('c-proxmox-adapter', { zugang: { PROXMOX_TOKEN: VALUE } }, { dataDir: join(oldRoot, 'runtime') })
        // update.mjs: cp -a oldRoot/secrets root/secrets; cp -a source/. runtime/; service.env oldRoot -> root.
        const newRoot = mkdtempSync(join(tmpdir(), 'xaventra-native-new-'))
        cpSync(join(oldRoot, 'secrets'), join(newRoot, 'secrets'), { recursive: true })
        cpSync(join(oldRoot, 'runtime'), join(newRoot, 'runtime'), { recursive: true })
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', join(oldRoot, 'secrets', 'credential.key').replaceAll(oldRoot, newRoot))
        vi.resetModules(); m = await modules()
        expect(m.readConnectionSecrets('c-proxmox-adapter', { dataDir: join(newRoot, 'runtime') }).zugang?.PROXMOX_TOKEN).toBe(VALUE)
        for (const runtime of [join(oldRoot, 'runtime'), join(newRoot, 'runtime')]) {
            expect(walk(runtime).some(path => path.endsWith('.credential-key') || path.endsWith('credential.key'))).toBe(false)
            expect(walk(runtime).map(path => readFileSync(path, 'utf8')).join('\n')).not.toContain(VALUE)
        }
    })
})

describe('smart-device keys (Hue/Tuya) are sealed too', () => {
    it('migrates a plaintext Hue key file at start and keeps it readable', async () => {
        const root = mkdtempSync(join(tmpdir(), 'xv-smart-'))
        mkdirSync(join(root, 'secrets', 'smart-devices'), { recursive: true })
        const hue = ['hue', 'fixture', 'abcdef0123456789'].join('')
        writeFileSync(join(root, 'secrets', 'smart-devices', 'dev-0123456789.json'), JSON.stringify({ hueKey: hue }), { mode: 0o600 })
        const { migrateSmartDeviceSecretsToVault } = await import('../sensing/smart-device-access.js')
        const { hueKey } = await import('../sensing/direct-smart-devices.js')
        expect(migrateSmartDeviceSecretsToVault(root)).toEqual({ migrated: ['dev-0123456789'], failed: [] })
        expect(readFileSync(join(root, 'secrets', 'smart-devices', 'dev-0123456789.json'), 'utf8')).not.toContain(hue)
        expect(hueKey(root, 'dev-0123456789')).toBe(hue)
    })
})
