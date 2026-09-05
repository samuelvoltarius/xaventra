import { describe, expect, it } from 'vitest'
import { isNovaDaemonCommandLine } from './pid-guard.js'

describe('Nova daemon PID identity', () => {
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
