import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// 2.92.0 Selbstreparatur Stufe 1 (PLAN_SELBSTREPARATUR): one real error line = exactly one
// Doctor finding, keyed by its signature, with a count and the (redacted) line as evidence.
// Live trigger: 29.10. 17:11:10 "ReplyDeliveryError: Reply delivery failed (Ursache: FatalError:
// EFATAL: fetch failed)" — the lost reply never became a finding; uncaught exceptions only
// reached the console; a tool failure created a new case per run.

const doctorFile = () => join(mkdtempSync(join(tmpdir(), 'xaventra-signature-')), 'research.json')

describe('one real error line = exactly one finding', () => {
    it('counts the same line with other numbers/ids under one signature, a different line gets its own', async () => {
        const { recordErrorFinding, flushErrorFindings, listErrorSignatures } = await import('./self-doctor.js')
        const t0 = new Date('2026-10-29T17:11:10Z')
        const line = (port: number, id: string) => `ReplyDeliveryError: Reply delivery failed (Ursache: FatalError: EFATAL: fetch failed ${id} :${port})`
        recordErrorFinding({ source: 'reply-delivery', key: line(443, 'a1b2c3d4e5f6'), line: line(443, 'a1b2c3d4e5f6'), title: 'Antwort nicht zugestellt' }, { now: t0, ingest: false })
        recordErrorFinding({ source: 'reply-delivery', key: line(8443, 'ffffeeee0000'), line: line(8443, 'ffffeeee0000'), title: 'Antwort nicht zugestellt' }, { now: new Date(t0.getTime() + 5_000), ingest: false })
        recordErrorFinding({ source: 'reply-delivery', key: line(1, 'abcdefabcdef'), line: line(1, 'abcdefabcdef'), title: 'Antwort nicht zugestellt' }, { now: new Date(t0.getTime() + 9_000), ingest: false })
        recordErrorFinding({ source: 'uncaught-exception', key: 'TypeError|Cannot read properties of undefined|at x', line: 'TypeError: Cannot read properties of undefined (reading handled)', title: 'Ungefangene Ausnahme' }, { now: t0, ingest: false })
        flushErrorFindings(new Date(t0.getTime() + 10_000))

        const signatures = listErrorSignatures()
        expect(signatures).toHaveLength(2)
        const delivery = signatures.find(item => item.source === 'reply-delivery')!
        expect(delivery.count).toBe(3)
        expect(delivery.signature).toMatch(/^[0-9a-f]{12}$/)
        expect(delivery.lastSeen).toBe(new Date(t0.getTime() + 9_000).toISOString())
        expect(delivery.firstSeen).toBe(t0.toISOString())
        expect(delivery.logLine).toContain('EFATAL: fetch failed')
        expect(signatures.find(item => item.source === 'uncaught-exception')!.count).toBe(1)
    })

    it('stores the line redacted and bounded', async () => {
        const { recordErrorFinding, listErrorSignatures } = await import('./self-doctor.js')
        const secret = ['bot123456789', 'AAHfakeFAKEfake_test-value-1234567'].join(':')
        const text = `EFATAL: fetch failed https://api.telegram.org/${secret}/sendMessage ${'x'.repeat(2000)}`
        recordErrorFinding({ source: 'reply-delivery', key: 'secret-line', line: text, title: 'Antwort nicht zugestellt' }, { ingest: false })
        const entry = listErrorSignatures().find(item => item.logLine.includes('api.telegram.org'))!
        expect(entry.logLine).not.toContain('AAHfakeFAKEfake_test-value-1234567')
        expect(entry.logLine.length).toBeLessThanOrEqual(300)
    })

    it('/doctor shows signature · count · last seen', async () => {
        const { recordErrorFinding, flushErrorFindings, formatErrorSignatures } = await import('./self-doctor.js')
        const now = new Date('2026-10-29T16:11:10Z')
        for (let i = 0; i < 4; i++) recordErrorFinding({ source: 'tool-failure', key: 'hass_list|unknown|boom', line: 'hass_list: boom', title: 'Werkzeugfehler hass_list' }, { now, ingest: false })
        flushErrorFindings(now)
        const text = formatErrorSignatures({ timeZone: 'Europe/Vienna' })
        expect(text).toMatch(/Fehler-Signaturen/)
        expect(text).toMatch(/Werkzeugfehler hass_list — [0-9a-f]{12} · 4× · zuletzt 29\.10\. 17:11/)
    })

    it('/doctor and the hourly Doctor run write deferred counts and show the section', async () => {
        const { readFileSync } = await import('node:fs')
        const slash = readFileSync(new URL('./slash-commands.ts', import.meta.url), 'utf8')
        const doctorCase = slash.slice(slash.indexOf("case 'doctor': {"), slash.indexOf("case 'doctor': {") + 4000)
        expect(doctorCase).toContain('flushErrorFindings()')
        expect(doctorCase).toContain('formatReportCompact(report) + (signatures ?')
        const doctor = readFileSync(new URL('./self-doctor.ts', import.meta.url), 'utf8')
        expect(doctor.slice(doctor.indexOf('export async function runSelfDoctor'))).toMatch(/^export async function runSelfDoctor\(\): Promise<DoctorRunResult> \{\s+flushErrorFindings\(\)/)
    })
})

describe('the three error paths feed the one finding store', () => {
    it('an uncaught exception becomes a finding (reachability errors stay out, B4)', async () => {
        const { handleUncaughtError, resetSelfRepairGate } = await import('../layers/L0-self-repair.js')
        const { listErrorSignatures } = await import('./self-doctor.js')
        resetSelfRepairGate()
        const before = listErrorSignatures().filter(item => item.source === 'uncaught-exception').length
        handleUncaughtError(new TypeError('Cannot read properties of undefined (reading \'zzz-signature\')'))
        handleUncaughtError(new Error('connect ECONNREFUSED 10.0.0.1:8123'))
        await vi.waitFor(() => expect(listErrorSignatures().filter(item => item.source === 'uncaught-exception').length).toBe(before + 1))
        expect(listErrorSignatures().some(item => item.logLine.includes('zzz-signature'))).toBe(true)
        expect(listErrorSignatures().some(item => item.logLine.includes('ECONNREFUSED'))).toBe(false)
    })

    it('a failed reply delivery becomes a finding with its transport cause', async () => {
        const { protectReplyDelivery } = await import('./reply-delivery-error.js')
        const { listErrorSignatures } = await import('./self-doctor.js')
        class FatalError extends Error { code = 'EFATAL'; constructor() { super('EFATAL: fetch failed'); this.name = 'FatalError' } }
        await expect(protectReplyDelivery(vi.fn().mockRejectedValue(new FatalError()))('Inventur')).rejects.toMatchObject({ name: 'ReplyDeliveryError' })
        await vi.waitFor(() => expect(listErrorSignatures().some(item => item.source === 'reply-delivery'
            && item.logLine.includes('ReplyDeliveryError: Reply delivery failed (Ursache: FatalError: EFATAL: fetch failed)'))).toBe(true))
    })

    it('the same tool failure in two runs is one Doctor case and one finding counted twice', async () => {
        const { escalateVerifiedToolFailures, ToolFailureEscalationStore } = await import('./tool-failure-escalation.js')
        const { SessionContinuityStore } = await import('../memory/session-summarizer.js')
        const { FailureResearchCoordinator } = await import('../doctor/failure-research-coordinator.js')
        const { flushErrorFindings, listErrorSignatures } = await import('./self-doctor.js')
        const root = mkdtempSync(join(tmpdir(), 'xaventra-tool-signature-'))
        const doctorPath = doctorFile()
        for (const run of ['run-1', 'run-2']) {
            escalateVerifiedToolFailures({
                principalId: `owner-${run}`, runId: run, request: 'Prüfe',
                observations: [{ callId: `call-${run}`, toolName: 'health_status', args: {}, failure: `opaque failure at ${run === 'run-1' ? 17 : 18}:11` }],
            }, {
                store: new ToolFailureEscalationStore(join(root, 'escalations.json')),
                continuity: new SessionContinuityStore(join(root, `continuity-${run}.json`)),
                doctor: new FailureResearchCoordinator(doctorPath),
            })
        }
        flushErrorFindings()
        expect(new FailureResearchCoordinator(doctorPath).list()).toHaveLength(1)
        const tool = listErrorSignatures().filter(item => item.source === 'tool-failure' && item.logLine.includes('opaque failure'))
        expect(tool).toHaveLength(1)
        expect(tool[0].count).toBe(2)
    })
})
