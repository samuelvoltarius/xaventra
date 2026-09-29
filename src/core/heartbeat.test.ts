import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const schedule = vi.hoisted(() => vi.fn(async (_id: string, _expr: string, _name: string, _handler: () => Promise<void>) => ({})))
const admin = vi.hoisted(() => ({ chatId: null as string | null }))
vi.mock('./croner-scheduler.js', () => ({ getCronerScheduler: () => ({ schedule }) }))
vi.mock('../tools/reminder-tool.js', () => ({ getAdminChatId: () => admin.chatId }))

const configFile = () => join(process.cwd(), 'xaventra.config.json')
let originalConfig = ''

async function load(heartbeat: { enabled: boolean; intervalMinutes: number }) {
    vi.resetModules()
    writeFileSync(configFile(), JSON.stringify({ ...JSON.parse(originalConfig), heartbeat }))
    return import('./heartbeat.js')
}

beforeEach(() => {
    originalConfig = readFileSync(configFile(), 'utf8')
    schedule.mockClear()
    admin.chatId = null
    mkdirSync(join(process.cwd(), '.nova-data'), { recursive: true })
    rmSync(join(process.cwd(), '.nova-data', 'heartbeat-log.json'), { force: true })
})
afterEach(() => {
    writeFileSync(configFile(), originalConfig)
    vi.useRealTimers()
})

describe('heartbeat scheduling (R2 A10)', () => {
    it('reschedules the checker when the interval changes', async () => {
        const heartbeat = await load({ enabled: true, intervalMinutes: 5 })
        await heartbeat.initHeartbeat()
        expect(schedule).toHaveBeenLastCalledWith('heartbeat-checker', '0 */5 * * * *', expect.any(String), expect.any(Function))
        heartbeat.handleHeartbeatCommand('1')
        await vi.waitFor(() => expect(schedule).toHaveBeenLastCalledWith('heartbeat-checker', '0 */1 * * * *', expect.any(String), expect.any(Function)))
    })

    it('starts the checker when enabled at runtime after a disabled boot', async () => {
        const heartbeat = await load({ enabled: false, intervalMinutes: 5 })
        await heartbeat.initHeartbeat()
        expect(schedule).not.toHaveBeenCalled()
        heartbeat.handleHeartbeatCommand('on')
        await vi.waitFor(() => expect(schedule).toHaveBeenCalledWith('heartbeat-checker', '0 */5 * * * *', expect.any(String), expect.any(Function)))
    })
})

describe('heartbeat execution (R2 A17)', () => {
    it('keeps a routine due when no admin chat is known yet', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(2026, 8, 29, 8, 1, 0))
        writeFileSync(join(process.cwd(), '.nova-data', 'heartbeat.md'), '08:00 | Fixture routine\n')
        const heartbeat = await load({ enabled: true, intervalMinutes: 5 })
        const wakeup = vi.fn(async () => { })
        heartbeat.setHeartbeatWakeupCallback(wakeup)
        await heartbeat.initHeartbeat()
        const check = schedule.mock.calls.at(-1)![3]
        await check()
        expect(wakeup).not.toHaveBeenCalled()
        admin.chatId = 'owner-chat'
        await check()
        expect(wakeup).toHaveBeenCalledOnce()
    })
})
