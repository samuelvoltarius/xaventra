import { afterEach, describe, expect, it, vi } from 'vitest'

// Timing-safe PATCH_GATE token comparison (review "Niedrig": token compares
// with ===). The approval token must be compared in constant time.

const crypto = vi.hoisted(() => ({ calls: 0 }))
vi.mock('node:crypto', async importOriginal => {
    const actual = await importOriginal<typeof import('node:crypto')>()
    return {
        ...actual,
        timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => { crypto.calls++; return actual.timingSafeEqual(a, b) },
    }
})

import { approveEvolutionProposal } from './self-evolution.js'

afterEach(() => { vi.unstubAllEnvs(); crypto.calls = 0 })

describe('PATCH_GATE token comparison', () => {
    it('rejects wrong tokens of equal and different length through a constant-time compare', async () => {
        vi.stubEnv('NOVA_PATCH_GATE_TOKEN', 'synthetic-gate-token')
        for (const token of ['synthetic-gate-tokeX', 'short', '', undefined as unknown as string]) {
            expect((await approveEvolutionProposal('missing-id', token)).error).toBe('PATCH_GATE token invalid')
        }
        expect(crypto.calls).toBeGreaterThan(0)
    })

    it('passes the token gate with the right token (then fails on the missing proposal)', async () => {
        vi.stubEnv('NOVA_PATCH_GATE_TOKEN', 'synthetic-gate-token')
        const result = await approveEvolutionProposal('missing-id', 'synthetic-gate-token')
        expect(result.error).not.toBe('PATCH_GATE token invalid')
    })

    it('rejects everything when no gate token is configured', async () => {
        vi.stubEnv('NOVA_PATCH_GATE_TOKEN', '')
        expect((await approveEvolutionProposal('missing-id', '')).error).toBe('PATCH_GATE token invalid')
    })
})
