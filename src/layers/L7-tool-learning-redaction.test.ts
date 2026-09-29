import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import toolLearning from './L7-tool-learning.js'

const examplesFile = () => join(process.cwd(), '.nova-data', 'tool-examples.json')

describe('L7 tool-learning persistence (R2 L5)', () => {
    it('does not persist inline or nested secrets from tool params', () => {
        const learner = new toolLearning.ToolUsageLearner()
        learner.recordUsage('run_command', 'deploy mit sshpass -p Hunter2Geheim ssh root@host', {
            command: 'sshpass -p Hunter2Geheim ssh root@10.0.0.5 uptime',
            env: { nested: { password: 'NestedPw123' }, url: 'https://admin:UrlPw456@example.org/x' },
            args: ['--header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'],
        }, false)
        const stored = readFileSync(examplesFile(), 'utf-8')
        expect(stored).not.toContain('Hunter2Geheim')
        expect(stored).not.toContain('NestedPw123')
        expect(stored).not.toContain('UrlPw456')
        expect(stored).not.toContain('abcdefghijklmnopqrstuvwxyz0123')
        expect(stored).toContain('root@10.0.0.5 uptime')
    })

    it('caps the persisted example list', () => {
        const learner = new toolLearning.ToolUsageLearner()
        for (let i = 0; i < 1100; i++) learner.recordUsage('web_search', `q${i}`, { query: `q${i}` }, false)
        const stored = JSON.parse(readFileSync(examplesFile(), 'utf-8')) as Array<{ userRequest: string }>
        expect(stored.length).toBeLessThanOrEqual(1000)
        expect(stored[stored.length - 1].userRequest).toBe('q1099')
    })
})
