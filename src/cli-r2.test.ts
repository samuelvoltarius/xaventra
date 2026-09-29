import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// cli.ts runs main() on import; wiring pinned at source level (R2 NZ-40, NZ-43).
const source = readFileSync(fileURLToPath(new URL('./cli.ts', import.meta.url)), 'utf8')

describe('cli process handling (R2 NZ-40, NZ-43)', () => {
    it('does not report a signal death of the daemon child as success', () => {
        expect(source).not.toMatch(/process\.exit\(code \?\? 0\)/)
        expect(source).toMatch(/child\.on\('exit', \(code, signal\) =>/)
        expect(source).toMatch(/128 \+ \(osConstants\.signals\[signal\] \?\? 0\)/)
    })

    it('bounds the status request', () => {
        expect(source).toMatch(/fetch\('http:\/\/localhost:18789\/api\/status', \{ signal: AbortSignal\.timeout\(\d+\) \}\)/)
    })
})
