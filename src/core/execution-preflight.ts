import type { ActionIntent } from './action-intent.js'

export type AutonomyProfile = 'observe' | 'safe_auto' | 'approval_required' | 'blocked'

export interface ExecutionPreflightAssessment {
    version: 1
    profile: AutonomyProfile
    riskScore: number
    impact: 'none' | 'local' | 'mesh' | 'external' | 'critical'
    reversible: boolean
    reasons: string[]
    prerequisites: string[]
    requiredEvidence: string[]
}

const READ_ONLY = /^(?:read_|find_|list_|get_|search|browser_search|health_status|service_status|mesh_(?:status|nodes|scan)|nova_introspect|quick_scan|code_search|code_outline)/
const IRREVERSIBLE = /^(?:send_|run_command|system_executor|ssh_|deploy|mesh_deploy|service_|delete_|self_evolve)/

export function assessExecutionPreflight(
    content: string,
    intent: ActionIntent,
    allowedTools: readonly string[],
): ExecutionPreflightAssessment {
    if (!intent.requiresTool) {
        return {
            version: 1, profile: 'observe', riskScore: 0, impact: 'none', reversible: true,
            reasons: ['no side effect requested'], prerequisites: [], requiredEvidence: ['response'],
        }
    }

    const text = content.toLowerCase()
    const selected = [...new Set(allowedTools)]
    const allReadOnly = selected.length > 0 && selected.every(tool => READ_ONLY.test(tool))
    const destructive = /\b(?:lösch|loesch|delete|remove|wipe|format|deinstall|drop\s+(?:table|database))\w*/i.test(text)
    const mesh = /\b(?:mesh|node|spark|pi5?|ns1|ns2|failover|rollout|deploy)\b/i.test(text)
    const external = selected.some(tool => IRREVERSIBLE.test(tool)) || /\b(?:telegram|email|mail|api|deploy|ssh|send|sende|schicke)\b/i.test(text)
    const patch = /\b(?:self[_ -]?evolve|patch|quellcode|source code|nova selbst)\b/i.test(text)
    let riskScore = allReadOnly ? 10 : 35
    if (mesh) riskScore += 20
    if (external) riskScore += 20
    if (destructive) riskScore += 30
    if (patch) riskScore += 25
    riskScore = Math.min(100, riskScore)

    const profile: AutonomyProfile = destructive || patch || riskScore >= 60
        ? 'approval_required'
        : allReadOnly ? 'observe' : 'safe_auto'
    const reversible = allReadOnly || (!external && !destructive && selected.some(tool => /^(?:write_file|config_update)$/.test(tool)))
    const prerequisites: string[] = []
    if (mesh) prerequisites.push('fresh main lease and fencing token', 'target capability heartbeat')
    if (external) prerequisites.push('authenticated destination and idempotency key')
    if (patch) prerequisites.push('sandbox test, regression test and PATCH_GATE approval')
    if (destructive) prerequisites.push('verified target and compensation or explicit operator acceptance')

    return {
        version: 1,
        profile,
        riskScore,
        impact: patch || destructive ? 'critical' : mesh ? 'mesh' : external ? 'external' : 'local',
        reversible,
        reasons: [
            allReadOnly ? 'selected tools are read-only' : 'execution can change state',
            ...(external ? ['external side effect detected'] : []),
            ...(destructive ? ['destructive operation detected'] : []),
            ...(patch ? ['self-modification remains PATCH_GATE controlled'] : []),
        ],
        prerequisites,
        requiredEvidence: [
            'verified tool receipt',
            ...(mesh ? ['current fencing authority'] : []),
            ...(destructive || patch ? ['operator approval'] : []),
            ...(patch ? ['sandbox and regression results'] : []),
        ],
    }
}
