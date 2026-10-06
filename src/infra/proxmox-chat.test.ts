import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { listApprovalCards, type CardStoreOptions } from '../core/approval-cards.js'
import { registerProxmoxCardExecutors, type VmsDeps } from './proxmox-command.js'
import { ProxmoxClient, normalizeFingerprint, parseProxmoxConfig, parseProxmoxToken } from './proxmox.js'
import { findeVm, proxmoxImGespraech, snapshotName } from './proxmox-chat.js'
import { FAKE_URL, createFakePve, fakeToken } from '../../test/helpers/fake-pve.js'

const RAW = { enabled: true, url: FAKE_URL, fingerprint: normalizeFingerprint('ab'.repeat(32)), pool: 'xaventra' }
const NOW = Date.parse('2026-10-07T12:00:00Z')
let fake: ReturnType<typeof createFakePve>
let opts: CardStoreOptions
let deps: VmsDeps

beforeEach(() => {
    fake = createFakePve()
    opts = { dataDir: mkdtempSync(join(tmpdir(), 'pve-chat-')), now: () => NOW, ledger: null }
    const config = parseProxmoxConfig(RAW)
    const client = new ProxmoxClient({ config, token: parseProxmoxToken(fakeToken())!, transport: fake.transport, log: () => {}, sleep: async () => {}, taskPollMs: 1 })
    deps = { runtime: async () => ({ ok: true, config, client }), cardOpts: opts, selfVmid: async () => 110, nodeOnly: false, now: () => NOW }
    registerProxmoxCardExecutors(deps, { force: true })
})

describe('Proxmox per Gespräch (2.88)', () => {
    it('„mach einen Snapshot von der Test-VM vor dem Update“ → one snapshot card, no write', async () => {
        const result = await proxmoxImGespraech({ aktion: 'snapshot', vm: 'Test-VM', snapshot: 'vor dem Update' }, deps)
        expect(result.ok).toBe(true)
        const [card] = listApprovalCards({ ...opts, status: 'offen' })
        expect(card).toMatchObject({ art: 'proxmox', aktion: { kind: 'pve-snapshot', ref: '150:vor-update-20261007-1200' } })
        expect(fake.writes()).toEqual([])
    })

    it('„starte xv alt“ → start card; pool guests first; unknown or ambiguous VMs are asked back', async () => {
        expect((await proxmoxImGespraech({ aktion: 'starten', vm: 'meine xv alt' }, deps)).ok).toBe(true)
        expect(listApprovalCards({ ...opts, status: 'offen' })[0].aktion).toEqual({ kind: 'pve-start', ref: '151' })
        expect((await proxmoxImGespraech({ aktion: 'starten', vm: 'xv' }, deps)).text).toMatch(/Welche meinst du/)
        expect((await proxmoxImGespraech({ aktion: 'starten', vm: 'gibt es nicht' }, deps)).text).toMatch(/finde ich nicht/)
        // Outside the pool: the adapter's own check refuses, no card.
        expect((await proxmoxImGespraech({ aktion: 'herunterfahren', vm: '104' }, deps)).text).toMatch(/nicht im Pool/)
        expect(fake.writes()).toEqual([])
    })

    it('reads without a card; hard stop and the like are refused; not set up → one plain hint', async () => {
        expect((await proxmoxImGespraech({ aktion: 'status' }, deps)).text).toMatch(/im Pool „xaventra“/)
        expect((await proxmoxImGespraech({ aktion: 'snapshots', vm: 'xv-test' }, deps)).text).toContain('vorher')
        expect((await proxmoxImGespraech({ aktion: 'herunterfahren', vm: 'xv-test', text: 'fahr die xv-test hart runter' }, deps)).text).toMatch(/nie/)
        expect((await proxmoxImGespraech({ aktion: 'zuruecksetzen', vm: 'xv-test' }, deps)).text).toMatch(/Auf welchen Snapshot/)
        expect((await proxmoxImGespraech({ aktion: 'status' }, { ...deps, runtime: async () => ({ ok: false, reason: 'aus' }) })).text).toMatch(/Verbindungen → Proxmox/)
        expect(listApprovalCards(opts)).toEqual([])
        expect(fake.writes()).toEqual([])
    })

    it('helpers: name matching and snapshot names', () => {
        const guests = [{ vmid: 150, name: 'test-vm' }, { vmid: 151, name: 'test-vm-2' }] as any
        expect(findeVm(guests, new Set([150, 151]), 'die Test VM').guest?.vmid).toBe(150)
        expect(snapshotName('', NOW)).toMatch(/^xv-/)
        expect(snapshotName('1 Update', NOW)).toBe('s-1-update-20261007-1200')
    })
})
