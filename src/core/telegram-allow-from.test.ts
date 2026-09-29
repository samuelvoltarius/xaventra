import { describe, expect, it } from 'vitest'
import { resolveTelegramAllowFrom } from './telegram-allow-from.js'

// R2 NZ-9 (core-n-z #9): TELEGRAM_ALLOW_FROM must never yield an empty entry.

describe('resolveTelegramAllowFrom (R2 NZ-9)', () => {
    it('drops empty and whitespace entries', () => {
        expect(resolveTelegramAllowFrom('12345,', [])).toEqual(['12345'])
        expect(resolveTelegramAllowFrom(' 12345 , @alfred ,, ', [])).toEqual(['12345', '@alfred'])
    })

    it('keeps the config allowlist when the env value has no usable entry', () => {
        expect(resolveTelegramAllowFrom('', ['111'])).toEqual(['111'])
        expect(resolveTelegramAllowFrom(' , ', ['111'])).toEqual(['111'])
        expect(resolveTelegramAllowFrom(undefined, ['111', ''])).toEqual(['111'])
    })

    it('never returns an empty-string entry', () => {
        for (const value of ['', ',', '12345,', ' ']) {
            expect(resolveTelegramAllowFrom(value, [''])).not.toContain('')
        }
    })
})

// UEB-4: contradiction between the reviews, decided at base eb90b03.
// The adapter matcher rejects empty entries, so '' never admits a stranger
// (review claim from eae0f89 no longer holds). The real defect was the other
// direction: TELEGRAM_ALLOW_FROM='' produced [''] which replaced the config
// allowlist and matched nobody, locking out the owner.
describe('TELEGRAM_ALLOW_FROM with the Telegram adapter matcher (R2 UEB-4)', () => {
    it('lets neither a stranger through nor locks out the owner', async () => {
        const { telegramAllowlistMatches } = await import('../channels/telegram.js')
        const admitted = (allowFrom: string[], userId: string, username: string) =>
            allowFrom.some(entry => telegramAllowlistMatches(entry, userId, username))

        // Old parsing: '' replaced the config allowlist -> owner locked out.
        expect(admitted(''.split(','), '12345', 'alfred')).toBe(false)

        for (const env of ['', ',', '12345,', ' 12345 ']) {
            const allowFrom = resolveTelegramAllowFrom(env, ['12345'])
            expect(allowFrom.length, env).toBeGreaterThan(0)
            expect(admitted(allowFrom, '12345', ''), env).toBe(true)
            expect(admitted(allowFrom, '99999', ''), env).toBe(false)
            expect(admitted(allowFrom, '99999', 'fremder'), env).toBe(false)
        }
    })
})
