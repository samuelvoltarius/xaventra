import { beforeEach, describe, expect, it, vi } from 'vitest'

// INT-6 regression: the self_setup_apply tool accepted confirm="APPLY:<id>",
// a string the model can construct itself. It now requires the one-time,
// principal-bound code that the owner's /setup apply slash command issues.

const setup = vi.hoisted(() => ({
    mode: 'confirm' as 'confirm' | 'yolo',
    applySelfSetupAction: vi.fn(async (id: string, confirm: string) => ({ success: true, message: `applied ${id} ${confirm}` })),
    applySelfSetupPlan: vi.fn(async (confirm: string) => ({ success: true, applied: ['a1'], failed: [], message: `all ${confirm}` })),
}))
vi.mock('../core/self-setup-orchestrator.js', () => ({
    applySelfSetupAction: setup.applySelfSetupAction,
    applySelfSetupPlan: setup.applySelfSetupPlan,
    loadSelfSetupState: () => ({
        mode: setup.mode, generatedAt: '2026-09-29T00:00:00.000Z',
        actions: [{ id: 'a1' }, { id: 'gpu1', catalogId: 'node-llama-cpp-cuda', verification: { kind: 'gpu_backend', backend: 'cuda' } }, { id: 'cat1', catalogId: 'ffmpeg' }],
    }),
    runSelfSetupResearch: vi.fn(), formatSelfSetupPlan: vi.fn(() => 'plan'), formatSelfSetupStatus: vi.fn(() => 'status'), runSelfSetupScan: vi.fn(),
}))

import { evolutionTools } from './complete-registry.js'
import { handleCommand, type DaemonState } from '../core/slash-commands.js'

const tool = () => {
    const found = (evolutionTools as any[]).find(t => t.name === 'self_setup_apply')
    if (!found) throw new Error('self_setup_apply not registered')
    return found
}
const state = (): DaemonState => ({
    running: true, channels: { telegram: null, whatsapp: null, discord: null }, llm: null, internalLlm: null,
    memory: null, learning: null, tools: null, resilience: null, startTime: Date.now(), config: {},
})
const owner = { channel: 'Telegram', rawUserId: '111', principalId: 'alfred', permission: 'owner' as const }
// Runner-injected execution context of the same owner (userId = principal id).
const ownerCall = (args: Record<string, unknown>) => tool().handler({ ...args, channel: 'Telegram', userId: 'alfred', authorizationUserId: '111' })

async function issueToken(args: string): Promise<string> {
    const reply = String(await handleCommand('setup', `apply ${args}`, '111', state(), [], owner))
    const token = reply.match(/\/setup apply \S+ (\S+)/)?.[1]
    if (!token) throw new Error(`no token in: ${reply}`)
    return token
}

beforeEach(() => {
    setup.mode = 'confirm'
    setup.applySelfSetupAction.mockClear()
    setup.applySelfSetupPlan.mockClear()
})

describe('self_setup_apply requires the server-issued one-time code (INT-6)', () => {
    it('refuses the model-constructible APPLY:<id> / APPLY_ALL:<ts> strings', async () => {
        expect(await ownerCall({ action_id: 'a1', confirm: 'APPLY:a1' })).toMatchObject({ success: false })
        expect(await ownerCall({ action_id: 'all', confirm: 'APPLY_ALL:2026-09-29T00:00:00.000Z' })).toMatchObject({ success: false })
        expect(await ownerCall({ action_id: 'a1' })).toMatchObject({ success: false })
        expect(setup.applySelfSetupAction).not.toHaveBeenCalled()
        expect(setup.applySelfSetupPlan).not.toHaveBeenCalled()
    })

    it('applies with the code the owner obtained via /setup apply, exactly once', async () => {
        const token = await issueToken('a1')
        expect(await ownerCall({ action_id: 'a1', confirm: token })).toMatchObject({ success: true })
        expect(setup.applySelfSetupAction).toHaveBeenCalledWith('a1', 'APPLY:a1')
        expect(await ownerCall({ action_id: 'a1', confirm: token })).toMatchObject({ success: false })
        expect(setup.applySelfSetupAction).toHaveBeenCalledTimes(1)
    })

    it('binds the code to principal and target', async () => {
        const token = await issueToken('a1')
        const other = await tool().handler({ action_id: 'a1', confirm: token, channel: 'Telegram', userId: 'mallory', authorizationUserId: '222' })
        expect(other).toMatchObject({ success: false })
        expect(await ownerCall({ action_id: 'gpu1', confirm: token })).toMatchObject({ success: false })
        expect(setup.applySelfSetupAction).not.toHaveBeenCalled()
        // Still valid for the right principal + target after the failed attempts.
        expect(await ownerCall({ action_id: 'a1', confirm: token })).toMatchObject({ success: true })
    })

    it('applies the whole plan only with an "all" code', async () => {
        const token = await issueToken('all')
        expect(await ownerCall({ action_id: 'all', confirm: token })).toMatchObject({ success: true })
        expect(setup.applySelfSetupPlan).toHaveBeenCalledWith('APPLY_ALL:2026-09-29T00:00:00.000Z')
    })

    it('P9: YOLO no longer applies a non-catalog action without the code (closed gap)', async () => {
        setup.mode = 'yolo'
        expect(await ownerCall({ action_id: 'a1' })).toMatchObject({ success: false })
        expect(await ownerCall({ action_id: 'gpu1' })).toMatchObject({ success: false })
        expect(await ownerCall({ action_id: 'gpu1', confirm: 'APPLY:gpu1' })).toMatchObject({ success: false })
        expect(setup.applySelfSetupAction).not.toHaveBeenCalled()
        const token = await issueToken('gpu1')
        expect(await ownerCall({ action_id: 'gpu1', confirm: token })).toMatchObject({ success: true })
        expect(setup.applySelfSetupAction).toHaveBeenLastCalledWith('gpu1', 'APPLY:gpu1')
    })

    it('P9: without a code a catalog action only goes to the queue path (orchestrator decides: card or standing permission)', async () => {
        for (const mode of ['yolo', 'confirm']) {
            setup.mode = mode
            setup.applySelfSetupAction.mockClear()
            await ownerCall({ action_id: 'cat1' })
            expect(setup.applySelfSetupAction).toHaveBeenCalledWith('cat1', '')
        }
        await ownerCall({ action_id: 'all' })
        expect(setup.applySelfSetupPlan).toHaveBeenCalledWith('')
    })
})
