import { describe, expect, it } from 'vitest'
import { matchesBlockedPath } from './security.js'

// The system-path guard matched substrings: "/var" blocked "/home/x/various",
// "/lib" blocked ".../library", and every path under macOS' temp dir
// (/private/var/folders/...). It must match whole path segments only.

describe('blocked system paths match on segment boundaries', () => {
    it('still blocks the system roots and everything below them (unix)', () => {
        for (const [path, blocked] of [['/etc', '/etc'], ['/etc/passwd', '/etc'], ['/var/log/syslog', '/var'], ['/opt/xaventra', '/opt'], ['/private/var/db', '/private/var']]) {
            expect(matchesBlockedPath(path, blocked, false), path).toBe(true)
        }
    })

    it('no longer blocks look-alike names (unix)', () => {
        for (const [path, blocked] of [['/home/a/various/x.txt', '/var'], ['/home/a/library/x', '/lib'], ['/home/a/development/x', '/dev'], ['/home/a/options.json', '/opt'], ['/home/a/etcetera', '/etc'], ['/private/var/folders/x', '/var']]) {
            expect(matchesBlockedPath(path, blocked, false), path).toBe(false)
        }
    })

    it('blocks sensitive segments anywhere, but not look-alikes (unix)', () => {
        expect(matchesBlockedPath('/home/a/.ssh', '/.ssh', false)).toBe(true)
        expect(matchesBlockedPath('/home/a/.ssh/id_ed25519', '/.ssh', false)).toBe(true)
        expect(matchesBlockedPath('/home/a/.config/google-chrome/Default', '/.config/google-chrome', false)).toBe(true)
        expect(matchesBlockedPath('/home/a/.sshkeys-notes.txt', '/.ssh', false)).toBe(false)
    })

    it('handles Windows roots and segments case-insensitively', () => {
        expect(matchesBlockedPath('c:\\windows\\system32', 'C:\\Windows', true)).toBe(true)
        expect(matchesBlockedPath('C:\\WindowsApps\\x', 'C:\\Windows', true)).toBe(false)
        expect(matchesBlockedPath('C:\\Program Files (x86)\\x', 'C:\\Program Files (x86)', true)).toBe(true)
        expect(matchesBlockedPath('C:\\Users\\a\\.ssh\\config', '\\.ssh', true)).toBe(true)
        expect(matchesBlockedPath('C:\\Users\\a\\AppData\\Local\\Microsoft\\x', '\\AppData\\Local\\Microsoft', true)).toBe(true)
        expect(matchesBlockedPath('C:\\Users\\a\\AppData\\Local\\MicrosoftEdgeNotes', '\\AppData\\Local\\Microsoft', true)).toBe(false)
    })
})
