/** 2.89.8 (U1): the word-list gate no longer asks on everyday sentences; destructive + several targets still asks. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const graph = vi.hoisted(() => ({ nodes: [] as Array<{ id: string; status: string }> }))
vi.mock('../mesh/capability-graph.js', () => ({
    getCapabilityGraph: () => ({ getSnapshot: () => ({ nodes: graph.nodes }) }),
}))

import { evaluateClarification } from './clarification-gate.js'
import { BeliefStore, setBeliefStore } from './belief-store.js'
import { SessionContinuityStore, setSessionContinuityStore } from '../memory/session-summarizer.js'

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'nova-clarify-u1-'))
    setSessionContinuityStore(new SessionContinuityStore(join(root, 'continuity.json')))
    setBeliefStore(new BeliefStore(join(root, 'beliefs.json')))
    graph.nodes = [{ id: 'node-a', status: 'online' }, { id: 'node-b', status: 'online' }]
})

describe('ClarificationGate without word-list questions (2.89.8)', () => {
    it.each([
        'Was ist das?',
        'Wo läufst du?',
        'Mach eine Inventur, was läuft wo',
        'schick mir das',
        'Schick mir das bitte',
        'google nach Wanderwegen bei Salzburg',
        'Wer ist sie?',
        'Zeig mir das Wetter da',
    ])('continues to the model: %s', text => {
        expect(evaluateClarification('user:u1', text)).toMatchObject({ action: 'continue', content: text })
    })

    it('still asks for a target when a destructive action meets several candidates', () => {
        const decision = evaluateClarification('user:u1', 'lösch den Container')
        expect(decision.action).toBe('ask')
        expect(decision.missingFields).toEqual(['target'])
    })

    it('does not ask when the text names the target or only one machine exists', () => {
        expect(evaluateClarification('user:u1', 'lösch den Container auf dem Spark').action).toBe('continue')
        graph.nodes = [{ id: 'node-a', status: 'online' }]
        expect(evaluateClarification('user:u1', 'lösch den Container').action).toBe('continue')
    })

    it('asks before sending to an unresolved third party', () => {
        expect(evaluateClarification('user:u1', 'Sende ihm einen Screenshot').action).toBe('ask')
    })
})
