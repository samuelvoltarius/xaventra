import { beforeEach, describe, expect, it, vi } from 'vitest'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : id === 'admin-1' ? 'admin' : 'guest') }))
vi.mock('../users/multi-user-middleware.js', () => perms)

import { ownerApprovalRefusal, toolApprovalTarget } from './owner-approval.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { issueSetupConfirmation, setupConfirmationPrincipal } from '../core/setup-confirmation.js'

beforeEach(() => perms.getUserPermission.mockClear())

describe('owner approval gate', () => {
    it('refuses without identity, for non-owners and for the owner without approval', async () => {
        expect(await ownerApprovalRefusal({}, 'printer_start')).toMatch(/^❌/)
        expect(await ownerApprovalRefusal({ authorizationUserId: 'admin-1', channel: 'telegram' }, 'printer_start')).toMatch(/nur der Owner/)
        expect(await ownerApprovalRefusal({ authorizationUserId: 'owner-1', channel: 'telegram' }, 'printer_start')).toMatch(/Freigabe/)
        expect(await ownerApprovalRefusal({ authorizationUserId: 'owner-1', channel: 'telegram', confirm: true }, 'printer_start')).toMatch(/Freigabe/)
    })
    it('accepts the server-side approvalGranted flag only for the owner', async () => {
        const owner = await withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram', approvalGranted: true },
            () => ownerApprovalRefusal({}, 'printer_start'))
        expect(owner).toBeNull()
        const admin = await withExecutionPolicyContext({ authUserId: 'admin-1', channel: 'telegram', approvalGranted: true },
            () => ownerApprovalRefusal({ authorizationUserId: 'owner-1' }, 'printer_start'))
        expect(admin).toMatch(/nur der Owner/)
    })
    it('accepts a one-time token bound to owner and tool, exactly once', async () => {
        const principal = setupConfirmationPrincipal('telegram', 'owner-1')
        const wrong = issueSetupConfirmation(principal, toolApprovalTarget('printer_gcode'))
        expect(await ownerApprovalRefusal({ authorizationUserId: 'owner-1', channel: 'telegram', confirm: wrong }, 'printer_start')).toMatch(/Freigabe/)
        const token = issueSetupConfirmation(principal, toolApprovalTarget('printer_start'))
        const params = { authorizationUserId: 'owner-1', channel: 'telegram', confirm: token }
        expect(await ownerApprovalRefusal(params, 'printer_start')).toBeNull()
        expect(await ownerApprovalRefusal(params, 'printer_start')).toMatch(/Freigabe/)
    })
})
