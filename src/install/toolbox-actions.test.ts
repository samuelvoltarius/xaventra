import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 2.85 Paket D: the toolbox buttons use only the existing paths.
// "Installieren" = install queue + install card (the ticket only after "Ja").
// "Entfernen" = a card whose "Ja" runs the existing rollbackQueuedInstall.

const childProcess = vi.hoisted(() => ({
    exec: vi.fn(() => { throw new Error('exec must not run') }),
    execSync: vi.fn(() => { throw new Error('execSync must not run') }),
    execFile: vi.fn(() => { throw new Error('execFile must not run') }),
    spawn: vi.fn(() => { throw new Error('spawn must not run') }),
}))
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<any>()), ...childProcess }))

import { answerApprovalCard, listApprovalCards, type ApprovalCard, type CardStoreOptions } from '../core/approval-cards.js'
import { registerBuiltinCardExecutors } from '../core/approval-card-sources.js'
import { loadInstallQueue, type InstallQueueDeps, type InstallTargetNode } from './install-queue.js'
import { requestToolboxInstall, requestToolboxRemoval, type ToolboxActionDeps } from './toolbox-actions.js'

const keys = generateKeyPairSync('ed25519')
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const local: InstallTargetNode = { nodeId: 'main-a', installPath: 'host-agent', role: 'main', local: true, platform: 'linux', arch: 'x64', gpuVendor: 'none', version: '2.84.0' }

let clock = Date.parse('2026-10-02T10:00:00Z')
let opts: CardStoreOptions
let installDeps: InstallQueueDeps
let deps: ToolboxActionDeps
let host: { execute: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> }

const press = (card: ApprovalCard, answer: string, userId = '111') =>
    answerApprovalCard(`ac:${card.buttons.find(button => button.answer === answer)!.token}`, { userId, ownerIds: ['111'], via: 'desktop' }, opts)

beforeEach(() => {
    clock = Date.parse('2026-10-02T10:00:00Z')
    const dataDir = mkdtempSync(join(tmpdir(), 'toolbox-actions-'))
    opts = { dataDir, now: () => clock, ledger: { recordApproval: vi.fn() } }
    host = {
        execute: vi.fn(async (ticket: any) => ({ success: true, nodeId: 'main-a', ticketId: ticket.payload.id, catalogId: ticket.payload.catalogId, evidenceHash: 'e'.repeat(64), newPackages: ['tesseract-ocr'] })),
        rollback: vi.fn(async (ticket: any) => ({ success: true, nodeId: 'main-a', ticketId: ticket.payload.id, evidenceHash: 'f'.repeat(64) })),
        status: vi.fn(async () => null),
    }
    installDeps = { dataDir: join(dataDir, 'install'), ticketPrivateKey: privateKey, hostNodeId: 'main-a', hostClientId: 'xaventra-main', hostClient: host, now: () => clock }
    registerBuiltinCardExecutors({ installDeps: () => installDeps, selfHealDataDir: () => dataDir, patchProposals: () => [] })
    deps = { installDeps, target: async () => local, cards: { ...opts, deliverNow: false } }
})

