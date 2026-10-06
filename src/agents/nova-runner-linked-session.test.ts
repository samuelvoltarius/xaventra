import { describe, expect, it } from 'vitest'
import { SessionCheckpoints, sessionIdentity } from './session-checkpoints.js'
import { getSession } from './nova-runner.js'

describe('2.88 linked owner account keeps its own earlier room history', () => {
    it('carries the requester’s own checkpoint over once, never someone else’s', () => {
        const store = new SessionCheckpoints()
        store.save(sessionIdentity('desktop:owner', { conversationId: 'room-288' }), [{ role: 'user', content: 'Raum-Notiz ORBIT', timestamp: 1 }])
        store.save(sessionIdentity('stranger', { conversationId: 'room-288b' }), [{ role: 'user', content: 'fremd', timestamp: 1 }])
        expect(getSession('owner-288', 'desktop', { conversationId: 'room-288' }, 'desktop:owner').history[0]?.content).toContain('ORBIT')
        expect(getSession('owner-288', 'desktop', { conversationId: 'room-288b' }).history).toEqual([])
    })

    it('prefers the canonical history when it already exists', () => {
        const store = new SessionCheckpoints()
        store.save(sessionIdentity('owner-288c', { conversationId: 'room-c' }), [{ role: 'user', content: 'kanonisch', timestamp: 1 }])
        store.save(sessionIdentity('desktop:c', { conversationId: 'room-c' }), [{ role: 'user', content: 'alt', timestamp: 1 }])
        expect(getSession('owner-288c', 'desktop', { conversationId: 'room-c' }, 'desktop:c').history.map(turn => turn.content)).toEqual(['kanonisch'])
    })
})