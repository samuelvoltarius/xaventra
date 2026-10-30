import { describe, expect, it } from 'vitest'
import { sessionIdentity, sessionKey } from '../agents/session-checkpoints.js'
import { confirmOwnerAccountIfTrusted, trustedOwnerSource } from '../users/owner-accounts.js'
import { conversationScope } from './conversation-scope.js'

const key = (principal: string, scope: { conversationId?: string; botId?: string }) => sessionKey(sessionIdentity(principal, scope))
const room = (over: Record<string, unknown> = {}) => ({ roomId: 'room-1', botId: 'nova', ...over })

describe('Ein Weg: ein Verlaufsschlüssel für den Owner', () => {
    it('Telegram, HUD and CLI (no room) use the owner history', () => {
        expect(conversationScope(undefined, { owner: true })).toEqual({})
    })
    it('a room explicitly marked ownerHistory shares that history with Telegram', () => {
        expect(key('owner', conversationScope(room({ ownerHistory: true }), { owner: true }))).toBe(key('owner', conversationScope(undefined, { owner: true })))
    })
    it('Gegenprobe: a room without the mark keeps its own history (test rooms stay isolated)', () => {
        const scope = conversationScope(room(), { owner: true })
        expect(scope).toEqual({ conversationId: 'room-1', botId: 'nova' })
        expect(key('owner', scope)).not.toBe(key('owner', {}))
    })
    it('Gegenprobe: the mark never moves a non-owner into the owner history', () => {
        expect(conversationScope(room({ ownerHistory: true }), { owner: false })).toEqual({ conversationId: 'room-1', botId: 'nova' })
    })
    it('Gegenprobe: another principal never shares the key, even in a marked room', () => {
        const scope = conversationScope(room({ ownerHistory: true }), { owner: true })
        expect(key('gast', scope)).not.toBe(key('owner', scope))
    })
    it('a different bot keeps its own history in a marked room', () => {
        expect(conversationScope(room({ ownerHistory: true, botId: 'recherche' }), { owner: true })).toEqual({ botId: 'recherche' })
    })
})

describe('Ein Weg: Owner-Principal nur über ausdrückliche Verknüpfung (Gegenproben)', () => {
    it.each([
        [{ channel: 'telegram', rawUserId: '999', permission: 'guest' }],
        [{ channel: 'telegram', rawUserId: 'alfred', permission: 'user' }],
        [{ channel: 'desktop', rawUserId: 'desktop:alfred', permission: 'user' }],
        [{ channel: 'even-g2', rawUserId: 'even-g2:guest', permission: 'user' }],
        [{ channel: 'desktop', rawUserId: 'telefon:+430000000', permission: 'owner' }],
        [{ channel: 'even-g2', rawUserId: 'even-g2:alfred', permission: 'owner' }],
    ])('%j is not trusted as owner by name', evidence => {
        expect(trustedOwnerSource(evidence as any)).toBeNull()
    })
    it('a group never links, even with owner rights', () => {
        expect(confirmOwnerAccountIfTrusted({ channel: 'telegram', rawUserId: '1001', permission: 'owner', isGroup: true } as any)).toBeNull()
    })
})
