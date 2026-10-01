import { describe, expect, it, vi } from 'vitest'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'admin') }))
vi.mock('../users/multi-user-middleware.js', async importOriginal => ({ ...(await importOriginal<object>()), ...perms }))

import { getCommandMinimumRole, handleCommand, type DaemonState } from './slash-commands.js'
import { withExecutionPolicyContext } from './lifecycle-policy.js'
import { ownerApprovalRefusal } from '../tools/owner-approval.js'

// R2: tools behind ownerApprovalRefusal need a way for the owner to approve.
// /freigabe issues the one-time code; the pipeline passes userId=principalId,
// so the tool side must accept exactly this code once, for this tool only.

function state(): DaemonState {
    return {
        running: true, channels: { telegram: null, whatsapp: null, discord: null },
        llm: null, internalLlm: null, memory: null, learning: null, tools: null,
        resilience: null, startTime: Date.now(), config: {}, __userPermission: 'owner',
    }
}
const principal = (permission: string, id: string) => ({ channel: 'telegram', rawUserId: id, principalId: id, permission }) as any
const codeFrom = (reply: string) => /: ([A-Za-z0-9_-]{20,})\n/.exec(reply)?.[1]

describe('/freigabe', () => {
    it('is owner-only', async () => {
        expect(getCommandMinimumRole('freigabe')).toBe('owner')
        for (const permission of ['guest', 'user', 'admin']) {
            const reply = await handleCommand('freigabe', 'execute_python', 'x-1', state(), [], principal(permission, 'x-1'))
            expect(reply).toContain('🔒')
        }
    })

    it('rejects a malformed tool name', async () => {
        expect(await handleCommand('freigabe', '../etc', 'owner-1', state(), [], principal('owner', 'owner-1'))).toMatch(/^Nutzung/)
    })

    it('P9: refuses a tool-wide code — a detail is mandatory', async () => {
        const reply = await handleCommand('freigabe', 'execute_python', 'owner-1', state(), [], principal('owner', 'owner-1'))
        expect(reply).toMatch(/^Nutzung/)
        expect(codeFrom(reply)).toBeUndefined()
    })

    it('issues a code that unlocks exactly this tool and detail once for the owner', async () => {
        const reply = await handleCommand('freigabe', 'printer_start benchy.gcode', 'owner-1', state(), [], principal('owner', 'owner-1'))
        const code = codeFrom(reply)
        expect(code).toBeTruthy()
        const run = (tool: string, detail = 'benchy.gcode') => withExecutionPolicyContext({ userId: 'owner-1', authUserId: 'owner-1', channel: 'telegram' },
            () => ownerApprovalRefusal({ confirm: code }, tool, detail))
        expect(await run('printer_gcode')).toMatch(/Freigabe/)
        expect(await run('printer_start', 'other.gcode')).toMatch(/Freigabe/)
        expect(await run('printer_start')).toBeNull()
        expect(await run('printer_start')).toMatch(/Freigabe/)
    })

    it('P9: accepts the hash detail the refusal names (long code, MCP tool names with dashes)', async () => {
        const reply = await handleCommand('freigabe', 'mcp__home__set-light #0123456789ab', 'owner-1', state(), [], principal('owner', 'owner-1'))
        const code = codeFrom(reply)
        expect(code).toBeTruthy()
        expect(await withExecutionPolicyContext({ userId: 'owner-1', authUserId: 'owner-1', channel: 'telegram' },
            () => ownerApprovalRefusal({ confirm: code }, 'mcp__home__set-light', '#0123456789ab'))).toBeNull()
    })

    it('binds a detail such as name@url into the code', async () => {
        const reply = await handleCommand('freigabe', 'register_llm_provider local@https://llm.example.invalid/v1', 'owner-1', state(), [], principal('owner', 'owner-1'))
        const code = codeFrom(reply)
        const run = (detail: string) => withExecutionPolicyContext({ userId: 'owner-1', authUserId: 'owner-1', channel: 'telegram' },
            () => ownerApprovalRefusal({ confirm: code }, 'register_llm_provider', detail))
        expect(await run('evil@https://attacker.example.invalid/v1')).toMatch(/Freigabe/)
        expect(await run('local@https://llm.example.invalid/v1')).toBeNull()
    })
})
