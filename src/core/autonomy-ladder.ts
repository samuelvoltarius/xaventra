import type { ExecutionPreflightAssessment } from './execution-preflight.js'
import type { SkillMaturityStatus } from '../learning/personal-skill-compiler.js'

export type AutonomyLevel = 'observe' | 'diagnose' | 'safe-auto' | 'trusted-workflow' | 'approval-required' | 'blocked'
export interface AutonomyDecision { level: AutonomyLevel; mayExecute: boolean; requiresPostValidation: boolean; reasons: string[] }

export function resolveAutonomyLevel(input: {
    preflight: ExecutionPreflightAssessment
    skillStatus?: SkillMaturityStatus
    validatedSamples?: number
    withinBudget?: boolean
}): AutonomyDecision {
    const { preflight } = input
    if (preflight.profile === 'blocked') return { level: 'blocked', mayExecute: false, requiresPostValidation: true, reasons: ['preflight blocked execution'] }
    if (preflight.profile === 'observe') return { level: 'observe', mayExecute: true, requiresPostValidation: false, reasons: ['no side effect'] }
    if (preflight.profile === 'approval_required' || preflight.impact === 'critical') {
        return { level: 'approval-required', mayExecute: false, requiresPostValidation: true, reasons: ['high-impact or irreversible operation'] }
    }
    if (input.skillStatus === 'active' && Number(input.validatedSamples || 0) >= 3 && input.withinBudget !== false && preflight.reversible) {
        return { level: 'trusted-workflow', mayExecute: true, requiresPostValidation: true, reasons: ['active skill with repeated validated outcomes', 'reversible and within budget'] }
    }
    if (preflight.reversible && preflight.riskScore <= 45) {
        return { level: 'safe-auto', mayExecute: true, requiresPostValidation: true, reasons: ['reversible low-risk operation'] }
    }
    return { level: 'diagnose', mayExecute: false, requiresPostValidation: true, reasons: ['automatic diagnosis allowed; mutation requires stronger evidence'] }
}
