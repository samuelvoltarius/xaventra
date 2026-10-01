import { issueSetupConfirmation, setupConfirmationPrincipal } from '../core/setup-confirmation.js'
import { toolApprovalTarget } from '../tools/owner-approval.js'

/** Test helper: the one-time code `/freigabe <tool> <detail>` would issue to the owner. */
export function ownerApprovalCode(tool: string, detail: string, ownerId = 'owner-1', channel = 'telegram'): string {
    return issueSetupConfirmation(setupConfirmationPrincipal(channel, ownerId), toolApprovalTarget(tool, detail))
}
