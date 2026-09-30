import { describe, expect, it } from 'vitest'
import { DBUS_RUN_SESSION, planDesktopSession, XFCE_SESSION } from './workstation-desktop.js'

describe('workstation desktop session', () => {
    it('runs a full XFCE session on its own session bus when XFCE is installed', () => {
        const plan = planDesktopSession(path => path === XFCE_SESSION || path === DBUS_RUN_SESSION)
        expect(plan.kind).toBe('xfce')
        expect(plan.programs).toEqual([{ file: DBUS_RUN_SESSION, args: ['--', XFCE_SESSION] }])
    })

    it('keeps the minimal desktop when XFCE or dbus-run-session is missing', () => {
        for (const present of [[], [XFCE_SESSION], [DBUS_RUN_SESSION]]) {
            const plan = planDesktopSession(path => present.includes(path))
            expect(plan.kind).toBe('minimal')
            expect(plan.programs.map(program => program.file)).toEqual(['/usr/bin/openbox', '/usr/bin/xterm', '/usr/bin/xmessage'])
        }
    })
})
