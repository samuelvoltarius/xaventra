import { describe, expect, it } from 'vitest'
import { decideProfilePublish, heartbeatProfileFields, peerWantsProfile, PROFILE_PEER_RESEND_MIN_MS, type ProfilePublishState } from '../core/node-profile.js'
import { peerStateWithHeartbeat } from './mesh-transport-runtime.js'

// Live 01.10.2026: after the 2.80.0 rollout the Main (Spark) held no profile
// for xaventra-ns1/ns2/nas. The workers had sent it at their own start; the
// Main restarted afterwards and would only get it with the 6 h safety copy.
const WORKER = 'xaventra-ns2'
const MAIN = 'xaventra-spark'
const MIN = 60_000

function tick(state: ProfilePublishState, now: number, fingerprint = 'fp-1') {
    return decideProfilePublish(state, fingerprint, now)
}

describe('Knotenprofil reaches a (re)started Main without waiting 6 h (Hotfix 2.80.1, Befund 1)', () => {
    it('resends once when the Main heartbeat shows a new boot id and no profile for this worker', () => {
        // Worker start: profile goes out, then stays quiet.
        let state: ProfilePublishState = { last: null, resendWanted: false, lastForcedAt: null }
        let step = tick(state, 0); expect(step.publish).toBe(true); state = step.next
        step = tick(state, 30_000); expect(step.publish).toBe(false); state = step.next

        // Main (old boot) holds the profile → nothing to do.
        const beforeHeartbeat = { status: 'online', uptimeMs: 1, ...heartbeatProfileFields('boot-A', { [WORKER]: { profile: {} } }) }
        expect(peerWantsProfile(WORKER, undefined, beforeHeartbeat)).toBe(false)
        const mainBefore = peerStateWithHeartbeat(undefined, MAIN, beforeHeartbeat, 'fp', 40_000)

        // Main restarts (new boot id, empty peer state).
        const restartedHeartbeat = { status: 'online', uptimeMs: 1, ...heartbeatProfileFields('boot-B', {}) }
        expect(peerWantsProfile(WORKER, mainBefore.bootId, restartedHeartbeat)).toBe(true)
        const mainAfter = peerStateWithHeartbeat(mainBefore, MAIN, restartedHeartbeat, 'fp', 10 * MIN)
        expect(mainAfter.bootId).toBe('boot-B')

        state = { ...state, resendWanted: true }
        step = tick(state, 10 * MIN + 30_000)
        expect(step.publish).toBe(true)
        state = step.next

        // No permanent sending: the Main has not acknowledged yet, but the
        // next 30 s ticks stay quiet until the bounded retry interval passes.
        for (let at = 11 * MIN; at < 10 * MIN + 30_000 + PROFILE_PEER_RESEND_MIN_MS; at += 30_000) {
            step = tick({ ...state, resendWanted: true }, at)
            expect(step.publish).toBe(false)
            state = step.next
        }
        step = tick({ ...state, resendWanted: true }, 10 * MIN + 30_000 + PROFILE_PEER_RESEND_MIN_MS)
        expect(step.publish).toBe(true)
    })

    it('asks again when a running peer reports it lacks this profile, and not when it has it', () => {
        expect(peerWantsProfile(WORKER, 'boot-A', { bootId: 'boot-A', profilesHeld: ['xaventra-ns1'] })).toBe(true)
        expect(peerWantsProfile(WORKER, 'boot-A', { bootId: 'boot-A', profilesHeld: [WORKER] })).toBe(false)
    })

    it('resends once on a new boot id even if the restarted peer reloaded an old profile from disk', () => {
        expect(peerWantsProfile(WORKER, 'boot-A', { bootId: 'boot-B', profilesHeld: [WORKER] })).toBe(true)
        expect(peerWantsProfile(WORKER, 'boot-B', { bootId: 'boot-B', profilesHeld: [WORKER] })).toBe(false)
    })

    it('stays compatible with older peers whose heartbeat carries neither field', () => {
        expect(peerWantsProfile(WORKER, undefined, { status: 'online', uptimeMs: 5 })).toBe(false)
        expect(peerWantsProfile(WORKER, 'boot-A', { status: 'online', uptimeMs: 5 })).toBe(false)
    })

    it('advertises only peers whose profile it really holds, bounded', () => {
        const held = heartbeatProfileFields('boot-X', {
            a: { profile: { schema: 1 } }, b: {}, c: { profile: undefined },
            ...Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`n${index}`, { profile: {} }])),
        })
        expect(held.bootId).toBe('boot-X')
        expect(held.profilesHeld).toContain('a')
        expect(held.profilesHeld).not.toContain('b')
        expect(held.profilesHeld).not.toContain('c')
        expect(held.profilesHeld.length).toBeLessThanOrEqual(64)
    })

    it('keeps the heartbeat bound to the authenticated source and sanitizes the boot id', () => {
        const state = peerStateWithHeartbeat(undefined, MAIN, { status: 'online', bootId: 'x'.repeat(500), profilesHeld: 'nope' }, 'fp', 1_000)
        expect(state.nodeId).toBe(MAIN)
        expect(state.lastSeen).toBe(1_000)
        expect(String(state.bootId).length).toBeLessThanOrEqual(80)
    })
})
