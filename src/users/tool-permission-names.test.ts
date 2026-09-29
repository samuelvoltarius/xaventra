import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// R2 (tools hand-over): the user allowlist named `reminder` and
// `codebase_search`, which are not registered tools, so the intended grants
// never applied. Pin the real names and that they are registered.
const middleware = readFileSync(new URL('./multi-user-middleware.ts', import.meta.url), 'utf8')
const userBlock = middleware.slice(middleware.indexOf('    user: {'), middleware.indexOf('    guest: {'))
const toolsDir = new URL('../tools/', import.meta.url)
const registered = new Set(readdirSync(toolsDir)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .flatMap(file => [...readFileSync(new URL(file, toolsDir), 'utf8').matchAll(/name:\s*['"]([a-z_]+)['"]/g)].map(match => match[1])))

describe('role tool allowlist names', () => {
    it.each(['set_reminder', 'list_reminders', 'code_search'])('grants the registered tool %s to users', name => {
        expect(userBlock).toContain(`'${name}'`)
        expect(registered.has(name)).toBe(true)
    })

    it('no longer lists the non-existent names', () => {
        expect(userBlock).not.toMatch(/'reminder'|'codebase_search'/)
    })
})
