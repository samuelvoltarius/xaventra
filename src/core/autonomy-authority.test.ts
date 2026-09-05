import { describe, expect, it } from 'vitest'
import { shouldRunGlobalAutonomy } from './autonomy-authority.js'

describe('global autonomy authority', () => {
    it('runs only with the fenced Main lease by default', () => {
        expect(shouldRunGlobalAutonomy(true, {})).toBe(true)
        expect(shouldRunGlobalAutonomy(false, {})).toBe(false)
    })

    it('allows an explicit standalone override', () => {
        expect(shouldRunGlobalAutonomy(false, {
            NOVA_AUTONOMY_REQUIRE_MAIN_LEASE: 'false',
        })).toBe(true)
    })
})
