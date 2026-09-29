import { beforeEach, describe, expect, it, vi } from 'vitest'

const exec = vi.fn()
const execFile = vi.fn((_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    cb(null, 'ok\n', '')
})
const getOrDiscover = vi.fn(async () => ({ healthCmd: 'uptime' }))
const discover = vi.fn(async () => ({ healthCmd: 'uptime' }))

vi.mock('node:child_process', () => ({ exec, execFile }))
vi.mock('../mesh/node-intelligence.js', () => ({ NodeIntelligence: { getOrDiscover, discover } }))
vi.mock('../mesh/ai-scanner.js', () => ({ getLastScanResult: () => null }))

const { sshExec, collectNodeHealth, isSafeSshTarget } = await import('./L21-node-health.js')

describe('L21 node health ssh hardening (R2 L2)', () => {
    beforeEach(() => {
        exec.mockClear()
        execFile.mockClear()
        getOrDiscover.mockClear()
    })

    it('rejects registry-controlled targets carrying shell or ssh option syntax', async () => {
        for (const host of ['x$(touch /tmp/pwn)@10.0.0.1', '-oProxyCommand=sh@h', 'pi@-oProxyCommand=sh', 'pi@1.2.3.4 ; id', 'pi@1.2.3.4"', 'nouser']) {
            expect(isSafeSshTarget(host)).toBe(false)
            await expect(sshExec(host, 'uptime')).rejects.toThrow(/rejected/)
        }
        expect(exec).not.toHaveBeenCalled()
        expect(execFile).not.toHaveBeenCalled()
    })

    it('runs ssh via execFile with an argv array and without StrictHostKeyChecking=no', async () => {
        await expect(sshExec('xaventra@100.64.0.21', 'uptime')).resolves.toBe('ok')
        expect(exec).not.toHaveBeenCalled()
        expect(execFile).toHaveBeenCalledTimes(1)
        const [file, args] = execFile.mock.calls[0]
        expect(file).toBe('ssh')
        expect(args).toContain('StrictHostKeyChecking=accept-new')
        expect(args.join(' ')).not.toContain('StrictHostKeyChecking=no')
        expect(args.slice(-3)).toEqual(['--', 'xaventra@100.64.0.21', 'uptime'])
    })

    it('does not hand unsafe hosts or path-traversal names to node discovery', async () => {
        await collectNodeHealth({ name: 'Pi5', host: 'x$(id)@10.0.0.1' })
        await collectNodeHealth({ name: '../../evil', host: 'pi@10.0.0.1' })
        expect(getOrDiscover).not.toHaveBeenCalled()
        expect(exec).not.toHaveBeenCalled()
    })
})

describe('L21 node health start without config nodes (R2 L18)', () => {
    it('starts the periodic check even when only mesh nodes may exist', async () => {
        const { getNodeHealthMonitor } = await import('./L21-node-health.js')
        vi.useFakeTimers()
        try {
            const monitor = getNodeHealthMonitor()
            monitor.stop()
            const before = vi.getTimerCount()
            monitor.start()
            expect(vi.getTimerCount()).toBeGreaterThan(before)
            monitor.stop()
        } finally {
            vi.clearAllTimers()
            vi.useRealTimers()
        }
    })
})
