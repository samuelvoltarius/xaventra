import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    OwnerAccountRegistry, canonicalOwnerCandidate, confirmOwnerAccountIfTrusted, ownerLinkTurn,
    setOwnerAccountRegistry, trustedOwnerSource,
} from './owner-accounts.js'
import { resolvePrincipalId } from './principal-id.js'

const config = { channels: { telegram: { allowFrom: ['1001'] } } }
const freshRegistry = (now = () => 1_000_000) => new OwnerAccountRegistry(join(mkdtempSync(join(tmpdir(), 'owner-acc-')), 'owner-accounts.json'), now)
const codeIn = (text: string | undefined) => /(\d{6})/.exec(String(text))![1]

afterEach(() => setOwnerAccountRegistry(null))

describe('owner accounts: one person across channels', () => {
    it('confirmed owner accounts on different channels resolve to the same principal', () => {
        setOwnerAccountRegistry(freshRegistry())
        expect(confirmOwnerAccountIfTrusted({ config, channel: 'Telegram', rawUserId: '1001', permission: 'owner', permissionSource: 'configured', isGroup: false })).toBe('1001')
        expect(confirmOwnerAccountIfTrusted({ config, channel: 'desktop', rawUserId: 'desktop:owner', permission: 'owner', permissionSource: 'explicit', isGroup: false })).toBe('1001')
        expect(resolvePrincipalId(config, 'desktop', 'desktop:owner')).toBe('1001')
        expect(resolvePrincipalId(config, 'telegram', '1001')).toBe('1001')
    })

    it('keeps the canonical principal stable even when the config changes later', () => {
        const registry = freshRegistry()
        setOwnerAccountRegistry(registry)
        confirmOwnerAccountIfTrusted({ config, channel: 'telegram', rawUserId: '1001', permission: 'owner', permissionSource: 'configured', isGroup: false })
        const changed = { channels: { telegram: { allowFrom: ['2002'] } } }
        expect(resolvePrincipalId(changed, 'telegram', '1001')).toBe('1001')
        expect(registry.canonical()).toBe('1001')
    })

    it('without Telegram the first trusted account becomes the canonical owner', () => {
        expect(canonicalOwnerCandidate({}, 'desktop', 'desktop:owner')).toBe('desktop:owner')
        expect(canonicalOwnerCandidate({ ownerPrincipal: 'owner-sample' }, 'desktop', 'desktop:owner')).toBe('owner-sample')
        expect(canonicalOwnerCandidate({ ...config, userPrincipals: { 'telegram:1001': 'owner-sample' } }, 'desktop', 'desktop:x')).toBe('owner-sample')
    })

    it('an explicit userPrincipals mapping still wins', () => {
        const registry = freshRegistry()
        setOwnerAccountRegistry(registry)
        registry.confirm('slack', 'U1', 'code', '1001')
        expect(resolvePrincipalId({ userPrincipals: { 'slack:U1': 'other' } }, 'slack', 'U1')).toBe('other')
    })
})

describe('owner accounts: strangers stay separate', () => {
    it('never links a non-owner, a group chat, a phone caller or an explicitly promoted Telegram user', () => {
        const registry = freshRegistry()
        setOwnerAccountRegistry(registry)
        expect(confirmOwnerAccountIfTrusted({ config, channel: 'telegram', rawUserId: '3003', permission: 'user', isGroup: false })).toBeNull()
        expect(confirmOwnerAccountIfTrusted({ config, channel: 'telegram', rawUserId: '1001', permission: 'owner', permissionSource: 'configured', isGroup: true })).toBeNull()
        expect(confirmOwnerAccountIfTrusted({ config, channel: 'desktop', rawUserId: 'telefon:+431234567', permission: 'user', isGroup: false })).toBeNull()
        expect(trustedOwnerSource({ channel: 'telegram', rawUserId: '4004', permission: 'owner', permissionSource: 'explicit' })).toBeNull()
        expect(trustedOwnerSource({ channel: 'desktop', rawUserId: 'telefon:+431234567', permission: 'owner', permissionSource: 'explicit' })).toBeNull()
        expect(resolvePrincipalId(config, 'telegram', '3003')).toBe('3003')
        expect(resolvePrincipalId(config, 'discord', '99')).toBe('99')
        expect(registry.list()).toEqual([])
    })
})

