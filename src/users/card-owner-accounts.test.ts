/**
 * 2.89 Paket B, Punkt 4 — Karten auch ohne Telegram-Owner beantwortbar.
 * The owner of a card is every CONFIRMED owner account (owner-accounts.ts), not only
 * a numeric Telegram id. Live way: real owner-account registry (trusted App
 * confirmation), real card store and executor, the desktop answer path.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApprovalCard, isCardOwner, listApprovalCards, registerCardExecutor } from '../core/approval-cards.js'
import { answerCardFromDesktop } from '../desktop/desktop-views.js'
import { accountKey, cardOwnerIdentities, confirmOwnerAccountIfTrusted, OwnerAccountRegistry, setOwnerAccountRegistry } from './owner-accounts.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-owner-')); dirs.push(dir); return dir }
afterEach(() => { setOwnerAccountRegistry(null); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('2.89 B4: Karten-Owner aus den bestätigten Owner-Konten', () => {
    it('isCardOwner: numeric Telegram ids and confirmed account keys; never usernames or a Telegram name', () => {
        expect(isCardOwner('1001', ['1001'])).toBe(true)
        expect(isCardOwner('desktop:desktop:owner', ['desktop:desktop:owner'])).toBe(true)
        expect(isCardOwner('alice', ['alice'])).toBe(false)
        expect(isCardOwner('@alice', ['@alice'])).toBe(false)
        expect(isCardOwner('telegram:alice', ['telegram:alice'])).toBe(false)
        expect(isCardOwner('desktop:desktop:fremd', ['desktop:desktop:owner'])).toBe(false)
    })

    it('cardOwnerIdentities: allowFrom + confirmed accounts; a Telegram account counts only numerically', () => {
        const dir = tmp()
        const registry = new OwnerAccountRegistry(join(dir, 'owner-accounts.json'))
        registry.confirm('desktop', 'desktop:owner', 'vertrauter-zugang', 'owner')
        registry.confirm('telegram', 'alice', 'code', 'owner')
        expect(cardOwnerIdentities({ channels: { telegram: { allowFrom: ['1001', 'bob'] } } }, registry)).toEqual(['1001', 'desktop:desktop:owner'])
        expect(cardOwnerIdentities({}, new OwnerAccountRegistry(join(dir, 'leer.json')))).toEqual([])
    })

    it('without any Telegram owner, the token-checked App owner answers a card through the one card path', async () => {
        const dir = tmp()
        setOwnerAccountRegistry(new OwnerAccountRegistry(join(dir, 'owner-accounts.json')))
        // The App/Desktop with owner token is a trusted owner account (as the desktop route confirms it).
        confirmOwnerAccountIfTrusted({ channel: 'desktop', rawUserId: 'desktop:owner', permission: 'owner', isGroup: false, config: {} })
        const opts = { dataDir: dir, ledger: null }
        let ran = 0
        registerCardExecutor({ kind: 'test-ohne-telegram', isStillOpen: () => true, async execute() { ran++; return { ok: true, message: 'erledigt' } } })
        const created = createApprovalCard({ art: 'test', titel: 'Test?', beleg: 'b', vorschlag: 'v', aktion: { kind: 'test-ohne-telegram', ref: 'r1' } }, opts) as any
        const ownerIds = cardOwnerIdentities({})
        expect(ownerIds).toEqual(['desktop:desktop:owner'])
        const result = await answerCardFromDesktop(created.card.id, 'ja', { ...opts, ownerIds, presserId: accountKey('desktop', 'desktop:owner') })
        expect(result.status).toBe(200)
        expect(ran).toBe(1)
        expect(listApprovalCards(opts).find(card => card.id === created.card.id)?.decidedBy).toBe('desktop:desktop:desktop:owner')
    })

    it('Gegenprobe: no confirmed owner at all → refused, nothing runs', async () => {
        const dir = tmp()
        setOwnerAccountRegistry(new OwnerAccountRegistry(join(dir, 'owner-accounts.json')))
        const opts = { dataDir: dir, ledger: null }
        let ran = 0
        registerCardExecutor({ kind: 'test-ohne-owner', isStillOpen: () => true, async execute() { ran++; return { ok: true, message: '' } } })
        const created = createApprovalCard({ art: 'test', titel: 'Test?', beleg: 'b', vorschlag: 'v', aktion: { kind: 'test-ohne-owner', ref: 'r1' } }, opts) as any
        const result = await answerCardFromDesktop(created.card.id, 'ja', { ...opts, ownerIds: cardOwnerIdentities({}) })
        expect(result.status).toBe(403)
        expect(ran).toBe(0)
    })
})
