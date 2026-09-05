import { describe, expect, it } from 'vitest'
import { compatiblePrincipalScopes, principalScope, resolvePrincipalId } from './principal-id.js'

describe('stable principal identity', () => {
    it('does not change when a display alias changes', () => {
        const config = { userPrincipals: { 'telegram:42': 'owner-sample' } }
        expect(resolvePrincipalId(config, 'telegram', '42')).toBe('owner-sample')
        expect(resolvePrincipalId({ ...config, userAliases: { '42': 'Neuer Name' } } as any, 'telegram', '42'))
            .toBe('owner-sample')
    })

    it('links channels only through an explicit mapping', () => {
        const config = { userPrincipals: { 'telegram:42': 'sample', 'discord:99': 'sample' } }
        expect(resolvePrincipalId(config, 'telegram', '42')).toBe(resolvePrincipalId(config, 'discord', '99'))
        expect(resolvePrincipalId({}, 'discord', '99')).toBe('99')
    })

    it('keeps legacy scopes as read-only migration compatibility', () => {
        expect(compatiblePrincipalScopes({ channel: 'telegram', rawUserId: '42', principalId: 'sample' }, 'Sample'))
            .toEqual([principalScope('sample'), principalScope('42'), principalScope('Sample')])
    })
})
