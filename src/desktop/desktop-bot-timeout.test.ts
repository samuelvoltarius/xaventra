import { describe, expect, it } from 'vitest'
import { desktopBotTimeoutMs } from './desktop-api.js'

// 2.88 (live 07.10.2026): a short web search in an app room ended with
// "Bot-Lauf nach 30 Sekunden beendet" while the app itself waits up to 120 s.
describe('desktop bot deadline matches the app', () => {
    it('defaults below the app wait (120 s) but long enough for search + fetch', () => {
        expect(desktopBotTimeoutMs({})).toBe(110_000)
        expect(desktopBotTimeoutMs({})).toBeLessThan(120_000)
    })
    it('explicit setting and NovaOS mode still win', () => {
        expect(desktopBotTimeoutMs({ NOVA_DESKTOP_BOT_TIMEOUT_MS: '45000' })).toBe(45_000)
        expect(desktopBotTimeoutMs({ NOVA_OS_MODE: 'true' })).toBe(2_400_000)
    })
})