describe('Werkzeugkasten-Knopf „Installieren“', () => {
    it('queues the catalog entry and offers the install card; nothing runs before "Ja"', async () => {
        const result = await requestToolboxInstall('tesseract-ocr', deps)
        expect(result.ok).toBe(true)
        expect(result.card).toMatchObject({ art: 'install', status: 'offen' })
        const [item] = loadInstallQueue(installDeps)
        expect(item).toMatchObject({ catalogId: 'tesseract-ocr', status: 'queued', source: 'owner', route: { kind: 'host-agent' } })
        expect(result.card!.aktion).toEqual({ kind: 'install', ref: item.id })
        expect(host.execute).not.toHaveBeenCalled()
        // A second press offers the same card again, no second proposal.
        const again = await requestToolboxInstall('tesseract-ocr', deps)
        expect(again.card!.id).toBe(result.card!.id)
        expect(loadInstallQueue(installDeps)).toHaveLength(1)
        // The owner's "Ja" on the card issues the one signed ticket.
        expect((await press(result.card!, 'ja')).ok).toBe(true)
        expect(host.execute).toHaveBeenCalledOnce()
        expect(host.execute.mock.calls[0][0].payload).toMatchObject({ catalogId: 'tesseract-ocr', approvedBy: 'owner:desktop:111' })
    })

    it('refuses anything outside the catalog (no free command, never-list stays)', async () => {
        for (const id of ['curl-pipe-installer', 'apt-get install htop', 'openssh-server', '', 42]) {
            const result = await requestToolboxInstall(id, deps)
            expect(result.ok, String(id)).toBe(false)
            expect(result.card).toBeUndefined()
        }
        expect(loadInstallQueue(installDeps)).toHaveLength(0)
        expect(listApprovalCards(opts)).toHaveLength(0)
    })

    it('no card when the route is not the host agent (container: only an image suggestion)', async () => {
        const result = await requestToolboxInstall('tesseract-ocr', { ...deps, target: async () => ({ ...local, installPath: 'image', role: 'worker', local: false }) })
        expect(result.card).toBeUndefined()
        expect(result.message).toMatch(/neues Image/)
        expect(listApprovalCards(opts)).toHaveLength(0)
    })
})

describe('Werkzeugkasten-Knopf „Entfernen“', () => {
    async function installed() {
        const result = await requestToolboxInstall('tesseract-ocr', deps)
        await press(result.card!, 'ja')
        return loadInstallQueue(installDeps)[0]
    }

    it('offers a rollback card; only "Ja" runs the existing rollback with a signed ticket', async () => {
        const item = await installed()
        expect(item.status).toBe('done')
        const result = await requestToolboxRemoval(item.id, deps)
        expect(result.ok).toBe(true)
        expect(result.card).toMatchObject({ art: 'install-rollback', aktion: { kind: 'install-rollback', ref: item.id }, status: 'offen' })
        // No "Immer erlauben" for removing.
        expect(result.card!.buttons.map(button => button.answer)).not.toContain('immer')
        expect(host.rollback).not.toHaveBeenCalled()
        expect((await press(result.card!, 'ja')).ok).toBe(true)
        expect(host.rollback).toHaveBeenCalledOnce()
        expect(host.rollback.mock.calls[0][0].payload).toMatchObject({ operation: 'rollback', catalogId: 'tesseract-ocr', approvedBy: 'owner:desktop:111' })
        expect(loadInstallQueue(installDeps)[0].status).toBe('rolled-back')
    })

    it('"Nein" changes nothing; a non-owner press runs nothing', async () => {
        const item = await installed()
        const first = await requestToolboxRemoval(item.id, deps)
        expect((await press(first.card!, 'ja', '222')).code).toBe('kein-owner')
        expect((await press(first.card!, 'nein')).ok).toBe(true)
        expect(host.rollback).not.toHaveBeenCalled()
        expect(loadInstallQueue(installDeps)[0].status).toBe('done')
    })

    it('no card for an unknown, open or "was already there" installation', async () => {
        expect((await requestToolboxRemoval('iq-ffffffffffff', deps)).ok).toBe(false)
        expect((await requestToolboxRemoval('../etc', deps)).ok).toBe(false)
        const open = await requestToolboxInstall('tesseract-ocr', deps)
        expect((await requestToolboxRemoval(open.card!.aktion.ref, deps)).ok).toBe(false)
        host.execute.mockImplementationOnce(async (ticket: any) => ({ success: true, alreadyInstalled: true, ticketId: ticket.payload.id, evidenceHash: 'e'.repeat(64) }))
        await press(open.card!, 'ja')
        const removal = await requestToolboxRemoval(open.card!.aktion.ref, deps)
        expect(removal.ok).toBe(false)
        expect(removal.message).toMatch(/schon vorher/)
        expect(listApprovalCards(opts).filter(card => card.art === 'install-rollback')).toHaveLength(0)
    })
})
