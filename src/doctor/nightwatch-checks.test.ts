import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { buildSshArgs, commandFor, parseNightwatchConfig, runCheck, shellQuote, type CommandOutcome, type NightwatchHost } from './nightwatch-checks.js'

const NOW = Date.parse('2026-09-30T03:00:00Z')
const hosts: Record<string, NightwatchHost> = {
    local: { kind: 'local' },
    srv: { kind: 'ssh', target: 'watch@srv.example.invalid', port: 2222, identityFile: '/home/nova/.ssh/nightwatch_ed25519' },
}
const out = (partial: Partial<CommandOutcome>): CommandOutcome => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...partial })
const runnerReturning = (outcome: CommandOutcome) => vi.fn(async () => outcome)

describe('parseNightwatchConfig', () => {
    const valid = {
        version: 1,
        hosts: { srv: { kind: 'ssh', target: 'watch@srv.example.invalid' } },
        checks: [{ id: 'svc', kind: 'systemd', host: 'srv', unit: 'xaventra-native.service' }],
    }

    it('accepts a valid config and always provides the local host', () => {
        const config = parseNightwatchConfig(valid)
        expect(config.hosts.local).toEqual({ kind: 'local' })
        expect(config.checks).toHaveLength(1)
    })

    it.each([
        ['shell metacharacters in a unit', { id: 'a', kind: 'systemd', unit: 'x;rm -rf /' }],
        ['a unit that looks like an option', { id: 'a', kind: 'systemd', unit: '-H' }],
        ['a relative path', { id: 'a', kind: 'file', path: 'etc/passwd' }],
        ['path traversal', { id: 'a', kind: 'backup', dir: '/srv/../root', maxAgeHours: 24 }],
        ['quotes in a path', { id: 'a', kind: 'file', path: "/tmp/x'y" }],
        ['credentials in a url', { id: 'a', kind: 'http', url: 'https://user:pw@example.invalid/' }],
        ['a non-http url', { id: 'a', kind: 'http', url: 'file:///etc/passwd' }],
        ['an option as find pattern', { id: 'a', kind: 'backup', dir: '/srv', maxAgeHours: 24, namePattern: '-delete' }],
        ['inverted disk thresholds', { id: 'a', kind: 'disk', mount: '/', warnPercent: 96, critPercent: 90 }],
        ['an unknown kind', { id: 'a', kind: 'exec', command: 'reboot' }],
        ['an unknown host', { id: 'a', kind: 'systemd', unit: 'x.service', host: 'nope' }],
    ])('rejects %s', (_name, check) => {
        expect(() => parseNightwatchConfig({ ...valid, checks: [check] })).toThrow(/ungültig/)
    })

    it('rejects an ssh target with options or spaces', () => {
        expect(() => parseNightwatchConfig({ ...valid, hosts: { srv: { kind: 'ssh', target: '-oProxyCommand=x@h' } } })).toThrow(/target/)
        expect(() => parseNightwatchConfig({ ...valid, hosts: { srv: { kind: 'ssh', target: 'a@b c' } } })).toThrow(/target/)
    })

    it('accepts the shipped example config, which contains only placeholder hosts', () => {
        const text = readFileSync(new URL('../../nightwatch.example.json', import.meta.url), 'utf8')
        const example = parseNightwatchConfig(JSON.parse(text))
        expect(example.checks.length).toBeGreaterThan(5)
        for (const host of Object.values(example.hosts)) {
            if (host.kind === 'ssh') expect(host.target).toMatch(/\.example\.invalid$/)
        }
        expect(text).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b(?<!127\.0\.0\.1)/)
    })

    it('rejects duplicate ids and empty check lists', () => {
        expect(() => parseNightwatchConfig({ ...valid, checks: [valid.checks[0], valid.checks[0]] })).toThrow(/doppelt/)
        expect(() => parseNightwatchConfig({ ...valid, checks: [] })).toThrow(/nicht leere/)
    })
})

describe('commands', () => {
    it('builds fixed argv without any shell', () => {
        expect(commandFor({ id: 'a', kind: 'systemd', unit: 'x.service', user: true })).toEqual(['systemctl', '--user', 'is-active', '--', 'x.service'])
        expect(commandFor({ id: 'a', kind: 'disk', mount: '/' })).toEqual(['df', '-P', '-k', '--', '/'])
        expect(commandFor({ id: 'a', kind: 'file', path: '/root/b.sh', executable: true })).toEqual(['test', '-x', '/root/b.sh'])
    })

    it('single-quotes every remote argument and pins host keys', () => {
        const args = buildSshArgs(hosts.srv as any, ['find', '/srv/backup', '-printf', '%T@\\n'], 20_000)
        expect(args).toContain('StrictHostKeyChecking=yes')
        expect(args).toContain('BatchMode=yes')
        expect(args.slice(-3)).toEqual(['--', 'watch@srv.example.invalid', "'find' '/srv/backup' '-printf' '%T@\\n'"])
        expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    })
})

