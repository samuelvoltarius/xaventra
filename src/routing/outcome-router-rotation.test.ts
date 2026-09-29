import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { OutcomeLedger } from '../core/outcome-ledger.js'
import { OutcomeRouter } from './outcome-router.js'

describe('R2 L14: shadow decision log is rotated', () => {
    it('moves an oversized log to .1 before appending', () => {
        const dir = mkdtempSync(join(tmpdir(), 'xaventra-router-rot-'))
        const decisions = join(dir, 'decisions.jsonl')
        writeFileSync(decisions, 'x'.repeat(5 * 1024 * 1024 + 10))
        const router = new OutcomeRouter(new OutcomeLedger(join(dir, 'ledger')), decisions, 'shadow', join(dir, 'samples.json'))

        router.decide('coding', { model: 'configured', node: 'main' }, [{ model: 'candidate', node: 'spark', baseScore: 100 }], { userId: 'alice', channel: 'telegram' })

        expect(existsSync(`${decisions}.1`)).toBe(true)
        expect(statSync(decisions).size).toBeLessThan(10_000)
    })
})
