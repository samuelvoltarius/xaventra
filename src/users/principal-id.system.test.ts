import { describe, expect, it } from 'vitest'
import { resolvePrincipalId } from './principal-id.js'

describe('2.89.2 system actors never join a person principal', () => {
    it('keeps Nova-Autonomy on its own principal even with a mapping', () => {
        const config = { userPrincipals: { 'Nova-Autonomy': 'owner', 'telegram:Nova-Autonomy': 'owner' } }
        expect(resolvePrincipalId(config, 'Telegram', 'Nova-Autonomy')).toBe('Nova-Autonomy')
        expect(resolvePrincipalId(config, 'Telegram', 'system')).toBe('system')
    })
    it('still maps real accounts', () => {
        expect(resolvePrincipalId({ userPrincipals: { 'telegram:123': 'sample' } }, 'Telegram', '123')).toBe('sample')
    })
})
