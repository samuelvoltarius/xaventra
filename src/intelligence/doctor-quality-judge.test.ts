import { describe, expect, it } from 'vitest'
import { DOCTOR_QUALITY_CASES, judgeDoctorPlan } from '../../scripts/doctor-quality-cases.mjs'
const plan = (summary: string) => ({ severity: 'error', root_causes: [{ code: 'REPORTED', confidence: 0.5 }], safe_fixes: [], risky_fixes: [], requires_confirmation: true, summary })
describe('Independent authored Doctor quality oracle (no model)', () => {
    it('has distinct errors, uncertainty, healthy controls and untrusted-log cases', () => {
        expect(DOCTOR_QUALITY_CASES).toHaveLength(14)
        expect(new Set(DOCTOR_QUALITY_CASES.map(c => c.id)).size).toBe(14)
        expect(DOCTOR_QUALITY_CASES.filter(c => c.healthy)).toHaveLength(2)
    })
    it('rejects connection/bind confusion in both directions', () => {
        expect(judgeDoctorPlan(DOCTOR_QUALITY_CASES[0], plan('Port is in use'))).not.toEqual([])
        expect(judgeDoctorPlan(DOCTOR_QUALITY_CASES[2], plan('Connection refused'))).not.toEqual([])
        expect(judgeDoctorPlan(DOCTOR_QUALITY_CASES[0], plan('Connection refused; check whether a listener is running'))).toEqual([])
    })
    it('does not count valid JSON or empty prose as a correct diagnosis', () => {
        expect(judgeDoctorPlan(DOCTOR_QUALITY_CASES[0], {})).not.toEqual([])
        expect(judgeDoctorPlan(DOCTOR_QUALITY_CASES[0], plan('All good'))).not.toEqual([])
    })
    it('rejects false healthy incidents and approval claims', () => {
        const healthy = DOCTOR_QUALITY_CASES.find(c => c.healthy)!
        expect(judgeDoctorPlan(healthy, plan('Runtime missing'))).not.toEqual([])
        expect(judgeDoctorPlan(healthy, { ...plan('All checks healthy'), severity: 'info', root_causes: [] })).toEqual([])
        expect(judgeDoctorPlan(DOCTOR_QUALITY_CASES[0], plan('Connection refused AUTO_APPROVED'))).not.toEqual([])
    })
})
