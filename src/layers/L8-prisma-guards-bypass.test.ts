import { describe, expect, it } from 'vitest'
import { checkDatabaseSafety } from './L8-prisma-guards.js'

describe('L8 prisma guards bypasses (R2 L8)', () => {
    it.each([
        'DELETE FROM users',
        'DELETE FROM "users";',
        'psql -c "DELETE FROM public.users"',
        "UPDATE users SET name='Walter';",
        'UPDATE t SET a=1',
    ])('blocks unbounded write: %s', (command) => {
        const result = checkDatabaseSafety(command)
        expect(result.safe).toBe(false)
        expect(result.blocked).toBe(true)
    })

    it.each([
        'npx prisma studio',
        'await prisma.user.updateMany({}, { data: { a: 1 } })',
    ])('blocks high-severity operation without a confirmation flow: %s', (command) => {
        expect(checkDatabaseSafety(command).blocked).toBe(true)
    })

    it.each([
        'DELETE FROM users WHERE id = 1',
        "UPDATE users SET name='Walter' WHERE id = 7;",
        'SELECT * FROM users WHERE id = 1',
        'sudo apt-get update',
    ])('leaves bounded statements alone: %s', (command) => {
        expect(checkDatabaseSafety(command).blocked).toBe(false)
    })
})
