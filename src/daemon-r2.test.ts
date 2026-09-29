import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// daemon.ts starts the whole runtime on import, so its wiring is pinned at
// source level (same approach as core/daemon-message-entry.test.ts). The
// behaviour itself is unit-tested in the modules it wires.

const source = readFileSync(fileURLToPath(new URL('./daemon.ts', import.meta.url)), 'utf8')

function block(start: string, length = 2500): string {
    const index = source.indexOf(start)
    expect(index, start).toBeGreaterThan(-1)
    return source.slice(index, index + length)
}

describe('daemon wiring (R2 core-n-z)', () => {
    it('NZ-10: registers the proactive Telegram channel even if Telegram connects later', () => {
        const proactive = block('// Register channels unconditionally', 1200)
        expect(proactive).toMatch(/proactive\.registerChannel\(\{\s*name: 'telegram'/)
        expect(source).not.toMatch(/if \(state\.channels\.telegram\) \{\s*proactive\.registerChannel/)
        expect(source).not.toMatch(/if \(state\.channels\.telegram\) \{\s*monitor\.setAlertCallback/)
        expect(source).not.toMatch(/if \(state\.channels\.telegram\) \{\s*nodeHealth\.setAlertCallback/)
        expect(source).not.toMatch(/if \(state\.channels\.telegram\) \{\s*insightEngine\.setSendFunction/)
        expect(source).toMatch(/proactive\.processQueue\(\)/)
    })

    it('NZ-11: measured alerts pass health evidence refs', () => {
        expect(block("'service-monitor',", 400)).toMatch(/\[`health:service:\$\{target\.name\}`\]/)
        expect(block("'startup-health',", 300)).toMatch(/\['health:startup'\]/)
    })

    it('NZ-14: the handover check keeps live runs', () => {
        expect(source).toMatch(/failStaleRuns\(undefined, undefined, \{ keepLiveRuns: true \}\)/)
    })

    it('UEB-5: periodic health/journal/digest work has its own tick and ignores the heartbeat pseudo task', () => {
        const periodic = block('const runPeriodicHeartbeatWork = async', 4000)
        expect(periodic).toMatch(/runHealthCheck\(\)/)
        expect(periodic).toMatch(/generateDailySummary\(\)/)
        expect(periodic).toMatch(/buildDailyDigest\(\)/)
        const tick = block('let periodicHeartbeatRunning = false', 1500)
        expect(tick).toMatch(/setInterval\(/)
        expect(tick).toMatch(/runPeriodicHeartbeatWork\(\)/)
        const heartbeat = block('startHeartbeat(async (task) => {', 700)
        expect(heartbeat).toMatch(/task\.id === 'heartbeat-tick' \|\| task\.channel === 'heartbeat'\) return/)
        expect(heartbeat.indexOf("'heartbeat-tick'")).toBeLessThan(heartbeat.indexOf('Task fällig'))
        expect(heartbeat).not.toMatch(/runHealthCheck/)
    })
})
