import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelHandoffLog } from './channel-handoff.js'

const freshLog = (now: () => number) => new ChannelHandoffLog(mkdtempSync(join(tmpdir(), 'handoff-')), now)

describe('channel handoff: one conversation across channels', () => {
    it('what was said on the phone shows up afterwards in Telegram', () => {
        let now = 10_000_000
        const log = freshLog(() => now)
        log.record('owner', 'telefon', 'user', 'Bitte merk dir: Termin beim Zahnarzt am Freitag um 9', { unverified: true })
        log.record('owner', 'telefon', 'assistant', 'Notiert: Zahnarzt Freitag 9 Uhr.')
        now += 5 * 60_000
        const prompt = log.prompt('owner', 'telegram')
        expect(prompt).toContain('Zahnarzt am Freitag')
        expect(prompt).toContain('Telefon')
        expect(prompt).toContain('nicht geprüft')
        // the same channel is the agent's own history, not a handoff
        expect(log.prompt('owner', 'telefon')).toBe('')
    })

    it('treats Telegram/telegram as one channel and keeps other principals apart', () => {
        const now = 10_000_000
        const log = freshLog(() => now)
        log.record('owner', 'Telegram', 'user', 'Wir nehmen das blaue Sofa')
        expect(log.prompt('owner', 'telegram')).toBe('')
        expect(log.prompt('owner', 'desktop')).toContain('blaue Sofa')
        expect(log.prompt('stranger', 'desktop')).toBe('')
    })

    it('forgets old turns, redacts secrets and stays short', () => {
        let now = 10_000_000
        const log = freshLog(() => now)
        for (let i = 0; i < 40; i++) log.record('owner', 'slack', 'user', `Nachricht ${i} ${'x'.repeat(300)}`)
        log.record('owner', 'slack', 'user', 'mein token ist sk-abcdefghijklmnopqrstuvwxyz0123456789')
        const prompt = log.prompt('owner', 'telegram')
        expect(prompt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789')
        expect(prompt.length).toBeLessThanOrEqual(2000)
        now += 13 * 60 * 60_000
        expect(log.prompt('owner', 'telegram')).toBe('')
    })
})