describe('owner accounts: link code for further channels', () => {
    it('the owner gets a code and the new channel joins with it', () => {
        let now = 1_000_000
        const registry = freshRegistry(() => now)
        setOwnerAccountRegistry(registry)
        registry.confirm('telegram', '1001', 'konfiguriert', '1001')
        const issued = ownerLinkTurn({ channel: 'telegram', rawUserId: '1001', isGroup: false, text: 'Ich will Slack mit dir verknüpfen' })
        expect(issued?.kind).toBe('code-ausgegeben')
        const code = codeIn(issued?.reply)
        now += 60_000
        const redeemed = ownerLinkTurn({ channel: 'slack', rawUserId: 'U1', isGroup: false, text: `verknüpfen ${code}` })
        expect(redeemed?.kind).toBe('verbunden')
        expect(resolvePrincipalId({}, 'slack', 'U1')).toBe('1001')
        // single use
        expect(ownerLinkTurn({ channel: 'discord', rawUserId: 'D1', isGroup: false, text: `verknüpfen ${code}` })?.kind).toBe('abgelehnt')
    })

    it('rejects expired codes, guessing and group chats; strangers cannot issue codes', () => {
        let now = 1_000_000
        const registry = freshRegistry(() => now)
        setOwnerAccountRegistry(registry)
        registry.confirm('telegram', '1001', 'konfiguriert', '1001')
        expect(ownerLinkTurn({ channel: 'telegram', rawUserId: '3003', isGroup: false, text: 'Verknüpfe meinen Slack-Kanal mit dir' })).toBeNull()
        const code = codeIn(ownerLinkTurn({ channel: 'telegram', rawUserId: '1001', isGroup: false, text: 'Verknüpfungscode bitte' })?.reply)
        expect(ownerLinkTurn({ channel: 'slack', rawUserId: 'U2', isGroup: true, text: `verknüpfen ${code}` })).toBeNull()
        const wrong = code === '000000' ? '111111' : '000000'
        for (let i = 0; i < 5; i++) expect(ownerLinkTurn({ channel: 'slack', rawUserId: 'U9', isGroup: false, text: `verknüpfen ${wrong}` })?.kind).toBe('abgelehnt')
        // locked after five wrong attempts, even with the right code
        expect(ownerLinkTurn({ channel: 'slack', rawUserId: 'U9', isGroup: false, text: `verknüpfen ${code}` })?.kind).toBe('abgelehnt')
        const second = codeIn(ownerLinkTurn({ channel: 'telegram', rawUserId: '1001', isGroup: false, text: 'Verknüpfungscode bitte' })?.reply)
        now += 11 * 60_000
        expect(ownerLinkTurn({ channel: 'slack', rawUserId: 'U9', isGroup: false, text: `verknüpfen ${second}` })?.kind).toBe('abgelehnt')
        expect(resolvePrincipalId({}, 'slack', 'U9')).toBe('U9')
    })

    it('persists accounts but never the code', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'owner-acc-')), 'owner-accounts.json')
        const registry = new OwnerAccountRegistry(path, () => 1)
        registry.confirm('telegram', '1001', 'konfiguriert', '1001')
        const { code } = registry.issueCode()
        const reloaded = new OwnerAccountRegistry(path, () => 2)
        expect(reloaded.lookup('telegram', '1001')).toBe('1001')
        expect(reloaded.redeemCode(code, 'slack', 'U1')).toBe('falsch')
    })
})