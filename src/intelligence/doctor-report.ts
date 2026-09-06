/** Caller-owned observations, not model-created incidents or execution grants. */
import { z } from 'zod'

export const DoctorReportSchema = z.object({
    status: z.enum(['unknown', 'healthy', 'degraded']),
    issues: z.array(z.object({
        code: z.string().trim().min(1).max(200),
        severity: z.enum(['info', 'warning', 'error', 'critical']),
        message: z.string().trim().min(1).max(8000),
    }).strict()).max(40),
}).strict().refine(report => report.status !== 'healthy' || report.issues.length === 0,
    'A healthy report cannot contain issues')

export type DoctorReport = z.infer<typeof DoctorReportSchema>

/** L15 supplies observations, not severity/root-cause evidence. Empty is unknown:
 * absence of a finding does not prove that all health checks were performed. */
export function selfCheckDoctorReport(issues: readonly string[]): DoctorReport {
    return DoctorReportSchema.parse({ status: issues.length ? 'degraded' : 'unknown',
        issues: issues.map(message => ({ code: 'SELF_CHECK_OBSERVATION', severity: 'info', message })) })
}
