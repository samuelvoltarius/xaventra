import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

/**
 * 2.89.6: a main-capable node without the `nova-main` lease is a standby. It
 * must not reach the owner (Telegram, Dashboard/Desktop API, device switches,
 * scheduler firings) until it owns the lease, and it must stop when it loses it.
 * These tests are source-inspection + injected-dep only: no mesh, no network.
 */
describe('owner effects need the nova-main lease (2.89.6)', () => {
    describe('daemon surfaces follow the existing lease pattern', () => {
        const daemon = source('../daemon.ts')

        it('gates Even G2, Desktop-Direct and the Release watch behind nova-main', () => {
            for (const marker of ['startEvenG2FromDaemon', 'startDesktopDirect', 'startSelfUpdateWatch']) {
                const at = daemon.indexOf(marker)
                expect(at, `${marker} must still be started by the daemon`).toBeGreaterThan(-1)
            }
            // Each start path is preceded by the same lease gate as Telegram.
            expect(daemon).toMatch(/shouldStartExclusiveService\(MAIN_SERVICE\)\)\s+await startEvenG2Main/)
            expect(daemon).toMatch(/shouldStartExclusiveService\(MAIN_SERVICE\)\)\s+await startDesktopDirectMain/)
            expect(daemon).toMatch(/shouldStartExclusiveService\(MAIN_SERVICE\)\)\s+await startReleaseWatchMain/)
            expect(daemon).toMatch(/else watchForServiceLeadership\(MAIN_SERVICE, startEvenG2Main\)/)
            expect(daemon).toMatch(/else watchForServiceLeadership\(MAIN_SERVICE, startDesktopDirectMain\)/)
            expect(daemon).toMatch(/else watchForServiceLeadership\(MAIN_SERVICE, startReleaseWatchMain\)/)
        })

        it('stops all three when the lease is lost and re-arms the watcher', () => {
            expect(daemon).toMatch(/onLeadershipLost\(MAIN_SERVICE, async \(\) => \{[\s\S]*?stopDesktopDirect\(\)[\s\S]*?watchForServiceLeadership\(MAIN_SERVICE, startDesktopDirectMain\)/)
            expect(daemon).toMatch(/onLeadershipLost\(MAIN_SERVICE, async \(\) => \{[\s\S]*?stopReleaseWatch\?\.\(\)[\s\S]*?watchForServiceLeadership\(MAIN_SERVICE, startReleaseWatchMain\)/)
            expect(daemon).toMatch(/onLeadershipLost\(MAIN_SERVICE, async \(\) => \{[\s\S]*?running\.close\(\)[\s\S]*?watchForServiceLeadership\(MAIN_SERVICE, startEvenG2Main\)/)
        })

        it('keeps the owner-notice path on the one fenced authority', () => {
            expect(daemon).toMatch(/verifyLiveServiceLeadership\(MAIN_SERVICE\)[\s\S]{0,400}hasValidFence\(MAIN_SERVICE\)/)
        })
    })
})
