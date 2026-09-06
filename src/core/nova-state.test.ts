import { describe, expect, it } from 'vitest'
import { getNovaState, initNovaState } from './nova-state.js'

describe('canonical daemon state identity', () => {
    it('keeps late readiness, channel and subsystem writes visible to every consumer', () => {
        const daemonState = initNovaState({ running: false, runtimeReady: false, channels: { telegram: null, whatsapp: null, discord: null } })
        expect(daemonState).toBe(getNovaState())
        expect((globalThis as any).__novaState).toBe(daemonState)
        const channel = { connected: true }
        const memory = { ready: true }
        daemonState.channels.telegram = channel
        daemonState.memory = memory
        daemonState.runtimeReady = true
        daemonState.running = true
        expect(getNovaState().memory).toBe(memory)
        expect(getNovaState().channels.telegram).toBe(channel)
        expect((globalThis as any).__novaState.runtimeReady).toBe(true)
        daemonState.running = false
        daemonState.runtimeReady = false
        expect(getNovaState().running).toBe(false)
        expect((globalThis as any).__novaState.runtimeReady).toBe(false)
    })
})
