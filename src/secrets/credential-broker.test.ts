import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetSecretValues, redactSecrets } from '../security/secret-redaction.js'
import {
    dienstPasst, dienstVon, entferneEintrag, fuelleLogin, gibFrei, mitZugang, speichereEintrag, tresorBearerFetch, zugaengeSicht, type ExecLike,
} from './credential-broker.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-tresor-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); forgetSecretValues() })
// Fixture values, assembled so secret scanners do not mistake them for credentials.
const GEHEIM = ['Wolke', 'Apfel', 'Baum', '77'].join('-')
const BW_GEHEIM = ['Fluss', 'Stein', 'Licht', '19'].join('-')

describe('Passwort-Tresor als Secret-Broker (2.88)', () => {
    it('the model sees ids, names and services — never a value; files are private', () => {
        const dir = tmp()
        expect(speichereEintrag({ id: 'github-main', label: 'GitHub', quelle: 'datei', dienste: 'github.com', benutzer: 'owner@example.com', geheim: GEHEIM }, { dataDir: dir }).ok).toBe(true)
        const sicht = zugaengeSicht({ dataDir: dir })
        expect(sicht).toEqual([{ id: 'github-main', label: 'GitHub', quelle: 'datei', dienste: ['github.com'] }])
        expect(JSON.stringify(sicht)).not.toContain(GEHEIM)
        expect(readFileSync(join(dir, 'secrets', 'tresor', 'eintraege.json'), 'utf8')).not.toContain(GEHEIM)
        if (process.platform !== 'win32') expect(statSync(join(dir, 'secrets', 'tresor', 'werte.json')).mode & 0o777).toBe(0o600)
    })

    it('a value goes only to a released service, only inside the call, and is redacted afterwards', async () => {
        const dir = tmp()
        speichereEintrag({ id: 'github-main', quelle: 'datei', dienste: ['github.com'], geheim: GEHEIM }, { dataDir: dir })
        const used: string[] = []
        const ok = await mitZugang('github-main', 'https://github.com/login', async wert => { used.push(wert.geheim); return `angemeldet mit ${wert.geheim}` }, { dataDir: dir })
        expect(ok.ok).toBe(true)
        expect(used).toEqual([GEHEIM])
        // Whatever a tool logs or returns passes redactSecrets: the value is gone.
        expect(redactSecrets((ok as any).ergebnis)).toBe('angemeldet mit [TRESOR:github-main]')
        const other = await mitZugang('github-main', 'https://evil.example.com/login', async () => 'nie', { dataDir: dir })
        expect(other).toMatchObject({ ok: false, grund: 'freigabe-fehlt' })
        expect(await mitZugang('gibts-nicht', 'https://github.com', async () => 'x', { dataDir: dir })).toMatchObject({ ok: false, grund: 'unbekannt' })
        // Owner Ja on the release card: now it works for that service.
        expect(gibFrei('github-main', 'https://evil.example.com/x', { dataDir: dir })).toBe(true)
        expect((await mitZugang('github-main', 'https://evil.example.com/login', async () => 'ja', { dataDir: dir })).ok).toBe(true)
    })

    it('a release is per service: host covers all ports, host:port only that port', () => {
        expect(dienstVon('https://Example.com:8443/x')).toBe('example.com:8443')
        expect(dienstPasst(['example.com'], 'example.com:8443')).toBe(true)
        expect(dienstPasst(['192.0.2.10:8006'], '192.0.2.10:8443')).toBe(false)
        expect(dienstPasst(['example.com'], 'sub.example.com')).toBe(false)
        expect(dienstVon('https://user:pw@example.com')).toBeNull()
    })

    it('Bitwarden/Vaultwarden and 1Password: CLI without shell, fixed arguments, locked = clear message', async () => {
        const dir = tmp()
        const calls: Array<{ file: string; args: string[] }> = []
        const exec: ExecLike = async (file, args) => {
            calls.push({ file, args })
            if (file === 'bw') return { ok: true, stdout: args[1] === 'password' ? `${BW_GEHEIM}\n` : 'owner@example.com\n' }
            return { ok: true, stdout: BW_GEHEIM }
        }
        expect(speichereEintrag({ id: 'nas', quelle: 'bitwarden', ref: 'a1b2c3d4-0000-4000-8000-000000000001', dienste: '192.0.2.20' }, { dataDir: dir }).ok).toBe(true)
        expect(speichereEintrag({ id: 'nas', quelle: 'bitwarden', ref: 'x; rm -rf /', dienste: '192.0.2.20' }, { dataDir: dir }).ok).toBe(false)
        expect(speichereEintrag({ id: 'op-test', quelle: '1password', ref: 'op://Privat/Router/password', dienste: '192.0.2.1' }, { dataDir: dir }).ok).toBe(true)
        expect(speichereEintrag({ id: 'op-bad', quelle: '1password', ref: 'op://x/$(whoami)/p', dienste: '192.0.2.1' }, { dataDir: dir }).ok).toBe(false)
        const locked = await mitZugang('nas', 'http://192.0.2.20', async () => 'x', { dataDir: dir, exec, env: {} })
        expect(locked).toMatchObject({ ok: false, grund: 'gesperrt' })
        expect(calls).toEqual([])
        const bw = await mitZugang('nas', 'http://192.0.2.20', async wert => wert, { dataDir: dir, exec, env: { BW_SESSION: 'session' } })
        expect(bw).toMatchObject({ ok: true, ergebnis: { benutzer: 'owner@example.com', geheim: BW_GEHEIM } })
        expect(calls[0]).toEqual({ file: 'bw', args: ['get', 'password', 'a1b2c3d4-0000-4000-8000-000000000001', '--nointeraction'] })
        await mitZugang('op-test', 'http://192.0.2.1', async () => 'ok', { dataDir: dir, exec, env: {} })
        expect(calls.at(-1)).toEqual({ file: 'op', args: ['read', '--no-newline', 'op://Privat/Router/password'] })
    })

    it('connector token: Bearer is set per request from the vault, never stored in the connection config', async () => {
        const dir = tmp()
        speichereEintrag({ id: 'n8n-token', quelle: 'datei', dienste: ['192.0.2.30:5678'], geheim: GEHEIM }, { dataDir: dir })
        const base = vi.fn(async (_input: any, init?: any) => new Response(new Headers(init.headers).get('authorization') === `Bearer ${GEHEIM}` ? 'ok' : 'nein'))
        const fetcher = tresorBearerFetch('n8n-token', { dataDir: dir }, base as any)
        expect(await (await fetcher('http://192.0.2.30:5678/mcp')).text()).toBe('ok')
        await expect(fetcher('http://192.0.2.31:5678/mcp')).rejects.toThrow(/nicht freigegeben/)
    })

    it('browser login: fills the form on the released page only, returns no value', async () => {
        const dir = tmp()
        speichereEintrag({ id: 'github-main', quelle: 'datei', dienste: ['github.com'], benutzer: 'owner@example.com', geheim: GEHEIM }, { dataDir: dir })
        const typed: Array<[string, string]> = []
        const browser = (url: string) => ({ isRunning: () => true, getCurrentUrl: () => url, type: async (selector: string, text: string) => { typed.push([selector, text]) } })
        const result = await fuelleLogin('github-main', browser('https://github.com/login'), { dataDir: dir })
        expect(result).toEqual({ ok: true, ergebnis: { benutzer: true, passwort: true, dienst: 'github.com' } })
        expect(JSON.stringify(result)).not.toContain(GEHEIM)
        expect(typed.map(([selector]) => selector.includes('password'))).toEqual([false, true])
        typed.length = 0
        expect(await fuelleLogin('github-main', browser('https://github.example.com/login'), { dataDir: dir })).toMatchObject({ ok: false, grund: 'freigabe-fehlt' })
        expect(await fuelleLogin('github-main', browser('http://github.com/login'), { dataDir: dir })).toMatchObject({ ok: false })
        expect(typed).toEqual([])
    })

    it('removing an entry deletes the stored value; the password manager is never written', () => {
        const dir = tmp()
        speichereEintrag({ id: 'weg', quelle: 'datei', dienste: 'example.com', geheim: GEHEIM }, { dataDir: dir })
        expect(entferneEintrag('weg', { dataDir: dir })).toBe(true)
        expect(readFileSync(join(dir, 'secrets', 'tresor', 'werte.json'), 'utf8')).not.toContain(GEHEIM)
        expect(zugaengeSicht({ dataDir: dir })).toEqual([])
    })
})
