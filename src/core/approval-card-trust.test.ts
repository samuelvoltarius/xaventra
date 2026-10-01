import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// P9 Gruppe 4 — eine Erlaubnis-Ablage: trust.json (action-policy) is the only
// standing-permission store. Card kinds map to policy kinds, so an owner „Ja“
// on a card feeds the trust ladder; „Immer erlauben“ lands in trust.json; the
// fixed exclusions (physical, external, money, delete, release/patch,
// single-Ja kinds) stay.

import { answerApprovalCard, createApprovalCard, registerCardExecutor, unregisterCardExecutor, type ApprovalCard, type CardStoreOptions } from './approval-cards.js'
import { registerBuiltinCardExecutors, syncApprovalCardsFromSources } from './approval-card-sources.js'
import {
    AKTIONSARTEN, hasStanding, isStandingExcluded, isTrustPromoted, KARTEN_POLICY_ARTEN, policyKindForCard, TRUST_AUTO_PROMOTE_AFTER,
} from './action-policy.js'
import { proposeCatalogInstall, type InstallQueueDeps, type InstallTargetNode } from '../install/install-queue.js'

const keys = generateKeyPairSync('ed25519')
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const spark: InstallTargetNode = { nodeId: 'spark', installPath: 'host-agent', role: 'main', local: true, platform: 'linux', arch: 'arm64', gpuVendor: 'nvidia', version: '2.82.0' }

let clock = Date.parse('2026-10-01T10:00:00Z')
let dataDir: string
let opts: CardStoreOptions
let deps: InstallQueueDeps
let host: { execute: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> }

const press = (card: ApprovalCard, answer: string) =>
    answerApprovalCard(`ac:${card.buttons.find(button => button.answer === answer)!.token}`, { userId: '111', ownerIds: ['111'] }, opts)
const trust = () => JSON.parse(readFileSync(join(dataDir, 'action-policy', 'trust.json'), 'utf8'))
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function installCard(catalogId = 'ffmpeg'): ApprovalCard {
    const proposal = proposeCatalogInstall(catalogId, spark, deps, 'scan').proposal!
    const [card] = syncApprovalCardsFromSources({ dataDir, installDeps: deps, patchProposals: () => [], peers: () => [], nodeId: 'spark' }, opts)
        .filter(item => item.aktion.ref === proposal.id)
    if (!card) throw new Error(`no install card for ${catalogId} (${proposal.status})`)
    return card
}

beforeEach(() => {
    clock += 60 * 60_000
    dataDir = mkdtempSync(join(tmpdir(), 'card-trust-'))
    opts = { dataDir, now: () => clock, ledger: null }
    host = {
        execute: vi.fn(async (ticket: any) => ({ success: true, nodeId: 'spark', ticketId: ticket.payload.id, catalogId: ticket.payload.catalogId, evidenceHash: 'e'.repeat(64), newPackages: ['x'] })),
        rollback: vi.fn(async () => ({ success: true })),
        status: vi.fn(async () => null),
    }
    // Production: the queue and the card store share the data directory (.nova-data).
    deps = { dataDir, ticketPrivateKey: privateKey, hostNodeId: 'spark', hostClientId: 'xaventra-main', hostClient: host, now: () => clock }
    registerBuiltinCardExecutors({ installDeps: () => deps, selfHealDataDir: () => dataDir, patchProposals: () => [] })
})

describe('Kartenart → Policy-Art', () => {
    it('maps the card kinds whose names differ (install, release-promote, patch)', () => {
        expect(policyKindForCard('install')).toBe('install-katalog')
        expect(policyKindForCard('release-promote')).toBe('release-ausrollen')
        expect(policyKindForCard('patch')).toBe('patch-anwenden')
    })
    it('every known card kind is mapped deliberately: to a known policy kind, to itself, or to null (no double count)', () => {
        const cardKinds = ['install', 'release-promote', 'patch', 'self-heal', 'self-heal-peer', 'gedanke', 'verantwortung', 'mission-schritt', 'delegation',
            'skill-sandbox', 'ollama-pull', 'vllm-wechsel', 'pve-start', 'pve-herunterfahren', 'pve-snapshot', 'pve-rollback', 'pve-anlegen', 'pve-anpassen', 'pve-entfernen']
        for (const kind of cardKinds) {
            const mapped = policyKindForCard(kind)
            if (mapped === null) expect(Object.prototype.hasOwnProperty.call(KARTEN_POLICY_ARTEN, kind)).toBe(true)
            else if (kind !== 'ollama-pull') expect(AKTIONSARTEN[mapped], `${kind} -> ${mapped}`).toBeDefined()
        }
        // ollama-pull stays an unknown kind: recorded, never promoted.
        expect(AKTIONSARTEN['ollama-pull']).toBeUndefined()
    })
})

