import { beforeEach, describe, expect, it } from 'vitest'
import { getStateMachine, resetStateMachine } from './state-machine.js'

describe('canonical state-machine operation authority', () => {
    beforeEach(() => resetStateMachine())

    it('stays busy until every overlapping operation completes', () => {
        const state = getStateMachine()
        expect(state.beginOperation('first', 'message:telegram')).toBe(true)
        expect(state.beginOperation('second', 'message:desktop')).toBe(true)
        expect(state.getState()).toBe('thinking')
        expect(state.getActiveOperationCount()).toBe(2)

        expect(state.completeOperation('first')).toBe(true)
        expect(state.getState()).toBe('thinking')
        expect(state.getActiveOperationCount()).toBe(1)

        expect(state.completeOperation('second')).toBe(true)
        expect(state.getState()).toBe('idle')
        expect(state.getActiveOperationCount()).toBe(0)
    })

    it('rejects duplicate admission and duplicate completion', () => {
        const state = getStateMachine()
        expect(state.beginOperation('same')).toBe(true)
        expect(state.beginOperation('same')).toBe(false)
        expect(state.completeOperation('same')).toBe(true)
        expect(state.completeOperation('same')).toBe(false)
    })

    it('prevents legacy callers from declaring idle while work remains', () => {
        const state = getStateMachine()
        state.beginOperation('active')
        expect(state.finish('legacy completion')).toBe(false)
        expect(state.getState()).toBe('thinking')
        state.completeOperation('active')
        expect(state.getState()).toBe('idle')
    })

    it('records a terminal failure only after sibling work completes', () => {
        const state = getStateMachine()
        state.beginOperation('failed')
        state.beginOperation('healthy')
        state.completeOperation('failed', 'first failed')
        expect(state.getState()).toBe('thinking')
        state.completeOperation('healthy')
        expect(state.getState()).toBe('idle')
        expect(state.getHistory().map(item => item.to)).toEqual(['thinking', 'error', 'idle'])
    })

    it('resets in place so all observers retain one authority object', () => {
        const state = getStateMachine()
        state.beginOperation('before-reset')
        resetStateMachine()
        expect(getStateMachine()).toBe(state)
        expect(state.getState()).toBe('idle')
        expect(state.getActiveOperationCount()).toBe(0)
    })
})
