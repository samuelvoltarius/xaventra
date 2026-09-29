import { expect, it } from 'vitest'
import { posix } from 'node:path'
import * as ws from './workstation-security.js'

const facts = (kind: 'file' | 'dir', mode: number, uid = 1500, link = false): ws.PathFacts => ({
    isFile: () => kind === 'file' && !link, isDirectory: () => kind === 'dir' && !link, isSymbolicLink: () => link, uid, mode,
})

it('keeps the input journal, token and capture files outside the agent shell HOME', () => {
    const p = (ws as any).planWorkstationPaths('/run/xaventra-ws', '/var/lib/xaventra-ws')
    expect(p.shellHome).toBe('/var/lib/xaventra-ws/home')
    for (const secret of [p.journal, p.auth, p.captureDir, p.socket])
        expect(ws.isInside(p.shellHome, secret), secret).toBe(false)
    const env = (ws as any).workstationChildEnv(p, ':100')
    expect(env.HOME).toBe(p.shellHome)
    expect(env.HOME).not.toBe('/var/lib/xaventra-ws')
    expect(ws.isInside(env.HOME, p.journal)).toBe(false)
})
it('refuses a token file inside the agent shell HOME', () => {
    const id = (x: string) => x
    expect(() => ws.assertOutsideShellHome('token', '/var/lib/ws/home/.token', '/var/lib/ws/home', id)).toThrow(/HOME/)
    expect(() => ws.assertOutsideShellHome('token', '/var/lib/ws/home', '/var/lib/ws/home', id)).toThrow(/HOME/)
    expect(() => ws.assertOutsideShellHome('token', '/var/lib/ws/token', '/var/lib/ws/home', id)).not.toThrow()
    expect(() => ws.assertOutsideShellHome('token', '/var/lib/ws/homework/t', '/var/lib/ws/home', id)).not.toThrow()
    expect(posix.sep).toBe('/')
})
it('requires private owner-only token, state and journal permissions', () => {
    expect(() => ws.assertOwnedPrivate('token', facts('file', 0o100600), 'file', 1500, 0o077)).not.toThrow()
    for (const mode of [0o100640, 0o100604, 0o100660, 0o100644])
        expect(() => ws.assertOwnedPrivate('token', facts('file', mode), 'file', 1500, 0o077)).toThrow(/unsafe/)
    expect(() => ws.assertOwnedPrivate('token', facts('file', 0o100600, 1000), 'file', 1500, 0o077)).toThrow(/owned/)
    expect(() => ws.assertOwnedPrivate('token', facts('file', 0o100600, 1500, true), 'file', 1500, 0o077)).toThrow(/symbolic/)
    expect(() => ws.assertOwnedPrivate('token', facts('dir', 0o40700), 'file', 1500, 0o077)).toThrow(/regular file/)
    expect(() => ws.assertOwnedPrivate('state', facts('dir', 0o40700), 'dir', 1500, 0o077)).not.toThrow()
    expect(() => ws.assertOwnedPrivate('state', facts('dir', 0o40750), 'dir', 1500, 0o077)).toThrow(/unsafe/)
})
it('requires the runtime directory to be private (0700) or group-traversable only (0750) for the daemon socket', () => {
    const bits = (ws as any).RUNTIME_FORBIDDEN_BITS
    expect(() => ws.assertOwnedPrivate('runtime', facts('dir', 0o40700), 'dir', 1500, bits)).not.toThrow()
    expect(() => ws.assertOwnedPrivate('runtime', facts('dir', 0o40750), 'dir', 1500, bits)).not.toThrow()
    for (const mode of [0o40770, 0o40755, 0o40777, 0o40701])
        expect(() => ws.assertOwnedPrivate('runtime', facts('dir', mode), 'dir', 1500, bits)).toThrow(/unsafe/)
})

const base = { uid: 1500, username: 'xaventra-ws', expectedAccount: 'xaventra-ws', env: {}, sessions: [] as ws.LogindSession[] }
it('runs only as the explicitly named dedicated account', () => {
    expect(() => ws.assertDedicatedWorkstationAccount(base)).not.toThrow()
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, expectedAccount: undefined })).toThrow(/NOVA_WORKSTATION_ACCOUNT/)
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, username: 'alfred' })).toThrow(/dedicated account/)
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, uid: 0, username: 'root', expectedAccount: 'root' })).toThrow(/root/)
})
it('refuses a UID that owns a graphical logind session or inherited a display', () => {
    const personal = { id: '2', uid: 1500, type: 'wayland', state: 'active', active: true }
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, sessions: [personal] })).toThrow(/graphical login session/)
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, sessions: [{ ...personal, type: 'x11', state: 'online', active: false }] })).toThrow()
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, sessions: [{ ...personal, uid: 1000 }] })).not.toThrow()
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, sessions: [{ ...personal, type: 'tty' }] })).not.toThrow()
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, sessions: [{ ...personal, state: 'closing' }] })).not.toThrow()
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, env: { DISPLAY: ':0' } })).toThrow(/display/)
    expect(() => ws.assertDedicatedWorkstationAccount({ ...base, env: { WAYLAND_DISPLAY: 'wayland-0' } })).toThrow(/display/)
})
it('parses logind session records', () => {
    const files: Record<string, string> = {
        '/run/systemd/sessions/2': 'UID=1000\nUSER=alfred\nACTIVE=1\nSTATE=active\nTYPE=wayland\nCLASS=user\n',
        '/run/systemd/sessions/2.ref': 'x', '/run/systemd/sessions/c1': 'UID=1500\nTYPE=unspecified\nSTATE=online\n',
    }
    const io = { list: () => ['2', '2.ref', 'c1'], read: (p: string) => files[p] }
    expect(ws.readLogindSessions('/run/systemd/sessions', io)).toEqual([
        { id: '2', uid: 1000, type: 'wayland', state: 'active', active: true },
        { id: 'c1', uid: 1500, type: 'unspecified', state: 'online', active: false },
    ])
    expect(ws.readLogindSessions('/missing', { list: () => { throw Error('ENOENT') }, read: () => '' })).toEqual([])
})
it('wires the account guard into the workstation entry point before any display starts', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./workstation-main.ts', import.meta.url), 'utf8')
    const guard = src.indexOf('assertDedicatedWorkstationAccount(')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(src.indexOf("start('/usr/bin/Xvfb'"))
    expect(guard).toBeLessThan(src.indexOf('writeFileSync(auth'))
})
