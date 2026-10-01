import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// P9 „ein Knopf-Rahmen“: `/patch approve` and the Skill-Forge no longer act on
// their own — they (re)send a Knopf-Karte; only the press runs the action.

const evo = vi.hoisted(() => ({
    approveEvolutionProposal: vi.fn(),
    proposals: [{ id: 'patch_a', status: 'queued', file: 'src/x.ts', description: 'Fix x', createdAt: Date.now() }] as any[],
}))
vi.mock('../synthesis/self-evolution.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    getPatchProposals: () => evo.proposals,
    approveEvolutionProposal: evo.approveEvolutionProposal,
}))
const skills = vi.hoisted(() => ({
    getSkillProposals: vi.fn(() => [{ id: 'sp1', name: 'demo', status: 'proposed', ownerId: 'nova-self' }]),
    updateSkillProposalStatus: vi.fn(() => ({ id: 'sp1', name: 'demo' })),
}))
vi.mock('../tools/skill-builder.js', () => skills)

import { handleCommand, type DaemonState } from './slash-commands.js'
import { answerApprovalCard, createApprovalCard, listApprovalCards } from './approval-cards.js'
import { registerCardExecutor } from './approval-cards.js'

const state = (): DaemonState => ({
    running: true, channels: { telegram: null, whatsapp: null, discord: null }, llm: null, internalLlm: null,
    memory: null, learning: null, tools: null, resilience: null, startTime: Date.now(), config: {},
})
const owner = { channel: 'telegram', rawUserId: '111', principalId: '111', permission: 'owner' as const }

beforeEach(() => { evo.approveEvolutionProposal.mockClear(); skills.updateSkillProposalStatus.mockClear() })

describe('/patch approve sends the card, never applies', () => {
    it('creates one open patch card (twice = the same card) and calls no apply path', async () => {
        process.env.NOVA_PATCH_GATE_TOKEN = 'fixture-gate'
        try {
            const first = String(await handleCommand('patch', 'approve patch_a', '111', state(), [], owner))
            const second = String(await handleCommand('patch', 'approve patch_a', '111', state(), [], owner))
            expect(first).toMatch(/Karte .* geschickt/)
            expect(second).toMatch(/erneut geschickt/)
            const open = listApprovalCards({ status: 'offen' }).filter(card => card.aktion.kind === 'patch' && card.aktion.ref === 'patch_a')
            expect(open).toHaveLength(1)
            expect(evo.approveEvolutionProposal).not.toHaveBeenCalled()
        } finally { delete process.env.NOVA_PATCH_GATE_TOKEN }
    })
    it('is owner-only', async () => {
        const reply = String(await handleCommand('patch', 'approve patch_a', '222', state(), [], { ...owner, rawUserId: '222', principalId: '222', permission: 'admin' as any }))
        expect(reply).toMatch(/owner|🔒/)
        expect(evo.approveEvolutionProposal).not.toHaveBeenCalled()
    })
})

