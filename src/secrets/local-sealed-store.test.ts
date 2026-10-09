import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OAuthManager } from '../auth/oauth.js'
import { TokenManager } from '../llm/nova-llm-sdk.js'
import { openCredential, readSecretJson, writeSecretJson } from './local-sealed-store.js'
import { speichereEintrag, mitZugang, entferneEintrag } from './credential-broker.js'
const roots: string[] = []
function root() { const dir = mkdtempSync(join(tmpdir(), 'xv-sealed-')); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const secret = ['fixture', 'only', 'not', 'a', 'credential'].join('-')
describe('local credential encryption boundary', () => {
    it('encrypts API-key values but preserves OAuth compatibility and restart reads', async () => {
        const dir = root(), path = join(dir, 'auth.json')
        const manager = new OAuthManager({ storePath: path })
        manager.setApiKey('llm-key:example', 'example', secret)
        expect(readFileSync(path, 'utf8')).not.toContain(secret)
        expect(await new OAuthManager({ storePath: path }).getApiKey('llm-key:example')).toBe(secret)
        expect(manager.getProfile('llm-key:example')).toMatchObject({ key: secret })
        expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false)
    })
    it.each([false, true])('migrates flat/wrapped legacy profiles without losing OAuth siblings (%s)', async wrapped => {
        const path = join(root(), 'auth.json')
        const profiles = { example: { key: secret }, local: { access: 'fixture-access', refresh: '', expires: Date.now() + 1_000_000 } }
        writeFileSync(path, JSON.stringify(wrapped ? { version: 1, profiles } : profiles))
        const manager = new OAuthManager({ storePath: path })
        expect(await manager.getApiKey('example')).toBe(secret)
        expect(await manager.getApiKey('local')).toBe('fixture-access')
        expect(readFileSync(path, 'utf8')).not.toContain(secret)
        const tokens = new TokenManager(path)
        expect(tokens.hasProvider('local')).toBe(true)
        expect(await tokens.getToken('local')).toMatchObject({ token: 'fixture-access' })
    })
    it.each(['missing', 'wrong', 'tamper'])('fails closed without overwriting after %s, including a cached manager', mode => {
        const dir = root(), path = join(dir, 'auth.json')
        const manager = new OAuthManager({ storePath: path }); manager.setApiKey('example', 'example', secret)
        const key = join(dir, '.credential-key')
        if (mode === 'missing') rmSync(key)
        else if (mode === 'wrong') writeFileSync(key, Buffer.alloc(32, 9))
        else {
            const data = JSON.parse(readFileSync(path, 'utf8'))
            const value = data.profiles.example.key
            data.profiles.example.key = value.slice(0, -4) + 'AAAA'
            writeFileSync(path, JSON.stringify(data))
        }
        const before = readFileSync(path, 'utf8')
        expect(() => new OAuthManager({ storePath: path }).getProfile('example')).toThrow()
        expect(() => manager.setApiKey('second', 'example', 'replacement-fixture')).toThrow()
        expect(readFileSync(path, 'utf8')).toBe(before)
    })
    it('isolates store roots and rejects unknown encryption versions', () => {
        const a = join(root(), 'werte.json'), b = join(root(), 'werte.json')
        writeSecretJson(a, { geheim: secret }); writeSecretJson(b, {})
        writeFileSync(b, readFileSync(a))
        expect(() => readSecretJson(b)).toThrow()
        expect(() => openCredential('nova-sealed:v2:AAAA', a)).toThrow()
    })
    it('migrates file-vault values, preserves releases and supports updates/deletion', async () => {
        const dir = root(), vault = join(dir, 'secrets', 'tresor'), path = join(vault, 'werte.json')
        mkdirSync(vault, { recursive: true })
        writeFileSync(path, JSON.stringify({ version: 1, werte: { fixture: { geheim: secret } } }))
        expect(speichereEintrag({ id: 'fixture', quelle: 'datei', dienste: ['example.com'] }, { dataDir: dir }).ok).toBe(true)
        expect(readFileSync(path, 'utf8')).not.toContain(secret)
        expect(await mitZugang('fixture', 'https://example.com', async value => value.geheim === secret, { dataDir: dir })).toMatchObject({ ok: true, ergebnis: true })
        expect(await mitZugang('fixture', 'https://other.example.com', async () => false, { dataDir: dir })).toMatchObject({ ok: false })
        expect(entferneEintrag('fixture', { dataDir: dir })).toBe(true)
        expect(readSecretJson(path).werte).toEqual({})
    })
})
