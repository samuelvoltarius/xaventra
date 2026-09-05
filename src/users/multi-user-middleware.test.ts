import { describe, expect, it } from 'vitest'
import {
    isConfiguredOwner,
    reconcileConfiguredOwner,
    resolveUserReference,
    type UserRecord,
} from './multi-user-middleware.js'

function user(id: string, name?: string): UserRecord {
    return { id, name, permission: 'user', firstSeen: 1, lastSeen: 1, messageCount: 0, channel: 'telegram', onboarded: true }
}

describe('multi-user reference resolution', () => {
    const records = { '42': user('42', 'Sample Two'), '99': user('99', 'Sample') }

    it('resolves stable ids and display names case-insensitively', () => {
        expect(resolveUserReference(records, '42')).toMatchObject({ id: '42' })
        expect(resolveUserReference(records, 'sample two')).toMatchObject({ id: '42' })
    })

    it('fails closed for ambiguous display names', () => {
        expect(resolveUserReference({ ...records, '77': user('77', 'Sample Two') }, 'Sample Two').error).toContain('nicht eindeutig')
    })

    it('reports unknown users without guessing', () => {
        expect(resolveUserReference(records, 'missing').error).toContain('nicht gefunden')
    })
})

describe('configured owner reconciliation', () => {
    it('recognizes raw and channel-qualified allow-list ids', () => {
        expect(isConfiguredOwner('1000000001', 'telegram', ['1000000001'])).toBe(true)
        expect(isConfiguredOwner('telegram:1000000001', 'telegram', ['1000000001'])).toBe(true)
        expect(isConfiguredOwner('1000000001', 'telegram', ['telegram:1000000001'])).toBe(true)
    })

    it('restores a stale local role without demoting unrelated owners', () => {
        const stale = user('1000000001', 'Sample')
        expect(reconcileConfiguredOwner(stale, ['1000000001'])).toMatchObject({
            changed: true,
            user: { permission: 'owner' },
        })
        const existingOwner = { ...user('99', 'CLI'), permission: 'owner' as const }
        expect(reconcileConfiguredOwner(existingOwner, [])).toEqual({ user: existingOwner, changed: false })
    })
})