describe('runCheck', () => {
    it('systemd active is ok, failed is a critical error', async () => {
        const ok = await runCheck({ id: 's', kind: 'systemd', unit: 'x.service' }, hosts, { runner: runnerReturning(out({ stdout: 'active\n' })), now: () => NOW })
        expect(ok.status).toBe('ok')
        const failed = await runCheck({ id: 's', kind: 'systemd', unit: 'x.service' }, hosts, { runner: runnerReturning(out({ exitCode: 3, stdout: 'failed\n' })), now: () => NOW })
        expect(failed).toMatchObject({ status: 'fehler', severity: 'critical' })
        expect(failed.evidence).toMatchObject({ command: 'systemctl is-active -- x.service', exitCode: 3 })
    })

    it('an unreachable ssh host or a timeout is unknown, never ok, and only a warning', async () => {
        const check = { id: 's', kind: 'systemd' as const, unit: 'x.service', host: 'srv' }
        const down = await runCheck(check, hosts, { runner: runnerReturning(out({ exitCode: 255, stderr: 'ssh: connect to host: timed out' })), now: () => NOW })
        expect(down).toMatchObject({ status: 'unbekannt', severity: 'warning' })
        const slow = await runCheck(check, hosts, { runner: runnerReturning(out({ exitCode: null, timedOut: true })), now: () => NOW })
        expect(slow.status).toBe('unbekannt')
        const thrown = await runCheck(check, hosts, { runner: vi.fn(async () => { throw new Error('boom') }), now: () => NOW })
        expect(thrown.status).toBe('unbekannt')
    })

    it('passes the configured host to the runner', async () => {
        const runner = runnerReturning(out({ stdout: 'active' }))
        await runCheck({ id: 's', kind: 'systemd', unit: 'x.service', host: 'srv' }, hosts, { runner, now: () => NOW })
        expect(runner).toHaveBeenCalledWith(hosts.srv, ['systemctl', 'is-active', '--', 'x.service'], 20_000)
    })

    it('disk thresholds map to warning and critical', async () => {
        const df = (pct: number) => out({ stdout: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 ${pct} ${100 - pct} ${pct}% /\n` })
        const check = { id: 'd', kind: 'disk' as const, mount: '/' }
        expect((await runCheck(check, hosts, { runner: runnerReturning(df(40)), now: () => NOW })).status).toBe('ok')
        expect(await runCheck(check, hosts, { runner: runnerReturning(df(93)), now: () => NOW })).toMatchObject({ status: 'fehler', severity: 'warning' })
        expect(await runCheck(check, hosts, { runner: runnerReturning(df(97)), now: () => NOW })).toMatchObject({ status: 'fehler', severity: 'critical' })
        expect((await runCheck(check, hosts, { runner: runnerReturning(out({ stdout: 'garbage' })), now: () => NOW })).status).toBe('unbekannt')
    })

    it('backup age, missing folder and empty folder', async () => {
        const check = { id: 'b', kind: 'backup' as const, dir: '/srv/backup', maxAgeHours: 26 }
        const stamp = (hoursAgo: number) => `${(NOW / 1000 - hoursAgo * 3600).toFixed(3)}\n`
        expect((await runCheck(check, hosts, { runner: runnerReturning(out({ stdout: stamp(30) + stamp(2) })), now: () => NOW })).status).toBe('ok')
        const old = await runCheck(check, hosts, { runner: runnerReturning(out({ stdout: stamp(30) })), now: () => NOW })
        expect(old).toMatchObject({ status: 'fehler', severity: 'warning' })
        expect(old.message).toMatch(/30 h/)
        expect((await runCheck(check, hosts, { runner: runnerReturning(out({ stdout: '' })), now: () => NOW })).message).toBe('kein Backup gefunden')
        const missing = await runCheck(check, hosts, { runner: runnerReturning(out({ exitCode: 1, stderr: "find: '/srv/backup': No such file or directory" })), now: () => NOW })
        expect(missing).toMatchObject({ status: 'fehler', message: 'Backup-Ordner fehlt' })
        const denied = await runCheck(check, hosts, { runner: runnerReturning(out({ exitCode: 1, stderr: "find: '/srv/backup': Permission denied" })), now: () => NOW })
        expect(denied.status).toBe('unbekannt')
    })

    it('file check reports a missing cron target', async () => {
        const check = { id: 'f', kind: 'file' as const, path: '/root/scripts/nas_backup.sh', executable: true }
        expect((await runCheck(check, hosts, { runner: runnerReturning(out({ exitCode: 0 })), now: () => NOW })).status).toBe('ok')
        expect(await runCheck(check, hosts, { runner: runnerReturning(out({ exitCode: 1 })), now: () => NOW })).toMatchObject({ status: 'fehler', message: 'fehlt oder nicht ausführbar' })
    })

    it('http: expected status is ok, 5xx and unreachable are failures, no redirects are followed', async () => {
        const check = { id: 'h', kind: 'http' as const, url: 'https://example.invalid/health' }
        const fetcher = vi.fn(async () => ({ status: 200 }))
        expect((await runCheck(check, hosts, { fetcher, now: () => NOW })).status).toBe('ok')
        expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
        expect(await runCheck(check, hosts, { fetcher: vi.fn(async () => ({ status: 503 })), now: () => NOW })).toMatchObject({ status: 'fehler', severity: 'critical' })
        expect((await runCheck(check, hosts, { fetcher: vi.fn(async () => { throw new TypeError('fetch failed') }), now: () => NOW })).message).toBe('nicht erreichbar')
        expect((await runCheck({ ...check, expectStatus: [401] }, hosts, { fetcher: vi.fn(async () => ({ status: 401 })), now: () => NOW })).status).toBe('ok')
    })

    it('redacts secrets from evidence output', async () => {
        const result = await runCheck({ id: 's', kind: 'systemd', unit: 'x.service' }, hosts, {
            runner: runnerReturning(out({ exitCode: 3, stdout: 'failed', stderr: 'TELEGRAM_BOT_TOKEN=123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })), now: () => NOW,
        })
        expect(result.evidence.output).not.toContain('AAAAAAAA')
        expect(result.evidence.output).toContain('[REDACTED]')
    })
})
