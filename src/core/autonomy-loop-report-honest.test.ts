import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./validator-failure-escalation.js', () => ({ reconcileValidatorFailures: () => 0 }))
vi.mock('./autonomy-authority.js', () => ({ hasGlobalAutonomyAuthority: () => true }))
vi.mock('../doctor/failure-research-coordinator.js', () => ({ getFailureResearchCoordinator: () => ({ investigateNext: async () => null }) }))
vi.mock('./message-pipeline.js', () => ({ getIdleMinutes: () => 0, getMinutesSinceLastSelfThink: () => 0, trackSelfThink: () => { } }))
vi.mock('./autonomous-executor.js', () => ({ getActiveMission: () => null, getMissionQueue: () => [] }))
vi.mock('../intelligence/autonomy-engine.js', () => ({
    getSelfGoalEngine: () => ({ getNextGoal: () => null, completeGoal: () => { }, failGoal: () => { } }),
}))
// A notifiable finding of the loop (2.82.0: the Nachtwache no longer runs in the loop; the self-heal phase does).
vi.mock('../doctor/self-heal-runtime.js', () => ({
    triggerSelfHeal: async () => ({ ran: true, note: 'gelaufen', checks: [{ source: 'selbstheilung', severity: 'warning', message: 'Platte fast voll: 95 %', timestamp: 1, requiresNotification: true }] }),
}))
import { setAutonomyNotifier, triggerAutonomyCheck, updateAutonomyConfig } from './autonomy-loop.js'
import { setThinkingConfig } from '../thinking/thinking-runtime.js'
import { setSoftwareScoutConfig } from '../install/software-scout.js'

// 2.82.0 (DOPPELUNGEN Gruppe 7): the "Nova Autonomy Report" went out under the
// untrusted source autonomy-loop and was always dropped by the governed path,
// yet the loop logged "Notification sent". Decision: the report is not a
// Telegram path (its findings reach the owner through L0/L21/planner already);
// the daemon no longer pretends to send it and the loop says so.

setThinkingConfig({ enabled: false })
setSoftwareScoutConfig({ enabled: false })
const allOff = { health: false, reminders: false, inbound: false, logs: false, uptime: false }
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'autonomy-report-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); setAutonomyNotifier(null) })

describe('autonomy report: honest about not being sent', () => {
    it('a notifier that declines (false) leaves notificationSent false and is asked once per finding set', async () => {
        const notify = vi.fn(async () => false)
        setAutonomyNotifier(notify)
        updateAutonomyConfig({ enabled: true, quietHoursStart: -1, checks: { ...allOff, nightwatch: false } })
        const first = await triggerAutonomyCheck()
        const second = await triggerAutonomyCheck()
        expect(first.checks.some(check => check.requiresNotification)).toBe(true)
        expect(first.notificationSent).toBe(false)
        expect(second.notificationSent).toBe(false)
        expect(notify).toHaveBeenCalledTimes(1)
    })

    it('daemon: the loop notifier no longer goes through the governed path; no false "Telegram aktiv" lines', () => {
        const source = readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')
        const loop = source.slice(source.indexOf('const notifyFn = async'), source.indexOf('const notifyFn = async') + 200)
        expect(loop).toMatch(/Promise<boolean> => false/)
        expect(source).toMatch(/startAutonomyLoop\(notifyFn,/)
        expect(source).not.toMatch(/Insight Delivery → Telegram aktiv/)
        expect(source).not.toMatch(/insightEngine\.setSendFunction/)
    })
})
