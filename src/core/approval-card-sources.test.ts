import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 1 Teil A: Stufe-2/Stufe-3/PATCH_GATE proposals become button cards.
// "Ja" always runs the existing path (install ticket, self-heal proposal
// status, PATCH_GATE approval); the card itself carries only a reference.

const childProcess = vi.hoisted(() => ({
    exec: vi.fn(() => { throw new Error('exec must not run') }),
    execSync: vi.fn(() => { throw new Error('execSync must not run') }),
    execFile: vi.fn(() => { throw new Error('execFile must not run') }),
    spawn: vi.fn(() => { throw new Error('spawn must not run') }),
}))
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<any>()), ...childProcess }))

import { answerApprovalCard, listApprovalCards, type ApprovalCard, type CardStoreOptions } from './approval-cards.js'
import { deliverPendingCards, registerBuiltinCardExecutors, syncApprovalCardsFromSources, type CardSender } from './approval-card-sources.js'
import { loadInstallQueue, proposeCatalogInstall, type InstallQueueDeps, type InstallTargetNode } from '../install/install-queue.js'
import { readHealProposals } from '../doctor/self-heal.js'

const keys = generateKeyPairSync('ed25519')
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const spark: InstallTargetNode = { nodeId: 'spark', installPath: 'host-agent', role: 'main', local: true, platform: 'linux', arch: 'arm64', gpuVendor: 'nvidia', version: '2.80.0' }

let clock = Date.parse('2026-10-01T10:00:00Z')
let dataDir: string
let opts: CardStoreOptions
let installDeps: InstallQueueDeps
let host: { execute: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> }
let patches: any[]
const previousNodeOnly = process.env.NOVA_NODE_ONLY

const press = (card: ApprovalCard, answer: string, userId = '111') =>
    answerApprovalCard(`ac:${card.buttons.find(button => button.answer === answer)!.token}`, { userId, ownerIds: ['111'] }, opts)
const sync = () => syncApprovalCardsFromSources({ dataDir, installDeps, patchProposals: () => patches, peers: () => [], nodeId: 'spark' }, opts)

beforeEach(() => {
    clock = Date.parse('2026-10-01T10:00:00Z')
    dataDir = mkdtempSync(join(tmpdir(), 'card-sources-'))
    opts = { dataDir, now: () => clock, ledger: { recordApproval: vi.fn() } }
    host = {
        execute: vi.fn(async (ticket: any) => ({ success: true, nodeId: 'spark', ticketId: ticket.payload.id, catalogId: ticket.payload.catalogId, evidenceHash: 'e'.repeat(64), newPackages: ['ffmpeg'] })),
        rollback: vi.fn(async () => ({ success: true })),
        status: vi.fn(async () => null),
    }
    installDeps = { dataDir: join(dataDir, 'install'), ticketPrivateKey: privateKey, hostNodeId: 'spark', hostClientId: 'xaventra-main', hostClient: host, now: () => clock }
    patches = []
    registerBuiltinCardExecutors({ installDeps: () => installDeps, selfHealDataDir: () => dataDir, patchProposals: () => patches })
    delete process.env.NOVA_NODE_ONLY
})
afterEach(() => {
    if (previousNodeOnly === undefined) delete process.env.NOVA_NODE_ONLY
    else process.env.NOVA_NODE_ONLY = previousNodeOnly
})

describe('Stufe 2: install queue -> card -> existing ticket path', () => {
    it('creates exactly one card per queued proposal', () => {
        const proposal = proposeCatalogInstall('ffmpeg', spark, installDeps, 'scan').proposal!
        expect(proposal.status).toBe('queued')
        expect(sync()).toHaveLength(1)
        expect(sync()).toHaveLength(0)
        const [card] = listApprovalCards(opts)
        expect(card).toMatchObject({ art: 'install', aktion: { kind: 'install', ref: proposal.id }, status: 'offen' })
        expect(card.beleg).toContain('ffmpeg')
    })

    it('"Ja" issues exactly one signed ticket via approveQueuedInstall; a replay issues none', async () => {
        const proposal = proposeCatalogInstall('ffmpeg', spark, installDeps, 'scan').proposal!
        sync()
        const [card] = listApprovalCards(opts)
        const result = await press(card, 'ja')
        expect(result.ok).toBe(true)
        expect(host.execute).toHaveBeenCalledOnce()
        const ticket = host.execute.mock.calls[0][0]
        expect(ticket.payload).toMatchObject({ catalogId: 'ffmpeg', approvedBy: 'owner:telegram:111' })
        expect(loadInstallQueue(installDeps).find(item => item.id === proposal.id)).toMatchObject({ status: 'done', ticketId: ticket.payload.id })
        expect((await press(card, 'ja')).code).toBe('verbraucht')
        expect(host.execute).toHaveBeenCalledOnce()
        for (const fn of Object.values(childProcess)) expect(fn).not.toHaveBeenCalled()
    })

    it('a non-owner press issues no ticket', async () => {
        proposeCatalogInstall('ffmpeg', spark, installDeps, 'scan')
        sync()
        const [card] = listApprovalCards(opts)
        expect((await press(card, 'ja', '222')).code).toBe('kein-owner')
        expect(host.execute).not.toHaveBeenCalled()
    })

    it('a worker image suggestion gets no card (nothing to approve here)', () => {
        proposeCatalogInstall('ffmpeg', { ...spark, nodeId: 'ns1', installPath: 'image', role: 'worker', local: false }, installDeps, 'scan')
        expect(sync()).toHaveLength(0)
    })
})

