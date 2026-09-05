import type { TaskContractOverrides } from './task-contract.js'

const INTERNAL_PREFIXES = [
    '[SELF-THINK]',
    '[SELF-GOAL]',
    '[SELF-DOCTOR]',
    '[REMINDER]',
    '[HEARTBEAT]',
    '[MISSION',
]

export function isNovaSystemAuthored(input: {
    from?: string
    canonicalUser?: string
    content?: string
}): boolean {
    const actors = [input.from, input.canonicalUser].map(value => String(value || '').toLowerCase())
    if (actors.some(value => ['nova-autonomy', 'nova-self', 'system'].includes(value))) return true
    const content = String(input.content || '').trimStart()
    return INTERNAL_PREFIXES.some(prefix => content.startsWith(prefix))
}

/** Internal diagnostics may use read-only tools, but their completion contract
 * is a useful response rather than an invented requirement that a tool must
 * have executed. */
export function internalTaskContractOverrides(): TaskContractOverrides {
    return {
        successCriteria: [{
            id: 'internal-response-present',
            kind: 'response_present',
            description: 'The internal diagnostic produced a non-empty result',
            required: true,
        }],
        allowedChanges: {
            readOnly: true,
            externalSideEffects: false,
        },
        approvalPolicy: {
            mode: 'none',
            patchGateRequired: true,
        },
    }
}
