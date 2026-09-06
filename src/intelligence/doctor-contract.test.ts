import { describe, expect, it } from 'vitest'
import { parseDoctorDiagnosis } from './doctor-contract.js'
const plan = { severity: 'error', root_causes: [{ code: 'SERVICE_DOWN', confidence: 0.9 }],
    safe_fixes: [{ type: 'info', message: 'Check the service status.' }],
    risky_fixes: [{ type: 'command_suggestion', command: 'service example restart', reason: 'Service stopped' }],
    requires_confirmation: true, summary: 'The service is unreachable.' }
describe('Doctor trained/runtime diagnosis contract', () => {
    it('maps the trained fix-plan schema into the existing diagnosis API', () => {
        const result = parseDoctorDiagnosis(JSON.stringify(plan))
        expect(result.diagnosis).toBe(plan.summary)
        expect(result.fix).toContain('Check the service status.')
        expect(result.fix).toContain('REQUIRES REVIEW')
        expect(result.autoApply).toBe(false)
        expect(result.fromModel).toBe(true)
    })
    it('keeps complete legacy diagnosis support without granting model approval', () => {
        expect(parseDoctorDiagnosis(JSON.stringify({ diagnosis: 'Service down', fix: 'Review a restart', confidence: 'high', autoApply: true })).autoApply).toBe(false)
    })
    it.each([{}, { ...plan, requires_confirmation: false }, { ...plan, root_causes: [{ code: 'bad', confidence: 9 }] },
        { diagnosis: 'Incomplete' }, { ...plan, safe_fixes: [{}] }])('rejects malformed or unapproved results', value => {
        expect(() => parseDoctorDiagnosis(JSON.stringify(value))).toThrow()
    })
    it('does not extract JSON from leaked reasoning or surrounding text', () => {
        expect(() => parseDoctorDiagnosis(`Thinking... ${JSON.stringify(plan)}`)).toThrow()
    })
    it('rejects invented configuration keys and wizard steps without typed evidence', () => {
        const raw = JSON.stringify({ ...plan, safe_fixes: [{ type: 'config_patch', path: 'server.port', value: 12346, reason: 'Change the port' }] })
        expect(() => parseDoctorDiagnosis(raw)).toThrow('Uncorroborated')
        expect(parseDoctorDiagnosis(raw, { configurationPaths: ['server.port'] }).autoApply).toBe(false)
        expect(() => parseDoctorDiagnosis(JSON.stringify({ ...plan, safe_fixes: [{ type: 'wizard_step', step: 'invented', reason: 'Switch provider' }] }))).toThrow('Uncorroborated')
    })
    it('rejects the reproduced connection-refused versus port-in-use confusion', () => {
        const raw = JSON.stringify({ ...plan, summary: 'Port 12345 is in use. Stop the process.' })
        expect(() => parseDoctorDiagnosis(raw, { reportedError: 'ECONNREFUSED' })).toThrow('contradicts')
        expect(parseDoctorDiagnosis(raw, { reportedError: 'EADDRINUSE' }).autoApply).toBe(false)
    })
    it.each(['safe_fixes', 'risky_fixes'])('rejects credential requests from generic diagnosis (%s)', category => {
        const raw = JSON.stringify({ ...plan, [category]: [{ type: 'ask_secret', key: 'FIXTURE_API_KEY', message: 'Copy a key from an invented service' }] })
        expect(() => parseDoctorDiagnosis(raw, { reportedError: 'EACCES permission denied' })).toThrow('credential')
    })
})
