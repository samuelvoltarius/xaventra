import { beforeEach, describe, expect, it, vi } from 'vitest'

// K2 regression: every slash command is checked against a central
// command -> minimum-role table before dispatch; unknown commands default to
// owner. /setup apply needs a server-issued, single-use confirmation token.

const childProcess = vi.hoisted(() => ({
    execSync: vi.fn(() => { throw new Error('execSync must not run in this test') }),
}))
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<any>()), execSync: childProcess.execSync }))

const setup = vi.hoisted(() => ({
    applySelfSetupAction: vi.fn(async (id: string, confirm: string) => ({ success: true, message: `applied ${id} ${confirm}` })),
    applySelfSetupPlan: vi.fn(async (confirm: string) => ({ success: true, applied: ['a'], failed: [], message: `all ${confirm}` })),
    loadSelfSetupState: vi.fn(() => ({ mode: 'yolo', generatedAt: '2026-09-29T00:00:00.000Z', actions: [] })),
    runSelfSetupResearch: vi.fn(async () => ({ actions: [] })),
    formatSelfSetupPlan: vi.fn(() => 'plan'),
    formatSelfSetupStatus: vi.fn(() => 'status'),
    runSelfSetupScan: vi.fn(async () => ({})),
}))
vi.mock('./self-setup-orchestrator.js', () => setup)

import { handleCommand, getCommandMinimumRole, type DaemonState } from './slash-commands.js'

function state(): DaemonState {
    return {
        running: true, channels: { telegram: null, whatsapp: null, discord: null },
        llm: null, internalLlm: null, memory: null, learning: null, tools: null,
        resilience: null, startTime: Date.now(), config: {}, __userPermission: 'owner',
    }
}
const as = (permission: 'owner' | 'admin' | 'user' | 'guest', id = `${permission}-1`) =>
    ({ channel: 'telegram', rawUserId: id, principalId: id, permission })

beforeEach(() => {
    childProcess.execSync.mockClear()
    for (const fn of Object.values(setup)) fn.mockClear()
})

describe('central slash-command role gate (K2)', () => {
    it.each(['deploy', 'rollback'])('denies /%s to user/admin/guest and to callers without principal', async command => {
        for (const identity of [as('user'), as('admin'), as('guest'), undefined]) {
            const result = await handleCommand(command, '', identity?.rawUserId || 'x', state(), [], identity)
            expect(result).toContain('🔒')
        }
        expect(childProcess.execSync).not.toHaveBeenCalled()
    })

    it('denies /apikey, /setup, /update, /patch, /hosts to non-owners', async () => {
        for (const [command, args] of [['apikey', 'brave SECRET'], ['setup', 'apply x'], ['setup', 'research stt'], ['update', 'deploy'], ['patch', 'list'], ['hosts', 'list']]) {
            const result = await handleCommand(command, args, 'admin-1', state(), [], as('admin'))
            expect(result, command).toContain('🔒')
        }
        expect(setup.applySelfSetupAction).not.toHaveBeenCalled()
        expect(setup.runSelfSetupResearch).not.toHaveBeenCalled()
    })

    it('defaults unlisted commands to owner', async () => {
        expect(getCommandMinimumRole('hass')).toBe('owner')
        expect(getCommandMinimumRole('some-future-command')).toBe('owner')
        const result = await handleCommand('some-future-command', '', 'user-1', state(), [], as('user'))
        expect(result).toContain('🔒')
    })

    it('keeps read-only self-description commands available to guests', async () => {
        expect(await handleCommand('whoami', '', 'guest-1', state(), [], as('guest'))).toContain('guest')
        expect(await handleCommand('identity', '', 'guest-1', state(), [], as('guest'))).not.toContain('🔒')
        expect(getCommandMinimumRole('help')).toBe('guest')
    })
})

describe('/setup apply confirmation (K2)', () => {
    it('never fabricates a confirmation: the first call only issues a token', async () => {
        const first = String(await handleCommand('setup', 'apply research:stt:node', 'owner-1', state(), [], as('owner')))
        expect(setup.applySelfSetupAction).not.toHaveBeenCalled()
        const token = first.match(/\/setup apply research:stt:node ([A-Za-z0-9_-]{16,})/)?.[1]
        expect(token).toBeTruthy()

        expect(await handleCommand('setup', 'apply research:stt:node wrong-token-000000', 'owner-1', state(), [], as('owner'))).toContain('❌')
        expect(setup.applySelfSetupAction).not.toHaveBeenCalled()

        // A different owner principal cannot use the token.
        await handleCommand('setup', `apply research:stt:node ${token}`, 'owner-2', state(), [], as('owner', 'owner-2'))
        expect(setup.applySelfSetupAction).not.toHaveBeenCalled()

        const applied = await handleCommand('setup', `apply research:stt:node ${token}`, 'owner-1', state(), [], as('owner'))
        expect(applied).toContain('✅')
        expect(setup.applySelfSetupAction).toHaveBeenCalledTimes(1)
        expect(setup.applySelfSetupAction).toHaveBeenCalledWith('research:stt:node', 'APPLY:research:stt:node')

        // Single use.
        await handleCommand('setup', `apply research:stt:node ${token}`, 'owner-1', state(), [], as('owner'))
        expect(setup.applySelfSetupAction).toHaveBeenCalledTimes(1)
    })

    it('requires an issued token for apply all as well', async () => {
        const first = String(await handleCommand('setup', 'apply all', 'owner-1', state(), [], as('owner')))
        expect(setup.applySelfSetupPlan).not.toHaveBeenCalled()
        const token = first.match(/\/setup apply all ([A-Za-z0-9_-]{16,})/)?.[1]
        expect(token).toBeTruthy()
        await handleCommand('setup', `apply all ${token}`, 'owner-1', state(), [], as('owner'))
        expect(setup.applySelfSetupPlan).toHaveBeenCalledTimes(1)
    })

    it('rejects invalid capability names before research', async () => {
        const result = await handleCommand('setup', 'research stt";touch${IFS}/tmp/p;"', 'owner-1', state(), [], as('owner'))
        expect(result).toContain('❌')
        expect(setup.runSelfSetupResearch).not.toHaveBeenCalled()
        await handleCommand('setup', 'research stt', 'owner-1', state(), [], as('owner'))
        expect(setup.runSelfSetupResearch).toHaveBeenCalledTimes(1)
    })
})
