import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Handover from the layers review: node discovery built an ssh shell string
// (host/cmd interpolated, StrictHostKeyChecking=no) and used the node name
// unchecked as a file path.

const childProcess = vi.hoisted(() => ({
    exec: vi.fn((_cmd: string, _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(new Error('offline'), '')),
    execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(new Error('offline'), '')),
}))
vi.mock('node:child_process', () => childProcess)

import { isSafeSshTarget, NodeIntelligence, playbookFileName } from './node-intelligence.js'

beforeEach(() => { childProcess.exec.mockClear(); childProcess.execFile.mockClear() })

describe('node-intelligence ssh discovery', () => {
    it('never runs ssh through a local shell and refuses option-like or injected hosts', async () => {
        await NodeIntelligence.discover('pi@10.0.0.5', 'pi5-test')
        expect(childProcess.exec).not.toHaveBeenCalled()
        expect(childProcess.execFile).toHaveBeenCalled()
        for (const call of childProcess.execFile.mock.calls) {
            const [file, args] = call as unknown as [string, string[]]
            expect(file).toBe('ssh')
            expect(args).toContain('StrictHostKeyChecking=accept-new')
            expect(args).not.toContain('StrictHostKeyChecking=no')
            expect(args[args.indexOf('--') + 1]).toBe('pi@10.0.0.5')
        }
        childProcess.execFile.mockClear()
        await NodeIntelligence.discover('10.0.0.5;touch /tmp/pwned', 'evil-test')
        await NodeIntelligence.discover('-oProxyCommand=sh', 'evil-test-2')
        expect(childProcess.exec).not.toHaveBeenCalled()
        expect(childProcess.execFile).not.toHaveBeenCalled()
    })

    it('keeps playbook files inside the node-intel directory', async () => {
        expect(playbookFileName('../../etc/cron.d/x')).not.toMatch(/[\\/]/)
        expect(playbookFileName('..')).not.toBe('...json')
        NodeIntelligence.save({ nodeId: '../../escape-node', discoveredAt: 0, lastUpdated: 0, os: 'x', arch: 'x', hardware: {}, software: {}, commands: {}, healthCmd: '', probeLog: [] } as any)
        const dir = join(process.cwd(), '.nova-data', 'node-intel')
        expect(existsSync(join(process.cwd(), 'escape-node.json'))).toBe(false)
        expect(readdirSync(dir).some(file => file.includes('escape-node'))).toBe(true)
    })

    it('accepts only user@host targets with plain host names or IPs', () => {
        expect(isSafeSshTarget('spark.tailnet.ts.net')).toBe(true)
        expect(isSafeSshTarget('nova@100.64.0.21')).toBe(true)
        expect(isSafeSshTarget('host "; rm -rf ~; "')).toBe(false)
        expect(isSafeSshTarget('-oProxyCommand=sh')).toBe(false)
    })
})
