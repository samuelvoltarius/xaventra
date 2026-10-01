import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// P9 Gruppe 4: PATCH_GATE had four ways in with different checks (slash, the
// Telegram patch_ok button with a non-atomic write, the card, the Desktop API).
// Now one chain: owner, single flight, live Main fencing, token, atomic state.

const evo = vi.hoisted(() => ({
    proposals: [] as any[],
    approveEvolutionProposal: vi.fn(),
    applyApprovedDoctorProposal: vi.fn(),
}))
vi.mock('./self-evolution.js', () => ({
    getPatchProposals: () => evo.proposals,
    approveEvolutionProposal: evo.approveEvolutionProposal,
    markPatchProposal: (id: string, patch: Record<string, unknown>, expect?: string) => {
        const item = evo.proposals.find(entry => entry.id === id)
        if (!item || (expect !== undefined && item.status !== expect)) return false
        Object.assign(item, patch)
        return true
    },
}))
vi.mock('../doctor/safe-fixes.js', () => ({ applyApprovedDoctorProposal: evo.applyApprovedDoctorProposal }))

import { approvePatchProposal, rejectPatchProposal, setPatchGateLiveMainCheck } from './patch-gate.js'
import { answerApprovalCard, createApprovalCard, type CardStoreOptions } from '../core/approval-cards.js'
import { registerBuiltinCardExecutors, patchCardInput } from '../core/approval-card-sources.js'

const owner = { permission: 'owner', principalId: 'telegram:111' }
let live = true

beforeEach(() => {
    live = true
    setPatchGateLiveMainCheck(async () => live)
    evo.proposals = [{ id: 'patch_a', status: 'queued', file: 'src/x.ts', description: 'Fix x', createdAt: Date.now() }]
    evo.approveEvolutionProposal.mockReset()
    evo.approveEvolutionProposal.mockImplementation(async (id: string) => {
        await new Promise(resolve => setTimeout(resolve, 20))
        const item = evo.proposals.find(entry => entry.id === id)
        if (item) item.status = 'applied'
        return { success: true, proposalId: id, attemptId: 'repair-1' }
    })
    evo.applyApprovedDoctorProposal.mockReset()
    evo.applyApprovedDoctorProposal.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { applied: true, message: 'ok' } })
})
afterEach(() => setPatchGateLiveMainCheck(null))

describe('PATCH_GATE: one check chain', () => {
    it('owner only', async () => {
        for (const approver of [{ permission: 'admin', principalId: 'a' }, { permission: 'owner', principalId: '' }]) {
            expect((await approvePatchProposal('patch_a', { approver, token: 't' })).code).toBe('kein-owner')
        }
        expect(evo.approveEvolutionProposal).not.toHaveBeenCalled()
    })
    it('live Main fencing is required on every path', async () => {
        live = false
        expect((await approvePatchProposal('patch_a', { approver: owner, token: 't' })).code).toBe('kein-main')
        expect(evo.approveEvolutionProposal).not.toHaveBeenCalled()
    })
    it('a double press applies exactly once (single flight, then not queued any more)', async () => {
        const [first, second] = await Promise.all([
            approvePatchProposal('patch_a', { approver: owner, token: 't' }),
            approvePatchProposal('patch_a', { approver: owner, token: 't' }),
        ])
        expect([first.code, second.code].sort()).toEqual(['laeuft', 'ok'])
        expect(evo.approveEvolutionProposal).toHaveBeenCalledTimes(1)
        expect((await approvePatchProposal('patch_a', { approver: owner, token: 't' })).code).toBe('nicht-offen')
        expect(evo.approveEvolutionProposal).toHaveBeenCalledTimes(1)
    })
    it('a config patch is claimed atomically on disk before it is applied (no second apply)', async () => {
        evo.proposals = [{ id: 'patch_cfg', kind: 'doctor-config', status: 'queued' }]
        const [a, b] = await Promise.all([
            approvePatchProposal('patch_cfg', { approver: owner, token: 't' }),
            approvePatchProposal('patch_cfg', { approver: owner, token: 't' }),
        ])
        expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
        expect(evo.applyApprovedDoctorProposal).toHaveBeenCalledTimes(1)
        expect(evo.proposals[0].status).toBe('applied')
    })
    it('a failed config patch goes back to queued (the claim is released)', async () => {
        evo.proposals = [{ id: 'patch_cfg', kind: 'doctor-config', status: 'queued' }]
        evo.applyApprovedDoctorProposal.mockResolvedValueOnce({ applied: false, message: 'PATCH_GATE token invalid' })
        expect((await approvePatchProposal('patch_cfg', { approver: owner, token: 'wrong' })).ok).toBe(false)
        expect(evo.proposals[0].status).toBe('queued')
    })
    it('reject: owner only and only from queued', async () => {
        expect((await rejectPatchProposal('patch_a', { permission: 'user', principalId: 'u' })).ok).toBe(false)
        expect((await rejectPatchProposal('patch_a', owner)).ok).toBe(true)
        expect(evo.proposals[0].status).toBe('rejected')
        expect((await rejectPatchProposal('patch_a', owner)).ok).toBe(false)
    })
})

describe('the patch Knopf-Karte runs the same chain', () => {
    let opts: CardStoreOptions
    beforeEach(() => {
        opts = { dataDir: mkdtempSync(join(tmpdir(), 'patch-card-')), ledger: null }
        registerBuiltinCardExecutors({ installDeps: () => ({ dataDir: opts.dataDir! }), selfHealDataDir: () => opts.dataDir!, patchProposals: () => evo.proposals })
        process.env.NOVA_PATCH_GATE_TOKEN = 'fixture-gate'
    })
    afterEach(() => { delete process.env.NOVA_PATCH_GATE_TOKEN })

    it('„Ja“ goes through the gate; a second press of the same card applies nothing', async () => {
        const created = createApprovalCard(patchCardInput(evo.proposals[0]), opts)
        if (!created.ok) throw new Error(created.reason)
        const token = created.card.buttons.find(button => button.answer === 'ja')!.token
        const presser = { userId: '111', ownerIds: ['111'] }
        const [first, second] = await Promise.all([answerApprovalCard(`ac:${token}`, presser, opts), answerApprovalCard(`ac:${token}`, presser, opts)])
        expect([first.code, second.code].sort()).toEqual(['ok', 'verbraucht'])
        expect(evo.approveEvolutionProposal).toHaveBeenCalledTimes(1)
        expect(evo.approveEvolutionProposal).toHaveBeenCalledWith('patch_a', 'fixture-gate')
    })
    it('without live Main fencing the card press applies nothing', async () => {
        live = false
        const created = createApprovalCard(patchCardInput(evo.proposals[0]), opts)
        if (!created.ok) throw new Error(created.reason)
        const result = await answerApprovalCard(`ac:${created.card.buttons.find(button => button.answer === 'ja')!.token}`, { userId: '111', ownerIds: ['111'] }, opts)
        expect(result.card?.result?.message).toMatch(/Fencing/)
        expect(evo.approveEvolutionProposal).not.toHaveBeenCalled()
    })
})
