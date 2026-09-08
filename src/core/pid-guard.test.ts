import { describe, expect, it } from 'vitest'
import { hasConflictingDaemonPid, isNovaDaemonCommandLine } from './pid-guard.js'

describe('Nova daemon PID identity', () => {
    it('allows a container restart with its own reused PID without probing itself', () => {
        expect(hasConflictingDaemonPid(7, 7, () => { throw Error('self probe') })).toBe(false)
    })

    it('still rejects another live daemon and permits a stale different PID', () => {
        expect(hasConflictingDaemonPid(8, 7, () => true)).toBe(true)
        expect(hasConflictingDaemonPid(8, 7, () => false)).toBe(false)
        expect(hasConflictingDaemonPid(-1, 7, () => true)).toBe(false)
    })
    it('recognizes built and development daemon commands across platforms', () => {
        expect(isNovaDaemonCommandLine('node dist/daemon.js')).toBe(true)
        expect(isNovaDaemonCommandLine('/usr/bin/node /opt/nova/dist/daemon.js')).toBe(true)
        expect(isNovaDaemonCommandLine('tsx C:\\nova\\src\\daemon.ts')).toBe(true)
    })

    it('does not confuse a reused PID with Nova', () => {
        expect(isNovaDaemonCommandLine('C:\\Users\\me\\.local\\bin\\uv.exe tool run')).toBe(false)
        expect(isNovaDaemonCommandLine('node dist/cli.js')).toBe(false)
    })
})
