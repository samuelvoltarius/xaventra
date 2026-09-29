import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// R2 L9: the package is ESM ("type": "module"); a bare require() throws a
// ReferenceError that the surrounding catch {} swallows, so the code path
// silently never runs.
describe('layers use ESM imports only (R2 L9)', () => {
    it('has no bare require() calls in src/layers', () => {
        const dir = join(process.env.NOVA_PROJECT_ROOT || process.cwd(), 'src', 'layers')
        const offenders = readdirSync(dir)
            .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
            .filter(name => /(^|[^\w.])require\(/m.test(readFileSync(join(dir, name), 'utf-8')))
        expect(offenders).toEqual([])
    })
})
