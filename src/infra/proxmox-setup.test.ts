import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, listApprovalCards, type ApprovalCard } from '../core/approval-cards.js'
import { loadProxmoxRuntime } from './proxmox.js'
import { confirmedProxmoxApp, readProxmoxAppSetup } from './proxmox-app-store.js'
import {
    FINGERPRINT_KIND, POOL_KIND, fingerabdruckKurz, proxmoxAdresse, proxmoxAnsicht, realTlsProbe, registerProxmoxSetupExecutors, speichereProxmoxZugang, vorgeschlageneAdressen, type SetupDeps,
} from './proxmox-setup.js'
import { createFakePve, fakeToken, selfSignedCert } from '../../test/helpers/fake-pve.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-pve-setup-')); dirs.push(dir); return dir }
let server: Server | null = null
afterEach(async () => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    if (server) await new Promise(resolve => server!.close(resolve))
    server = null
})
const OWNER = { userId: '7', ownerIds: ['7'] }
const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase().padStart(2, '0')).join(':')

function setupDeps(dir: string, extra: Partial<SetupDeps> & { noPool?: boolean } = {}): SetupDeps & { fake: ReturnType<typeof createFakePve> } {
    const fake = createFakePve({ noPool: extra.noPool })
    const cardOpts = { dataDir: dir, ledger: null }
    const deps: SetupDeps & { fake: ReturnType<typeof createFakePve> } = {
        dataDir: dir, cardOpts, fake, configEnabled: () => false,
        tlsProbe: async () => ({ fingerprint: FP, subject: 'pve.example.com' }),
        devices: () => [{ type: 'networkservice', host: '192.0.2.10', port: 8006, status: 'gefunden' }],
        runtime: () => loadProxmoxRuntime({ rawConfig: {}, env: {}, app: () => confirmedProxmoxApp({ dataDir: dir }), transport: fake.transport, log: () => {}, sleep: async () => {} }),
        ...extra,
    }
    registerProxmoxSetupExecutors(deps, { force: true })
    return deps
}
const press = (dir: string, card: ApprovalCard, answer = 'ja') => answerApprovalCard(`ac:${card.buttons.find(b => b.answer === answer)!.token}`, OWNER, { dataDir: dir, ledger: null })
const cardOf = (dir: string, kind: string) => listApprovalCards({ dataDir: dir, ledger: null }).find(card => card.aktion.kind === kind)

