import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateConfig } from './config-validator.js'

describe('config validator (R2 A23)', () => {
    it('warns that an empty Telegram allowFrom is open, not closed', () => {
        const path = join(process.cwd(), 'validator-fixture.json')
        writeFileSync(path, JSON.stringify({ name: 'Nova', provider: 'local', channels: { telegram: { enabled: true, token: 'x', allowFrom: [] } } }))
        const warning = validateConfig(path).warnings.find(item => item.includes('allowFrom'))
        expect(warning).toBeDefined()
        expect(warning).not.toMatch(/akzeptiert keine Nachrichten/)
        expect(warning).toMatch(/JEDER/)
    })
})
