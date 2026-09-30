import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acceptsYes, findNpmCli, planWorkstationDesktop, resolveWorkstationDesktopChoice, seedConfiguration,
    WORKSTATION_DESKTOP_PACKAGES, WORKSTATION_DESKTOP_PROGRAMS } from '../../scripts/setup.mjs'
import { DBUS_RUN_SESSION, XFCE_SESSION } from '../host/workstation-desktop.js'

describe('portable source installer', () => {
    it('locates npm without a shell command or platform-specific quoting', () => {
        expect(findNpmCli()).toMatch(/npm-cli\.js$/)
    })
    it('seeds private inert configuration and preserves credentials on rerun', () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra setup spaces-'))
        const configPath = seedConfiguration(root)
        const config = JSON.parse(readFileSync(configPath, 'utf8'))
        expect(config.name).toBe('Xaventra')
        expect(config.mesh.update.nodes).toEqual([])
        expect(config.server.host).toBe('127.0.0.1')
        const env = readFileSync(join(root, '.env'), 'utf8')
        expect(env).toMatch(/NOVA_API_TOKEN=[a-f0-9]{64}/)
        seedConfiguration(root)
        expect(readFileSync(join(root, '.env'), 'utf8')).toBe(env)
    })
    it('never migrates or overwrites an existing legacy configuration', () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra-legacy-'))
        const config = join(root, 'nova.config.json')
        writeFileSync(config, '{"name":"existing"}')
        expect(seedConfiguration(root)).toBe(config)
        expect(readFileSync(config, 'utf8')).toBe('{"name":"existing"}')
    })
})

describe('optional workstation desktop (XFCE, Linux only)', () => {
    const has = (...paths: string[]) => (path: string) => paths.includes(path)
    it('checks exactly the programs the workstation needs to start XFCE', () => {
        expect(WORKSTATION_DESKTOP_PROGRAMS).toEqual([XFCE_SESSION, DBUS_RUN_SESSION])
        expect(WORKSTATION_DESKTOP_PACKAGES).toEqual(['xfce4', 'xfce4-terminal', 'thunar', 'dbus-x11'])
    })
    it('is never offered or installed outside Linux', () => {
        for (const platform of ['win32', 'darwin']) {
            expect(planWorkstationDesktop({ platform, isRoot: true, exists: () => true }).action).toBe('skip')
            expect(resolveWorkstationDesktopChoice([], { platform, interactive: true })).toBe('skip')
        }
    })
    it('does nothing when XFCE is already installed', () => {
        expect(planWorkstationDesktop({ platform: 'linux', isRoot: true, exists: has(XFCE_SESSION, DBUS_RUN_SESSION, '/usr/bin/apt-get') }).action).toBe('present')
    })
    it('installs without recommends via apt-get, through sudo when not root', () => {
        const base = ['apt-get', 'install', '-y', '--no-install-recommends', 'xfce4', 'xfce4-terminal', 'thunar', 'dbus-x11']
        expect(planWorkstationDesktop({ platform: 'linux', isRoot: true, exists: has('/usr/bin/apt-get') }))
            .toEqual({ action: 'install', command: base })
        expect(planWorkstationDesktop({ platform: 'linux', isRoot: false, exists: has('/usr/bin/apt-get', '/usr/bin/sudo') }))
            .toEqual({ action: 'install', command: ['sudo', ...base] })
    })
    it('refuses instead of guessing without apt-get or root rights', () => {
        expect(planWorkstationDesktop({ platform: 'linux', isRoot: true, exists: () => false }).action).toBe('unsupported')
        expect(planWorkstationDesktop({ platform: 'linux', isRoot: false, exists: has('/usr/bin/apt-get') }).action).toBe('unsupported')
    })
    it('is opt-in: flags win, only an interactive Linux terminal is asked, default no', () => {
        expect(resolveWorkstationDesktopChoice(['--workstation-desktop'], { platform: 'linux' })).toBe('install')
        expect(resolveWorkstationDesktopChoice(['--no-workstation-desktop'], { platform: 'linux', interactive: true })).toBe('skip')
        expect(resolveWorkstationDesktopChoice([], { platform: 'linux', interactive: false })).toBe('skip')
        expect(resolveWorkstationDesktopChoice([], { platform: 'linux', interactive: true })).toBe('ask')
        expect(resolveWorkstationDesktopChoice(['--check'], { platform: 'linux', interactive: true })).toBe('skip')
        expect(() => resolveWorkstationDesktopChoice(['--workstation-desktop', '--no-workstation-desktop'])).toThrow()
        expect(acceptsYes('')).toBe(false)
        expect(acceptsYes('n')).toBe(false)
        for (const yes of ['y', 'yes', 'j', 'Ja ']) expect(acceptsYes(yes)).toBe(true)
    })
})
