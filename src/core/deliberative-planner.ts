import type { ExecutionPreflightAssessment } from './execution-preflight.js'

export interface PlanAlternative {
    id: 'direct' | 'sandbox' | 'approval'
    risk: number
    estimatedDurationMs: number
    estimatedCostUsd: number
    evidenceStrength: number
    requiresApproval: boolean
    score: number
    reasons: string[]
}

export interface DeliberationResult { version: 1; selected: PlanAlternative; alternatives: PlanAlternative[]; evaluatedAt: string }

export function deliberateExecution(preflight: ExecutionPreflightAssessment): DeliberationResult {
    const base = preflight.riskScore
    const alternatives: PlanAlternative[] = [
        { id: 'direct', risk: base, estimatedDurationMs: 1_000, estimatedCostUsd: 0, evidenceStrength: 0.65, requiresApproval: false, score: 0, reasons: ['fastest route'] },
        { id: 'sandbox', risk: Math.max(0, base - 25), estimatedDurationMs: 30_000, estimatedCostUsd: 0.001, evidenceStrength: 0.95, requiresApproval: false, score: 0, reasons: ['isolated verification and rollback rehearsal'] },
        { id: 'approval', risk: Math.max(0, base - 15), estimatedDurationMs: 5_000, estimatedCostUsd: 0, evidenceStrength: 1, requiresApproval: true, score: 0, reasons: ['operator confirms high-impact intent'] },
    ]
    for (const alternative of alternatives) {
        alternative.score = alternative.evidenceStrength * 55 - alternative.risk * 0.45 - Math.min(15, alternative.estimatedDurationMs / 10_000) - alternative.estimatedCostUsd
    }
    let selected = alternatives[0]
    if (preflight.profile === 'approval_required' || preflight.impact === 'critical') selected = alternatives[2]
    else if (preflight.reversible && preflight.riskScore <= 30) selected = alternatives[0]
    else if (!preflight.reversible || preflight.riskScore >= 40) selected = alternatives[1]
    else selected = [...alternatives].filter(item => !item.requiresApproval).sort((a, b) => b.score - a.score)[0]
    return { version: 1, selected, alternatives, evaluatedAt: new Date().toISOString() }
}
