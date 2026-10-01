import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, cardKeyboard, formatCardText, listApprovalCards, readThoughts, type ApprovalCard, type CardStoreOptions } from '../core/approval-cards.js'
import { getCommandMinimumRole } from '../core/slash-commands.js'
import { handleVmsCommand, proposeProxmoxAction, registerProxmoxCardExecutors, suggestThrowawayVm, type VmsDeps } from './proxmox-command.js'
import { ProxmoxClient, normalizeFingerprint, parseProxmoxConfig, parseProxmoxToken, type ProxmoxRuntime } from './proxmox.js'
import { FAKE_URL, createFakePve, fakeToken } from '../../test/helpers/fake-pve.js'

// Phase 6c: /vms and the Proxmox Knopf-Karten. No write request without the owner's Ja.

const OWNER = '111'
const RAW = { enabled: true, url: FAKE_URL, fingerprint: normalizeFingerprint('cd'.repeat(32)), pool: 'xaventra', create: { sshKeys: `ssh-ed25519 ${'B'.repeat(68)} owner@example.com` } }
let fake: ReturnType<typeof createFakePve>
let token: string
let opts: CardStoreOptions
let deps: VmsDeps

function runtime(): ProxmoxRuntime {
    const config = parseProxmoxConfig(RAW)
    return { ok: true, config, client: new ProxmoxClient({ config, token: parseProxmoxToken(token)!, transport: fake.transport, log: () => {}, sleep: async () => {}, taskPollMs: 1 }) }
}
const press = (card: ApprovalCard, answer: string, userId = OWNER) => answerApprovalCard(`ac:${card.buttons.find(b => b.answer === answer)!.token}`, { userId, ownerIds: [OWNER] }, opts)

beforeEach(() => {
    fake = createFakePve()
    token = fakeToken()
    opts = { dataDir: mkdtempSync(join(tmpdir(), 'pve-cards-')), now: () => Date.parse('2026-10-01T12:00:00Z'), ledger: null }
    deps = { runtime: async () => runtime(), cardOpts: opts, selfVmid: async () => 110, nodeOnly: false, now: () => Date.parse('2026-10-01T12:00:00Z') }
    registerProxmoxCardExecutors(deps, { force: true })
})

describe('/vms Übersicht', () => {
    it('is owner-only and lists every guest, marks this VM, the pool and my VMs with the free cap', async () => {
        expect(getCommandMinimumRole('vms')).toBe('owner')
        const text = await handleVmsCommand('', deps)
        expect(text).toContain('*110* xaventra-lab (VM, pve1) running')
        expect(text).toContain('← diese VM (Xaventra)')
        expect(text).toContain('*104* fremd-vm (VM, pve1) running')
        expect(text).toMatch(/\*104\*.*fremd, nur lesen/)
        expect(text).toMatch(/\*150\*.*Pool xaventra · meine/)
        expect(text).toContain('Meine VMs (Pool + Tag xaventra-created): 3 (150, 151, 153)')
        expect(text).toContain('frei: 54 GB RAM, 11 Kerne, 944 GB Disk')
        expect(text).toContain('Host *pve1*')
        expect(fake.writes()).toEqual([])
    })

    it('is off without config (Standard AUS) and sends nothing', async () => {
        const off: VmsDeps = { ...deps, runtime: async () => ({ ok: false, reason: 'infra.proxmox.enabled ist nicht true (Standard AUS)' }) }
        expect(await handleVmsCommand('', off)).toContain('Proxmox ist aus')
        expect(await handleVmsCommand('snapshot 150', off)).toContain('Proxmox aus')
        expect(fake.calls).toEqual([])
    })
})

