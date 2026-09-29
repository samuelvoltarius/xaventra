import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MeshIdentity, MeshReplayGuard } from './mesh-identity.js'

// MI-8: store-and-forward transports deliver after more than two minutes.
// Such envelopes are valid until their signed expiresAt; replay stays blocked.

const source = new MeshIdentity('spark', mkdtempSync(join(tmpdir(), 'nova-mi8-')))
const principal = { id: 'node:spark', role: 'system' as const }

describe('MI-8 replay window follows expiresAt', () => {
    it('accepts a run.result delivered 30 minutes late within its TTL, once', () => {
        const envelope = source.create({ kind: 'run.result', targetNode: 'main', principal, payload: { requestId: 'r-1', success: true, evidence: [] }, ttlMs: 24 * 60 * 60_000 })
        const guard = new MeshReplayGuard()
        const later = envelope.createdAt + 30 * 60_000
        expect(guard.accept(envelope, later)).toEqual({ accepted: true })
        expect(guard.accept(envelope, later + 1000)).toMatchObject({ accepted: false, reason: 'replay' })
    })

    it('rejects expired envelopes and envelopes dated in the future', () => {
        const guard = new MeshReplayGuard()
        const short = source.create({ kind: 'node.heartbeat', targetNode: 'main', principal, payload: { status: 'online' }, ttlMs: 60_000 })
        expect(guard.accept(short, short.expiresAt + 1)).toMatchObject({ accepted: false, reason: 'expired_or_clock_skew' })
        const future = source.create({ kind: 'node.heartbeat', targetNode: 'main', principal, payload: { status: 'online', n: 2 }, ttlMs: 60 * 60_000 })
        expect(guard.accept(future, future.createdAt - 10 * 60_000)).toMatchObject({ accepted: false, reason: 'expired_or_clock_skew' })
    })
})