describe('Proxmox ohne Config (2.88)', () => {
    it('one token + the found address → fingerprint card → Ja → reading active without restart; token never visible', async () => {
        const dir = tmp()
        const deps = setupDeps(dir)
        const token = fakeToken()
        const before = await proxmoxAnsicht(deps)
        expect(before).toMatchObject({ eingerichtet: false, vorschlaege: ['https://192.0.2.10:8006'], tokenGespeichert: false })
        expect(before.anleitung).toHaveLength(3)
        expect((await deps.runtime!()).ok).toBe(false)
        const saved = await speichereProxmoxZugang({ token }, deps)
        expect(saved).toMatchObject({ ok: true, fingerabdruck: fingerabdruckKurz(FP) })
        // Not usable before the owner confirmed the fingerprint.
        expect((await deps.runtime!()).ok).toBe(false)
        const card = cardOf(dir, FINGERPRINT_KIND)!
        expect(card).toMatchObject({ art: 'proxmox', wirkung: 'infra' })
        expect(card.beleg).toContain('10:11:12:13')
        expect(card.beleg).toContain('2C:2D:2E:2F')
        expect(card.buttons.map(b => b.answer)).not.toContain('immer')
        const answer = await press(dir, card)
        expect(answer.message).toMatch(/Bestätigt\. Verbunden: ich sehe \d+ Gäste/)
        const runtime = await deps.runtime!()
        expect(runtime.ok).toBe(true)
        if (runtime.ok) expect(runtime.config).toMatchObject({ url: 'https://192.0.2.10:8006', fingerprint: FP, pool: 'xaventra' })
        expect(deps.fake.writes()).toEqual([])
        // The token is only in the 0600 secrets file — not in the setup file, the card or the view.
        const everything = JSON.stringify([readProxmoxAppSetup({ dataDir: dir }), listApprovalCards({ dataDir: dir, ledger: null }), await proxmoxAnsicht(deps)])
        expect(everything).not.toContain(token.split('=')[1])
        expect(readdirSync(join(dir, 'secrets', 'connections'))).toEqual(['c-proxmox-adapter.json'])
        expect(readFileSync(join(dir, 'connections', 'proxmox.json'), 'utf8')).not.toContain(token.split('=')[1])
    })

    it('a missing pool → a card with the steps, nothing is created by Xaventra', async () => {
        const dir = tmp()
        const deps = setupDeps(dir, { noPool: true })
        await speichereProxmoxZugang({ token: fakeToken(), adresse: '192.0.2.10' }, deps)
        const answer = await press(dir, cardOf(dir, FINGERPRINT_KIND)!)
        expect(answer.message).toMatch(/Pool „xaventra“ fehlt/)
        const pool = cardOf(dir, POOL_KIND)!
        expect(pool.beleg).toMatch(/Rechenzentrum → Berechtigungen → Pools/)
        expect(deps.fake.writes()).toEqual([])
    })

    it('refuses a wrong token format and a host without TLS; a changed fingerprint is not confirmed by an old card', async () => {
        const dir = tmp()
        const deps = setupDeps(dir)
        expect(await speichereProxmoxZugang({ token: 'root@pam!x=kein-uuid' }, deps)).toMatchObject({ ok: false, feld: 'token' })
        expect(await speichereProxmoxZugang({ token: fakeToken() }, { ...deps, tlsProbe: async () => null })).toMatchObject({ ok: false, feld: 'adresse' })
        await speichereProxmoxZugang({ token: fakeToken() }, deps)
        const old = cardOf(dir, FINGERPRINT_KIND)!
        const other = FP.replace(/^10/, 'AA')
        await speichereProxmoxZugang({ token: fakeToken() }, { ...deps, tlsProbe: async () => ({ fingerprint: other }) })
        // 2.89: the old card closes itself (its fingerprint is no longer the stored one) — nothing confirmed.
        expect((await press(dir, old)).message).toMatch(/erledigt/)
        expect(readProxmoxAppSetup({ dataDir: dir })?.bestaetigt).toBe(false)
    })

    it('an explicit infra.proxmox.enabled=false stays off (Standard AUS wins over the app)', async () => {
        const dir = tmp()
        const deps = setupDeps(dir)
        await speichereProxmoxZugang({ token: fakeToken() }, deps)
        await press(dir, cardOf(dir, FINGERPRINT_KIND)!)
        const off = await loadProxmoxRuntime({ rawConfig: { enabled: false }, env: {}, app: () => confirmedProxmoxApp({ dataDir: dir }), transport: deps.fake.transport })
        expect(off.ok).toBe(false)
    })

    it('addresses: discovery first, normalized to https host:8006', () => {
        expect(proxmoxAdresse('192.0.2.10')).toBe('https://192.0.2.10:8006')
        expect(proxmoxAdresse('http://pve.example.com:8443/#v1')).toBe('https://pve.example.com:8443')
        expect(proxmoxAdresse('https://user:pw@pve.example.com')).toBeNull()
        expect(vorgeschlageneAdressen({ devices: () => [{ type: 'networkservice', host: '192.0.2.11', port: 8006 }, { type: 'proxmox', host: '192.0.2.12', port: 8006 }, { type: 'homeassistant', host: '192.0.2.13', port: 8123 }] }))
            .toEqual(['https://192.0.2.12:8006', 'https://192.0.2.11:8006'])
    })

    it('reads the real fingerprint of a self-signed server by handshake only', async () => {
        const cert = selfSignedCert()
        let received = 0
        server = createServer({ cert: cert.cert, key: cert.key }, socket => { socket.on('data', chunk => { received += chunk.length }) })
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
        const port = (server.address() as any).port
        const peer = await realTlsProbe('127.0.0.1', port, 3000)
        expect(peer?.fingerprint).toBe(cert.fingerprint)
        expect(received).toBe(0)
    })
})
