import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// P9 Aufräumen: toter Code bleibt weg. Quelltext-Ebene, weil die Daemon-
// Verdrahtung beim Import die ganze Laufzeit startet.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const exists = (rel: string) => existsSync(fileURLToPath(new URL(rel, import.meta.url)))

describe('P9 toter Code', () => {
    it('der alte Sub-Agent-Manager und seine Daemon-Zuhörer sind weg', () => {
        expect(exists('../agents/sub-agent.ts')).toBe(false)
        const daemon = read('../daemon.ts')
        expect(daemon).not.toMatch(/agents\/sub-agent\.js/)
        expect(daemon).not.toMatch(/subAgentManager\.on\(/)
    })

    it('L0 hat keine eigenen Heartbeat-Aufgaben mehr (scheduled-tasks.json, HEARTBEAT.md)', () => {
        const supervisor = read('../layers/L0-supervisor.ts')
        for (const name of ['startHeartbeat', 'stopHeartbeat', 'scheduleTask', 'getDueTasks', 'markTaskComplete', 'loadScheduledTasks', 'saveScheduledTasks']) {
            expect(supervisor, name).not.toMatch(new RegExp(`function ${name}\b`))
        }
        expect(supervisor).not.toMatch(/scheduled-tasks\.json/)
        expect(supervisor).not.toMatch(/HEARTBEAT\.md/)
        const daemon = read('../daemon.ts')
        expect(daemon).not.toMatch(/startHeartbeat\(/)
        expect(daemon).not.toMatch(/getDueTasks\(/)
        // the 5-minute periodic work (health, journal, digest) keeps running
        expect(daemon).toMatch(/runPeriodicHeartbeatWork\(\)/)
    })

    it('legacyApplySafeFixes und seine unerreichbaren Helfer sind weg', () => {
        const fixes = read('../doctor/safe-fixes.ts')
        expect(fixes).not.toMatch(/legacyApplySafeFixes/)
        expect(fixes).not.toMatch(/function applyOneFix/)
        expect(fixes).not.toMatch(/execSync/)
    })
})