describe('Karten-Ja füttert die Vertrauensleiter', () => {
    it(`${TRUST_AUTO_PROMOTE_AFTER}× Ja on install cards (each installed for real) promotes install-katalog`, async () => {
        for (const id of ['ffmpeg', 'playwright-chromium', 'node-llama-cpp-cuda']) {
            const card = installCard(id)
            expect((await press(card, 'ja')).ok).toBe(true)
            await flush()
        }
        expect(trust().kinds['install-katalog'].confirmedYes).toBe(TRUST_AUTO_PROMOTE_AFTER)
        expect(isTrustPromoted('install-katalog', { dataDir })).toBe(true)
        expect(hasStanding('install-katalog', 'any-entry', { dataDir })).toBe(true)
        // the card kind name never appears in the store
        expect(trust().kinds.install).toBeUndefined()
    })

    it('a failed install on the host does not count (outcome, not the accepted ticket)', async () => {
        host.execute.mockResolvedValueOnce({ success: false, error: 'apt failed' })
        const card = installCard()
        await press(card, 'ja')
        await flush()
        expect(trust().kinds['install-katalog'].confirmedYes ?? 0).toBe(0)
        expect(trust().kinds['install-katalog'].failed).toBe(1)
    })

    it('„Nein“ resets the series', async () => {
        await press(installCard('ffmpeg'), 'ja'); await flush()
        await press(installCard('playwright-chromium'), 'nein')
        expect(trust().kinds['install-katalog'].confirmedYes).toBe(0)
    })
})

describe('„Immer erlauben“ lands in trust.json (one store), never install-policy.json', () => {
    it('stores a standing grant for exactly this catalog entry', async () => {
        const card = installCard('ffmpeg')
        expect(card.buttons.some(button => button.answer === 'immer')).toBe(true)
        const result = await press(card, 'immer')
        expect(result.ok).toBe(true)
        expect(existsSync(join(dataDir, 'install-policy.json'))).toBe(false)
        expect(trust().erlaubt['install-katalog|ffmpeg']).toMatchObject({ kind: 'install-katalog', subject: 'ffmpeg', by: 'telegram:111' })
        expect(hasStanding('install-katalog', 'ffmpeg', { dataDir })).toBe(true)
        expect(hasStanding('install-katalog', 'playwright-chromium', { dataDir })).toBe(false)
    })

    it('release, patch, physical/external, single-Ja and removal kinds never get „Immer erlauben“, even from a permissive executor', () => {
        for (const kind of ['release-promote', 'patch', 'drucken', 'mail-senden', 'vllm-wechsel', 'pve-entfernen']) {
            unregisterCardExecutor(kind)
            registerCardExecutor({ kind, allowAlways: () => true, standingSubject: () => 'x', execute: async () => ({ ok: true, message: 'ok' }) })
            const created = createApprovalCard({ art: kind, titel: kind, beleg: 'b', vorschlag: 'v', aktion: { kind, ref: 'r1' } }, opts)
            unregisterCardExecutor(kind)
            if (!created.ok) continue
            expect(created.card.buttons.some(button => button.answer === 'immer'), kind).toBe(false)
            const policyKind = policyKindForCard(kind)
            if (policyKind) expect(isStandingExcluded(policyKind), kind).toBe(true)
        }
    })

    it('three confirmed Ja on release cards are counted under release-ausrollen but never promote', async () => {
        unregisterCardExecutor('release-promote')
        registerCardExecutor({ kind: 'release-promote', execute: async () => ({ ok: true, message: 'ok' }) })
        for (let i = 0; i < 3; i++) {
            const created = createApprovalCard({ art: 'release', titel: 'r', beleg: 'b', vorschlag: 'v', aktion: { kind: 'release-promote', ref: `r${i}` } }, opts)
            if (!created.ok) throw new Error(created.reason)
            await press(created.card, 'ja')
        }
        unregisterCardExecutor('release-promote')
        expect(trust().kinds['release-ausrollen'].confirmedYes).toBe(3)
        expect(isTrustPromoted('release-ausrollen', { dataDir })).toBe(false)
        expect(trust().erlaubt).toBeUndefined()
    })
})
