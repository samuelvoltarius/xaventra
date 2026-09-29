import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// daemon.ts starts the daemon on import, so these hand-overs are pinned at source level.
const source = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')

describe('daemon R2 hand-overs', () => {
    it('uses no bare require in ESM for the hostname', () => {
        expect(source).not.toContain("require('os')")
        expect(source).toContain("import { hostname } from 'node:os'")
    })

    it('marks the autonomy self-prompt as system-authored so its prefix is not neutralized', () => {
        const call = source.slice(source.indexOf("await handleMessage('Telegram', 'Nova-Autonomy'"), source.indexOf('return capturedReply'))
        expect(call).toMatch(/\}, undefined, \{ systemAuthored: true \}\)\s*$/)
    })

    it('does not claim a Bearer check that is not wired', () => {
        expect(source).not.toContain('Gateway auth: Bearer token active')
    })
})