describe('Stufe 3: self-heal proposals', () => {
    it('turns an open proposal into a card; "Nein" marks it rejected, nothing runs', async () => {
        mkdirSync(join(dataDir, 'self-heal'), { recursive: true })
        writeFileSync(join(dataDir, 'self-heal', 'proposals.json'), JSON.stringify({ version: 1, items: [{
            id: '6f1f3c2e-1111-4222-8333-944455556666', at: new Date(clock - 60_000).toISOString(), node: 'spark', recipe: 'dienst-neustart-vorschlag',
            signature: 'rest-haengt:rest', title: 'Eigener Dienst antwortet nicht', message: 'REST hängt laut Nachtwache.', befund: { http: 'timeout' }, status: 'offen',
        }] }))
        expect(sync()).toHaveLength(1)
        const [card] = listApprovalCards(opts)
        expect(card).toMatchObject({ art: 'self-heal', status: 'offen' })
        expect((await press(card, 'nein')).ok).toBe(true)
        expect(readHealProposals(dataDir)[0].status).toBe('abgelehnt')
        expect(card.buttons.some(button => button.answer === 'immer')).toBe(false)
    })
})

describe('PATCH_GATE proposals', () => {
    it('creates a card; "Ja" goes through the PATCH_GATE token check and never applies without it', async () => {
        patches = [{ id: 'patch_11111111-2222-4333-8444-555555555555', file: 'src/x.ts', description: 'Fix x', status: 'queued', createdAt: clock - 1000 }]
        expect(sync()).toHaveLength(1)
        const [card] = listApprovalCards(opts)
        expect(card.buttons.some(button => button.answer === 'immer')).toBe(false)
        const previous = process.env.NOVA_PATCH_GATE_TOKEN
        delete process.env.NOVA_PATCH_GATE_TOKEN
        try {
            const result = await press(card, 'ja')
            expect(result.card?.result).toMatchObject({ ok: false })
            expect(result.card?.result?.message).toMatch(/NOVA_PATCH_GATE_TOKEN/)
        } finally {
            if (previous !== undefined) process.env.NOVA_PATCH_GATE_TOKEN = previous
        }
    })
})

describe('delivery: only the Main sends Telegram', () => {
    const sender = (): CardSender & { send: ReturnType<typeof vi.fn> } => ({
        canSend: async () => true,
        ownerChatIds: () => ['111'],
        send: vi.fn(async () => 77),
    })

    it('a worker never sends, even with a Telegram sender present', async () => {
        proposeCatalogInstall('ffmpeg', spark, installDeps, 'scan')
        sync()
        process.env.NOVA_NODE_ONLY = 'true'
        const tg = sender()
        expect(await deliverPendingCards(tg, opts)).toBe(0)
        expect(tg.send).not.toHaveBeenCalled()
    })

    it('the Main sends each card once to the owner chat with a code-id keyboard', async () => {
        proposeCatalogInstall('ffmpeg', spark, installDeps, 'scan')
        sync()
        const tg = sender()
        expect(await deliverPendingCards(tg, opts)).toBe(1)
        expect(await deliverPendingCards(tg, opts)).toBe(0)
        expect(tg.send).toHaveBeenCalledOnce()
        const [chatId, text, keyboard] = tg.send.mock.calls[0]
        expect(chatId).toBe('111')
        expect(text).toContain('ffmpeg')
        expect(JSON.stringify(keyboard)).not.toContain('iq-')
        expect(listApprovalCards(opts)[0].messages).toEqual([{ chatId: '111', messageId: 77 }])
    })

    it('a Main without live Telegram authority sends nothing', async () => {
        proposeCatalogInstall('ffmpeg', spark, installDeps, 'scan')
        sync()
        const tg = { ...sender(), canSend: async () => false }
        expect(await deliverPendingCards(tg, opts)).toBe(0)
        expect(tg.send).not.toHaveBeenCalled()
    })
})

it('keeps the card store bounded JSON on disk', () => {
    proposeCatalogInstall('ffmpeg', spark, installDeps, 'scan')
    sync()
    const raw = JSON.parse(readFileSync(join(dataDir, 'approval-cards', 'cards.json'), 'utf8'))
    expect(raw.version).toBe(1)
    expect(Array.isArray(raw.cards)).toBe(true)
})
