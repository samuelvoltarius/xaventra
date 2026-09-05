/**
 * Nova Doctor — Public API
 *
 * Single entry point for the deterministic diagnostic engine.
 * Import this from slash-commands or anywhere else that needs doctor functionality.
 */

export { collectDiagnostics } from './collect.js'
export { formatReportCompact, formatReportFull, formatReportJson } from './format.js'
export { applySafeFixes, formatFixRunResult, queueDoctorFixProposals, applyApprovedDoctorProposal } from './safe-fixes.js'
export { diagnoseToolContract } from './tool-contract.js'
export { probeGpuRuntime, resetGpuRuntimeProbeCache } from './gpu-runtime.js'
export type {
    DoctorReport,
    DoctorIssue,
    DoctorFix,
    CheckResult,
    ApplyFixResult,
    IssueCode,
    IssueSeverity,
} from './types.js'
export type { GpuRuntimeStatus, GpuRuntimeBackend, GpuBindingPackage } from './gpu-runtime.js'
