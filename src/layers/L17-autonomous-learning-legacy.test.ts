import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { rememberSolution } from './L17-autonomous-learning.js'

describe('L17 learned-solutions keeps legacy records (R2 L12)', () => {
    it('does not drop records that recall filters out when a new solution is saved', () => {
        const dir = join(process.env.NOVA_RUNTIME_ROOT || process.cwd(), '.nova-learning')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'learned-solutions.json')
        const legacy = { problem: 'kurz', solution: 'alte Loesung', learnedAt: 1, successCount: 3 }
        writeFileSync(file, JSON.stringify([legacy]))

        const saved = rememberSolution(
            'wie starte ich den dienst auf dem server neu',
            'Tool run_command: systemctl restart nova',
            undefined,
            { verified: true, toolName: 'run_command', result: { success: true, output: 'restarted nova service' } },
        )
        expect(saved).toBe(true)
        const stored = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ problem: string }>
        expect(stored.map(entry => entry.problem)).toContain('kurz')
        expect(stored.length).toBe(2)
    })
})
