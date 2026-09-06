import { afterEach, describe, expect, it, vi } from 'vitest'
import { Server } from 'node:net'
import { initAllnovaModules, initGatewayLayer } from './nova-integration.js'

vi.mock('../tools/browser.js', () => ({ getBrowser: () => ({}) }))
vi.mock('../tools/media.js', () => ({ getMediaAnalyzer: () => ({}) }))
afterEach(() => vi.restoreAllMocks())

describe('single governed HTTP ingress', () => {
    it('does not open a parallel unauthenticated listener on a Main', async () => {
        const listener = vi.spyOn(Server.prototype, 'listen').mockImplementation(() => { throw new Error('Unexpected side listener') })
        await initAllnovaModules()
        expect(listener).not.toHaveBeenCalled()
    })

    it('refuses direct legacy initialization instead of bypassing the kernel', async () => {
        await expect(initGatewayLayer(3002)).rejects.toThrow('authenticated daemon REST API')
    })
})
