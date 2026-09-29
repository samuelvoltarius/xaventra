import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextRestartCount, NovaWatchdog } from './nova-watchdog.js'

// MI-15: health checkers must not pile up per restart, the restart API must
// not be reachable from the network, and restart accounting must be sane.

const instances: any[] = []
afterEach(async () => {
    for (const watchdog of instances.splice(0)) {
        for (const timer of watchdog.healthCheckers.values()) clearInterval(timer)
        await new Promise<void>(resolve => watchdog.healthServer ? watchdog.healthServer.close(() => resolve()) : resolve())
    }
})

function watchdog(): any {
    const instance = new NovaWatchdog({ logDir: mkdtempSync(join(tmpdir(), 'nova-mi15-')), healthPort: 0, daemons: [] }) as any
    instances.push(instance)
    return instance
}

describe('MI-15 nova-watchdog', () => {
    it('replaces the health checker on restart instead of adding another', () => {
        const instance = watchdog()
        const clear = vi.spyOn(globalThis, 'clearInterval')
        const daemon = { name: 'nova', healthEndpoint: 'http://127.0.0.1:1/health', healthInterval: 60_000 }
        instance.startHealthChecker(daemon)
        const first = instance.healthCheckers.get('nova')
        instance.startHealthChecker(daemon)
        expect(clear).toHaveBeenCalledWith(first)
        expect(instance.healthCheckers.size).toBe(1)
        clear.mockRestore()
    })

    it('binds the unauthenticated status/restart API to loopback', async () => {
        const instance = watchdog()
        instance.startHealthServer()
        await new Promise(resolve => instance.healthServer.listening ? resolve(null) : instance.healthServer.once('listening', resolve))
        expect((instance.healthServer.address() as AddressInfo).address).toBe('127.0.0.1')
    })

    it('counts only real crashes and resets the budget after a stable run', () => {
        const now = 1_000_000_000
        expect(nextRestartCount(3, now - 1000, now, 1)).toBe(4)
        expect(nextRestartCount(3, now - 1000, now, null)).toBe(3)
        expect(nextRestartCount(9, now - 11 * 60_000, now, 1)).toBe(1)
    })
})
