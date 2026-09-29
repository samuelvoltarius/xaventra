import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getConfigAllowFrom } from './multi-user-middleware.js'

// H6 regression: an unreadable/invalid configuration must not turn the bot
// into "no whitelist = everyone is a user". It must fail closed.

const root = join(process.cwd(), '.nova-test-tmp', `allowfrom-${randomUUID()}`)
mkdirSync(root, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

function config(name: string, content: string): string {
    const path = join(root, name)
    writeFileSync(path, content)
    return path
}

describe('getConfigAllowFrom fail-closed (H6)', () => {
    it('returns the configured Telegram allow-list', () => {
        expect(getConfigAllowFrom(config('ok.json', JSON.stringify({ channels: { telegram: { allowFrom: ['1'] } } })))).toEqual(['1'])
    })

    it('keeps an explicitly empty/absent allow-list open (unchanged behaviour)', () => {
        expect(getConfigAllowFrom(config('empty.json', JSON.stringify({ channels: { telegram: {} } })))).toEqual([])
        expect(getConfigAllowFrom(join(root, 'missing.json'))).toEqual([])
    })

    it('treats a parse error as restricted, not open', () => {
        const allowFrom = getConfigAllowFrom(config('broken.json', '{ "channels": { "telegram": { "allowFrom": ["1"] '))
        expect(allowFrom.length).toBeGreaterThan(0)
        expect(allowFrom).not.toContain('1')
    })

    it('treats a malformed allow-list as restricted', () => {
        expect(getConfigAllowFrom(config('string.json', JSON.stringify({ allowFrom: '1' }))).length).toBeGreaterThan(0)
        expect(getConfigAllowFrom(config('object.json', JSON.stringify({ allowFrom: { a: 1 } }))).length).toBeGreaterThan(0)
    })
})
