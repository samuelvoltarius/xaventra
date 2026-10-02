/**
 * 2.82.0 Aufräumen Punkt 7: Release-Prüfungen gebündelt auf den Release-Wächter.
 * Delegation (`release-tag`) und die Auto-Erinnerungen (Nachprüfung einer
 * unbestätigten Release) fragen über eine Abfrage; der Mesh-Updater prüft
 * nicht selbst, solange der Release-Wächter läuft; der Daemon startet ihn.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { checkExpectation } from '../delegation.js'
import { isSelfUpdateWatchRunning, lookupReleaseTag, readSelfUpdateSettings, startSelfUpdateWatch } from './release-watch.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('eine Release-Abfrage', () => {
    it('Delegation und Auto-Erinnerungen teilen eine Anfrage je Tag (10 min)', async () => {
        const fetcher = vi.fn(async () => json({ draft: false, published_at: '2026-10-01T09:00:00Z' }))
        const viaDelegation = await checkExpectation({ art: 'release-tag', tag: 'v2.82.0' } as any, fetcher as any)
        const viaReminders = await checkExpectation({ art: 'release-tag', tag: 'v2.82.0' } as any, fetcher as any)
        const direct = await lookupReleaseTag('v2.82.0', { fetcher: fetcher as any })
        expect(viaDelegation.ergebnis).toBe('verifiziert')
        expect(viaReminders.ergebnis).toBe('verifiziert')
        expect(direct.state).toBe('veroeffentlicht')
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(String((fetcher.mock.calls[0] as any)[0])).toBe('https://api.github.com/repos/samuelvoltarius/xaventra/releases/tags/v2.82.0')
    })

    it('fehlt, Entwurf, unbekannt — nur „veröffentlicht“ wird festgehalten (Gegenprobe)', async () => {
        const missing = vi.fn(async () => json({}, 404))
        expect((await lookupReleaseTag('v9.9.9', { fetcher: missing as any })).state).toBe('fehlt')
        await lookupReleaseTag('v9.9.9', { fetcher: missing as any })
        expect(missing).toHaveBeenCalledTimes(2)
        expect((await checkExpectation({ art: 'release-tag', tag: 'v9.9.8' } as any, vi.fn(async () => json({ draft: true })) as any)).ergebnis).toBe('nicht-erfuellt')
        const flaky = vi.fn(async () => json({}, 502))
        expect((await lookupReleaseTag('v9.9.7', { fetcher: flaky as any })).state).toBe('unbekannt')
        await lookupReleaseTag('v9.9.7', { fetcher: flaky as any })
        expect(flaky).toHaveBeenCalledTimes(2)
    })

    it('der Mesh-Updater prüft nicht selbst, solange der Release-Wächter läuft', () => {
        expect(isSelfUpdateWatchRunning()).toBe(false)
        const settings = { ...readSelfUpdateSettings({}), enabled: true }
        const handle = startSelfUpdateWatch({ settings, currentVersion: '2.82.0', sink: { emit: async () => undefined } as any, statePath: 'unused.json', fetcher: vi.fn() as any })
        expect(isSelfUpdateWatchRunning()).toBe(true)
        handle!.stop()
        expect(isSelfUpdateWatchRunning()).toBe(false)
        const updater = readFileSync(fileURLToPath(new URL('../auto-updater.ts', import.meta.url)), 'utf8')
        expect(updater).toMatch(/if \(isSelfUpdateWatchRunning\(\)\) \{ updateStatus\.lastCheck/)
    })

    it('der Daemon startet den Release-Wächter (vorher nie verdrahtet)', () => {
        const daemon = readFileSync(fileURLToPath(new URL('../../daemon.ts', import.meta.url)), 'utf8')
        expect(daemon).toMatch(/startSelfUpdateWatch\(\{/)
        expect(daemon).toMatch(/sink: createSelfUpdateThoughtSink\(\)/)
    })
})
