import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthManager } from './auth.js'

describe('dashboard login (R2 A25)', () => {
    it('refuses a login while no dashboard password is set', () => {
        const auth = new AuthManager({}, join(process.cwd(), '.nova-auth-fixture'))
        expect(auth.loginDashboard('anything')).toBeNull()
    })
})
