import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionCheckpoints, sessionIdentity, sessionKey } from './session-checkpoints.js'

describe('durable scoped agent sessions', () => {
    it('restores a conversation after constructing a new store', () => {
        const root = mkdtempSync(join(tmpdir(), 'sessions-'))
        const identity = sessionIdentity('user', { conversationId: 'project', botId: 'researcher' })
        new SessionCheckpoints(root).save(identity, [{ role: 'user', content: 'The project code is ORBIT.', timestamp: 1 }])
        expect(new SessionCheckpoints(root).load(identity)[0].content).toContain('ORBIT')
    })

    it('isolates users, rooms and bots, including ambiguous legacy separators', () => {
        const store = new SessionCheckpoints(mkdtempSync(join(tmpdir(), 'scopes-')))
        const identities = [sessionIdentity('a:b'), sessionIdentity('a/b'), sessionIdentity('a_b'),
            sessionIdentity('a', { conversationId: 'b:c' }), sessionIdentity('a', { conversationId: 'b', botId: 'c' })]
        expect(new Set(identities.map(sessionKey)).size).toBe(identities.length)
        identities.forEach((identity, index) => store.save(identity, [{ role: 'user', content: String(index) }]))
        identities.forEach((identity, index) => expect(store.load(identity)[0].content).toBe(String(index)))
        expect(store.load(sessionIdentity('unrelated'))).toEqual([])
    })

    it('retains a reset across restart, bounds history and excludes system messages', () => {
        const root = mkdtempSync(join(tmpdir(), 'session-reset-'))
        const store = new SessionCheckpoints(root)
        const identity = sessionIdentity('user')
        store.save(identity, [...Array.from({ length: 150 }, () => ({ role: 'user' as const, content: 'x'.repeat(7000) })), { role: 'system', content: 'private instructions' }])
        expect(store.load(identity)).toHaveLength(100)
        expect(store.load(identity).every(turn => turn.content.length <= 6000 && turn.role === 'user')).toBe(true)
        store.save(identity, [])
        expect(new SessionCheckpoints(root).load(identity)).toEqual([])
    })

    it('rejects a checkpoint whose embedded scope was replaced', () => {
        const root = mkdtempSync(join(tmpdir(), 'session-scope-'))
        const store = new SessionCheckpoints(root)
        const identity = sessionIdentity('user')
        store.save(identity, [{ role: 'user', content: 'private' }])
        const path = join(root, readdirSync(root)[0])
        const checkpoint = JSON.parse(readFileSync(path, 'utf8'))
        checkpoint.identity.userId = 'other'
        writeFileSync(path, JSON.stringify(checkpoint))
        expect(store.load(identity)).toEqual([])
    })
})
