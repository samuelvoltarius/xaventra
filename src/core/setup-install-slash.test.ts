import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stufe 2: /setup approve|rollback|allow are owner-only slash commands; the
// approver identity comes from the server-side principal, never from text.

const queue = vi.hoisted(() => ({
    approveQueuedInstall: vi.fn(async (_id: string, approver: any) => ({ ok: approver.permission === 'owner', message: `approve ${approver.permission}:${approver.principalId}` })),
    rollbackQueuedInstall: vi.fn(async () => ({ ok: true, message: 'rollback' })),
    setApprovalLevel: vi.fn((_id: string, level: string, approver: any) => ({ ok: true, message: `${level} by ${approver.principalId}` })),
    proposeCatalogInstall: vi.fn(() => ({ ok: true, message: 'proposed' })),
    resolveInstallTarget: vi.fn(async () => ({ nodeId: 'spark', installPath: 'host-agent', role: 'main', local: true })),
    defaultInstallDeps: vi.fn(() => ({ dataDir: 'unused' })),
    formatInstallQueue: vi.fn(() => 'queue'),
    formatInstallCatalog: vi.fn(() => 'catalog'),
}))
vi.mock('../install/install-queue.js', () => queue)

import { handleCommand, type DaemonState } from './slash-commands.js'

const state = (): DaemonState => ({
    running: true, channels: { telegram: null, whatsapp: null, discord: null }, llm: null, internalLlm: null,
    memory: null, learning: null, tools: null, resilience: null, startTime: Date.now(), config: {},
})
const as = (permission: 'owner' | 'admin' | 'user' | 'guest', id = `${permission}-1`) => ({ channel: 'telegram', rawUserId: id, principalId: id, permission })

beforeEach(() => { for (const fn of Object.values(queue)) fn.mockClear() })

describe('/setup install commands (Stufe 2)', () => {
    it('denies approve, rollback and allow to every non-owner before reaching the queue', async () => {
        for (const args of ['approve iq-0123456789ab', 'rollback iq-0123456789ab', 'allow ffmpeg', 'install ffmpeg']) {
            for (const identity of [as('admin'), as('user'), as('guest'), undefined]) {
                expect(String(await handleCommand('setup', args, identity?.rawUserId || 'x', state(), [], identity))).toContain('🔒')
            }
        }
        expect(queue.approveQueuedInstall).not.toHaveBeenCalled()
        expect(queue.setApprovalLevel).not.toHaveBeenCalled()
        expect(queue.proposeCatalogInstall).not.toHaveBeenCalled()
    })

    it('passes the server-side owner principal, not message text, as approver', async () => {
        const reply = String(await handleCommand('setup', 'approve iq-0123456789ab owner:mallory', 'owner-1', state(), [], as('owner')))
        expect(reply).toContain('owner:owner-1')
        expect(queue.approveQueuedInstall).toHaveBeenCalledWith('iq-0123456789ab', expect.objectContaining({ permission: 'owner', principalId: 'owner-1' }), expect.anything())
        expect(String(await handleCommand('setup', 'allow ffmpeg', 'owner-1', state(), [], as('owner')))).toContain('erlauben by owner-1')
        expect(String(await handleCommand('setup', 'ask ffmpeg', 'owner-1', state(), [], as('owner')))).toContain('fragen by owner-1')
    })
})