describe('Karten statt Aktionen', () => {
    it('/vms snapshot creates only a card (impact infra, no "Immer erlauben"), no write request', async () => {
        const reply = await handleVmsCommand('snapshot 150 vor-update', deps)
        expect(reply).toContain('Karte erstellt')
        expect(fake.writes()).toEqual([])
        const [card] = listApprovalCards({ ...opts, status: 'offen' })
        expect(card).toMatchObject({ art: 'proxmox', wirkung: 'infra', aktion: { kind: 'pve-snapshot', ref: '150:vor-update' } })
        expect(card.buttons.map(b => b.answer)).toEqual(['ja', 'nein', 'spaeter'])
        expect(cardKeyboard(card).flat().map(b => b.text)).not.toContain('♾️ Immer erlauben')
        expect(formatCardText(card)).toContain('Wirkung: Infrastruktur (VMs) — fragt immer')
    })

    it('a guest outside the pool gets no card and no write', async () => {
        for (const args of ['start 104', 'stop 200', 'snapshot 104', 'vergroessern 104 ram=16', 'entfernen 104']) {
            const reply = await handleVmsCommand(args, deps)
            expect(reply, args).toContain('nicht im Pool')
        }
        expect(listApprovalCards(opts)).toEqual([])
        expect(fake.writes()).toEqual([])
    })

    it('Nein sends nothing; only Ja runs exactly one write with the exact vmid and verifies the task', async () => {
        const first = await proposeProxmoxAction({ action: 'start', vmid: 151 }, deps)
        const rejected = await press(first.card!, 'nein')
        expect(rejected.card?.result?.message).toContain('nichts gesendet')
        expect(fake.writes()).toEqual([])
        const second = await proposeProxmoxAction({ action: 'shutdown', vmid: 152 }, deps)
        expect(fake.writes()).toEqual([])
        const notOwner = await answerApprovalCard(`ac:${second.card!.buttons[0].token}`, { userId: '999', ownerIds: [OWNER] }, opts)
        expect(notOwner.code).toBe('kein-owner')
        expect(fake.writes()).toEqual([])
        const accepted = await press(second.card!, 'ja')
        expect(accepted.ok).toBe(true)
        expect(accepted.card?.result).toEqual({ ok: true, message: 'Proxmox-Task abgeschlossen (OK).' })
        expect(fake.writes()).toEqual([{ method: 'POST', path: '/nodes/pve1/qemu/152/status/shutdown', form: { timeout: '180' } }])
        expect(fake.taskPolls()).toBeGreaterThanOrEqual(2)
        expect(await press(second.card!, 'ja')).toMatchObject({ ok: false, code: 'verbraucht' })
        expect(fake.writes()).toHaveLength(1)
    })

    it('neu / wegwerf: L2 card, Ja creates with pool + tag; cap exceeded = no card, no write', async () => {
        const proposal = await suggestThrowawayVm('Test Mailserver', deps)
        expect(proposal.ok).toBe(true)
        expect(proposal.card).toMatchObject({ titel: 'Wegwerf-VM für „Test Mailserver“ anlegen?', aktion: { kind: 'pve-anlegen', ref: '160:wegwerf-test-mailserver:c2:m4096:d32' }, wirkung: 'infra' })
        expect(proposal.card!.beleg).toContain('Stufe L2')
        expect(fake.writes()).toEqual([])
        await press(proposal.card!, 'ja')
        expect(fake.writes()[0]).toMatchObject({ method: 'POST', path: '/nodes/pve1/qemu', form: { vmid: '160', pool: 'xaventra', tags: 'xaventra-created', net0: 'virtio,bridge=vmbr0' } })
        const tooBig = await handleVmsCommand('neu riesig 16 60 100', deps)
        expect(tooBig).toContain('Ressourcen-Deckel')
        expect(listApprovalCards({ ...opts, status: 'offen' })).toEqual([])
    })

    it('entfernen: only own stopped xaventra-created VMs get a card; the card warns about snapshots/backup', async () => {
        for (const [args, reason] of [['entfernen 152', 'Tag xaventra-created'], ['entfernen 153', 'protection=1'], ['loeschen 110', 'Tag xaventra-created'], ['delete 150', 'läuft noch']]) {
            expect(await handleVmsCommand(args, deps), args).toContain(reason)
        }
        expect(listApprovalCards(opts)).toEqual([])
        const ok = await proposeProxmoxAction({ action: 'destroy', vmid: 151 }, deps)
        expect(ok.card).toMatchObject({ aktion: { kind: 'pve-entfernen', ref: '151' }, wirkung: 'infra' })
        expect(ok.card!.beleg).toContain('Snapshots')
        expect(ok.card!.beleg).toContain('Backup')
        expect(ok.card!.buttons.map(b => b.answer)).not.toContain('immer')
        expect(fake.writes()).toEqual([])
        await press(ok.card!, 'ja')
        expect(fake.writes()).toEqual([{ method: 'DELETE', path: '/nodes/pve1/qemu/151?purge=1&destroy-unreferenced-disks=1' }])
    })

    it('refuses never-actions outright and re-checks at execution time', async () => {
        expect(await handleVmsCommand('reset 150', deps)).toContain('nie')
        expect(await handleVmsCommand('migrate 150', deps)).toContain('nie')
        const card = (await proposeProxmoxAction({ action: 'start', vmid: 151 }, deps)).card!
        fake.guests.find(g => g.vmid === 151)!.vmid = 9151 // guest left / was replaced meanwhile
        const answer = await press(card, 'ja')
        expect(answer.card?.result?.ok).toBe(false)
        expect(fake.writes()).toEqual([])
    })
})

describe('/vms cloudinit', () => {
    it('renders the own-VM snippet (user nova, NOPASSWD sudo) without writing anything', async () => {
        const text = await handleVmsCommand('cloudinit', deps)
        expect(text).toContain('/var/lib/vz/snippets/xaventra-nova.yaml')
        expect(text).toContain('sudo: "ALL=(ALL) NOPASSWD:ALL"')
        expect(text).toContain('owner@example.com')
        expect(fake.writes()).toEqual([])
    })
})

describe('Worker sendet nichts direkt', () => {
    it('creates no card and sends no request on a mesh worker', async () => {
        const worker: VmsDeps = { ...deps, nodeOnly: true }
        const reply = await handleVmsCommand('snapshot 150', worker)
        expect(reply).toContain('nur am Main')
        expect(listApprovalCards(opts)).toEqual([])
        expect(fake.calls).toEqual([])
        registerProxmoxCardExecutors(worker, { force: true })
        const card = (await proposeProxmoxAction({ action: 'start', vmid: 151 }, deps)).card!
        const answer = await press(card, 'ja')
        expect(answer.card?.result?.message).toContain('Worker')
        expect(fake.writes()).toEqual([])
    })
})

describe('Token nie in Karten oder Gedanken', () => {
    it('keeps the token out of the card store and the thought log', async () => {
        const card = (await proposeProxmoxAction({ action: 'snapshot', vmid: 150 }, deps)).card!
        await press(card, 'ja')
        const store = readdirSync(join(opts.dataDir!, 'approval-cards')).map(name => readFileSync(join(opts.dataDir!, 'approval-cards', name), 'utf8')).join('\n')
        expect(store).not.toContain(token.split('=')[1])
        expect(JSON.stringify(readThoughts(opts))).not.toContain(token.split('=')[1])
        expect(store).toContain('pve-snapshot')
    })
})
