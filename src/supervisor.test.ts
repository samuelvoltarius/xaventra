import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// R2 core-n-z #8 and #23 (supervisor):
// - the HTTP API has no CORS * and requires the Bearer token except /health,
// - a heartbeat right after boot does not reset the restart budget.

const childProcess = vi.hoisted(() => ({
    spawn: vi.fn(() => { throw new Error('spawn must not run in this test') }),
}))
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<any>()), spawn: childProcess.spawn }))

import { handleCrash, handleRequest, receiveHeartbeat, setSupervisorTokenForTest, supervisorState } from './supervisor.js'

const TOKEN = 'a'.repeat(64)

function call(method: string, url: string, headers: Record<string, string> = {}, body = '') {
    const req = Object.assign(new EventEmitter(), { method, url, headers }) as any
    const res: any = { headers: {} as Record<string, string>, status: 0, body: '' }
    res.setHeader = (key: string, value: string) => { res.headers[key.toLowerCase()] = value }
    res.writeHead = (status: number) => { res.status = status; return res }
    res.end = (chunk?: string) => { res.body = chunk || '' }
    handleRequest(req, res)
    req.emit('data', body)
    req.emit('end')
    return res
}

beforeEach(() => {
    setSupervisorTokenForTest(TOKEN)
    supervisorState.status = 'running'
    supervisorState.restartCount = 3
    supervisorState.startTime = Date.now()
    supervisorState.lastHeartbeat = 0
})

describe('supervisor API authentication (R2 NZ-8)', () => {
    it('sends no wildcard CORS header', () => {
        const res = call('GET', '/health')
        expect(res.status).toBe(200)
        expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it.each([
        ['POST', '/api/nova/stop'],
        ['POST', '/api/nova/restart'],
        ['POST', '/api/nova/start'],
        ['POST', '/api/heartbeat'],
        ['GET', '/api/status'],
        ['GET', '/api/logs'],
    ])('rejects %s %s without the token', (method, url) => {
        expect(call(method, url).status).toBe(401)
        expect(call(method, url, { authorization: 'Bearer wrong' }).status).toBe(401)
        expect(supervisorState.status).toBe('running')
    })

    it('accepts a heartbeat with the token and ignores forged ones', () => {
        call('POST', '/api/heartbeat', {}, '{}')
        expect(supervisorState.lastHeartbeat).toBe(0)
        const res = call('POST', '/api/heartbeat', { authorization: `Bearer ${TOKEN}` }, '{}')
        expect(res.status).toBe(200)
        expect(supervisorState.lastHeartbeat).toBeGreaterThan(0)
    })
})

describe('restart budget (R2 NZ-23)', () => {
    it('does not reset the restart counter on the first heartbeat after boot', () => {
        receiveHeartbeat()
        expect(supervisorState.restartCount).toBe(3)
    })

    it('terminates a hanging adopted daemon instead of re-adopting it', () => {
        vi.useFakeTimers()
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
        try {
            supervisorState.novaProcess = null
            supervisorState.adoptedPid = 424242
            supervisorState.restartCount = 0
            handleCrash('Heartbeat timeout confirmed')
            expect(kill).toHaveBeenCalledWith(424242, 'SIGTERM')
            expect(supervisorState.rejectedPid).toBe(424242)
            expect(supervisorState.adoptedPid).toBeNull()
        } finally {
            supervisorState.status = 'stopped'
            vi.clearAllTimers()
            vi.useRealTimers()
            kill.mockRestore()
        }
    })

    it('resets it after stable uptime', () => {
        supervisorState.startTime = Date.now() - 11 * 60_000
        receiveHeartbeat()
        expect(supervisorState.restartCount).toBe(0)
    })
})
