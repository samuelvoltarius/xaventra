import { afterEach, describe, expect, it, vi } from 'vitest'

// INT-5 regression: applyApprovedDoctorProposal compared the PATCH_GATE token
// with `!==` (timing side channel). It now uses the shared SHA-256 +
// timingSafeEqual comparison.

const crypto = vi.hoisted(() => ({ calls: 0 }))
vi.mock('node:crypto', async importOriginal => {
    const actual = await importOriginal<typeof import('node:crypto')>()
    return {
        ...actual,
        timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
            crypto.calls++
            return actual.timingSafeEqual(a, b)
        },
    }
})

import { applyApprovedDoctorProposal, type DoctorConfigProposal } from './safe-fixes.js'
import { constantTimeTokenEquals } from '../security/token-compare.js'

const TOKEN = 'gate-token-0123456789abcdef'
// Status "applied" stops right after the token gate, so an accepted token is
// observable without touching any live config file.
const proposal = { kind: 'doctor-config', status: 'applied', configPath: 'server.port', configValue: 1 } as unknown as DoctorConfigProposal

afterEach(() => { vi.unstubAllEnvs(); crypto.calls = 0 })

describe('doctor PATCH_GATE token comparison (INT-5)', () => {
    it('accepts the exact token via timingSafeEqual', async () => {
        vi.stubEnv('NOVA_PATCH_GATE_TOKEN', TOKEN)
        const result = await applyApprovedDoctorProposal(proposal, TOKEN)
        expect(result.message).toBe('Doctor proposal is not queued')
        expect(crypto.calls).toBeGreaterThan(0)
    })

    it.each([
        ['same length, different content', TOKEN.slice(0, -1) + 'X'],
        ['prefix', TOKEN.slice(0, 8)],
        ['longer', TOKEN + 'x'],
        ['empty', ''],
        ['non-string', 12345 as unknown as string],
    ])('rejects a %s token', async (_label, token) => {
        vi.stubEnv('NOVA_PATCH_GATE_TOKEN', TOKEN)
        const result = await applyApprovedDoctorProposal(proposal, token)
        expect(result).toEqual({ applied: false, message: 'PATCH_GATE token invalid' })
    })

    it('rejects everything when no token is configured', async () => {
        vi.stubEnv('NOVA_PATCH_GATE_TOKEN', '')
        expect((await applyApprovedDoctorProposal(proposal, '')).message).toBe('PATCH_GATE token invalid')
        expect(constantTimeTokenEquals('', '')).toBe(false)
    })
})
