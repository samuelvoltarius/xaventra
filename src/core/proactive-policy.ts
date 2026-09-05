export interface ProactiveAssessment {
    impact: number
    confidence: number
    dedupeKey: string
    evidence: Array<{ source: string; verifiedAt: string; summary: string; verified: boolean; evidenceId?: string }>
    actionAvailable?: boolean
    affectedSystems?: string[]
    recommendedAction?: string
    evidenceExpiresAt?: string
}

export interface ProactiveDecision {
    allow: boolean
    score: number
    reason: string
    requiresApproval: boolean
}

export function assessmentFromEvent(input: {
    source: string
    summary: string
    severity?: 'info' | 'warning' | 'error' | 'critical'
    verifiedAt?: string
    confidence?: number
    actionAvailable?: boolean
    dedupeKey?: string
    affectedSystems?: string[]
    recommendedAction?: string
    evidenceTtlMs?: number
}): ProactiveAssessment {
    const impact = { info: 0.35, warning: 0.58, error: 0.78, critical: 1 }[input.severity || 'info']
    return {
        impact,
        confidence: Math.max(0, Math.min(1, input.confidence ?? 0.9)),
        dedupeKey: input.dedupeKey || `${input.source}:${input.summary}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').slice(0, 200),
        evidence: [{ source: input.source, verifiedAt: input.verifiedAt || new Date().toISOString(), summary: input.summary, verified: true }],
        actionAvailable: input.actionAvailable,
        affectedSystems: [...new Set(input.affectedSystems || [])].slice(0, 10),
        recommendedAction: input.recommendedAction,
        evidenceExpiresAt: new Date(Date.now() + Math.max(30_000, input.evidenceTtlMs || 15 * 60_000)).toISOString(),
    }
}

export function evaluateProactivity(input: ProactiveAssessment, thresholds = { minimumScore: 0.42, urgentScore: 0.75 }): ProactiveDecision {
    const impact = Math.max(0, Math.min(1, input.impact))
    const confidence = Math.max(0, Math.min(1, input.confidence))
    const explicitExpiry = Date.parse(input.evidenceExpiresAt || '')
    const assessmentAlive = !Number.isFinite(explicitExpiry) || explicitExpiry > Date.now()
    const freshEvidence = assessmentAlive
        ? input.evidence.filter(item => item.verified === true && Date.now() - Date.parse(item.verifiedAt) < 15 * 60_000)
        : []
    const evidenceFactor = Math.min(1, freshEvidence.length / 2)
    const score = impact * 0.5 + confidence * 0.35 + evidenceFactor * 0.15
    if (freshEvidence.length === 0) return { allow: false, score, reason: 'no recent verified evidence', requiresApproval: true }
    if (score < thresholds.minimumScore) return { allow: false, score, reason: `impact/confidence score ${score.toFixed(2)} below threshold`, requiresApproval: true }
    return {
        allow: true, score,
        reason: score >= thresholds.urgentScore ? 'high-impact verified event' : 'verified event above notification threshold',
        requiresApproval: Boolean(input.actionAvailable),
    }
}
