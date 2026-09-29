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
