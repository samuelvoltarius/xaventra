import { beforeEach, describe, expect, it, vi } from 'vitest'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : id === 'admin-1' ? 'admin' : 'guest') }))
vi.mock('../users/multi-user-middleware.js', () => perms)

import { approvalDetail, approvalDetailOf, ownerApprovalRefusal, toolApprovalTarget } from './owner-approval.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { issueSetupConfirmation, setupConfirmationPrincipal } from '../core/setup-confirmation.js'

beforeEach(() => perms.getUserPermission.mockClear())

const principal = setupConfirmationPrincipal('telegram', 'owner-1')
const owner = (confirm?: unknown) => ({ authorizationUserId: 'owner-1', channel: 'telegram', ...(confirm !== undefined ? { confirm } : {}) })

describe('owner approval gate', () => {
    it('refuses without identity, for non-owners and for the owner without approval', async () => {
        expect(await ownerApprovalRefusal({}, 'printer_start', 'benchy.gcode')).toMatch(/^❌/)
        expect(await ownerApprovalRefusal({ authorizationUserId: 'admin-1', channel: 'telegram' }, 'printer_start', 'benchy.gcode')).toMatch(/nur der Owner/)
        expect(await ownerApprovalRefusal(owner(), 'printer_start', 'benchy.gcode')).toMatch(/freigabe/i)
        expect(await ownerApprovalRefusal(owner(true), 'printer_start', 'benchy.gcode')).toMatch(/freigabe/i)
    })
    it('P9: a server-side approvalGranted flag no longer approves anything (the dead second source is gone)', async () => {
        const result = await withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram', approvalGranted: true } as any,
            () => ownerApprovalRefusal({}, 'printer_start', 'benchy.gcode'))
        expect(result).toMatch(/freigabe/i)
    })
    it('accepts a one-time token bound to owner, tool and detail, exactly once', async () => {
        const wrongTool = issueSetupConfirmation(principal, toolApprovalTarget('printer_gcode', 'benchy.gcode'))
        expect(await ownerApprovalRefusal(owner(wrongTool), 'printer_start', 'benchy.gcode')).toMatch(/freigabe/i)
        const token = issueSetupConfirmation(principal, toolApprovalTarget('printer_start', 'benchy.gcode'))
        expect(await ownerApprovalRefusal(owner(token), 'printer_start', 'benchy.gcode')).toBeNull()
        expect(await ownerApprovalRefusal(owner(token), 'printer_start', 'benchy.gcode')).toMatch(/freigabe/i)
    })
    it('P9: a code is bound to the detail — a code for one file never approves another file', async () => {
        const token = issueSetupConfirmation(principal, toolApprovalTarget('printer_start', 'benchy.gcode'))
        expect(await ownerApprovalRefusal(owner(token), 'printer_start', 'other.gcode')).toMatch(/freigabe/i)
    })
    it('P9: a tool-wide code without detail (old /freigabe form) never approves a call', async () => {
        const legacy = issueSetupConfirmation(principal, 'tool:printer_start')
        expect(await ownerApprovalRefusal(owner(legacy), 'printer_start', 'benchy.gcode')).toMatch(/freigabe|Einmal-Code/i)
        expect(await ownerApprovalRefusal(owner(legacy), 'printer_start', '')).toMatch(/ohne Detail/)
    })
    it('P9: the refusal names the exact /freigabe command with the bound detail', async () => {
        const code = 'import os\nprint(os.getcwd())'
        const message = await ownerApprovalRefusal(owner(), 'execute_python', approvalDetailOf({ code }))
        expect(message).toContain(`/freigabe execute_python ${approvalDetailOf({ code })}`)
        expect(approvalDetailOf({ code })).toMatch(/^#[a-f0-9]{12}$/)
    })
    it('approvalDetail: short values stay readable, long or multi-line values become a hash, both sides agree', () => {
        expect(approvalDetail('  light.kitchen  ')).toBe('light.kitchen')
        expect(approvalDetail('G1  X10\tY5')).toBe('G1 X10 Y5')
        expect(approvalDetail('x'.repeat(200))).toMatch(/^#[a-f0-9]{12}$/)
        expect(approvalDetail(approvalDetail('x'.repeat(200)))).toBe(approvalDetail('x'.repeat(200)))
        expect(approvalDetailOf({ b: 1, a: 2 })).toBe(approvalDetailOf({ a: 2, b: 1 }))
        expect(toolApprovalTarget('hass_turn_on', ' light.kitchen ')).toBe('tool:hass_turn_on:light.kitchen')
    })
})
