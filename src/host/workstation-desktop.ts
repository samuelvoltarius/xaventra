/**
 * Which programs make up the dedicated workstation desktop.
 *
 * Until 2.79.1 it was always openbox + one xterm + an xmessage banner: no panel,
 * no menu, no file manager, and the installed browsers/office were unreachable
 * (Alfred 30.09.2026: "warum hat sie keinen full desktop"). With XFCE installed
 * the workstation runs a complete XFCE session inside its own virtual display;
 * without it the minimal desktop stays, so the capture adapter keeps working.
 */
export type DesktopProgram = { file: string; args: string[] }

export const XFCE_SESSION = '/usr/bin/xfce4-session'
export const DBUS_RUN_SESSION = '/usr/bin/dbus-run-session'

export function planDesktopSession(exists: (path: string) => boolean): { kind: 'xfce' | 'minimal'; programs: DesktopProgram[] } {
    if (exists(XFCE_SESSION) && exists(DBUS_RUN_SESSION)) {
        // Own session bus: never attach to the personal user's D-Bus.
        return { kind: 'xfce', programs: [{ file: DBUS_RUN_SESSION, args: ['--', XFCE_SESSION] }] }
    }
    return {
        kind: 'minimal',
        programs: [
            { file: '/usr/bin/openbox', args: [] },
            { file: '/usr/bin/xterm', args: ['-title', 'Xaventra Terminal', '-geometry', '90x25+100+350', '-e', '/bin/bash', '--noprofile', '--norc'] },
            { file: '/usr/bin/xmessage', args: ['-title', 'Xaventra Arbeitsdesktop', '-geometry', '620x180+100+100', '-buttons', 'Bereit:0',
                'Eigener Xaventra-Arbeitsdesktop\nGetrennt von der persoenlichen Sitzung.\nScreenshot und Computer Use arbeiten hier.'] },
        ],
    }
}
