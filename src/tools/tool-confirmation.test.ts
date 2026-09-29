import { describe, expect, it } from 'vitest'
import { toolConfirmationTool } from './tool-confirmation.js'

describe('R2 T33: tool_confirm cannot approve on the user\'s behalf', () => {
    it('a request is only a note and approve is refused', async () => {
        const request = await toolConfirmationTool.handler({ toolName: 'printer_print', action: 'request', userId: 'owner-1' }) as any
        expect(request.message).not.toMatch(/\/tool approve/)
        expect(request.message).toMatch(/gibt nichts frei/)
        const approve = await toolConfirmationTool.handler({ toolName: 'printer_print', action: 'approve', userId: 'owner-1', confirmationId: request.confirmationId }) as any
        expect(approve.success).toBe(false)
        expect(approve.approved).toBe(false)
    })
})
