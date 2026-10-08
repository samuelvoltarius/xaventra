import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 2.89.4 Fix 1 over the real Telegram inbound (startTelegram → presentation → adapter):
// after the answer is delivered the progress card is deleted ("✅ Fertig · N s" stood
// BEFORE the reply and read like an empty answer). Only the transport records.

const mocks = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn() }))
vi.mock('../mesh/leader-election.js', () => ({
    MAIN_SERVICE: 'nova-main', shouldStartExclusiveService: async () => true,
    verifyLiveServiceLeadership: mocks.verify, watchForServiceLeadership: vi.fn(),
    onLeadershipLost: vi.fn(() => () => undefined), stopLeaseRenewal: vi.fn(),
}))
vi.mock('./ha-state.js', () => ({
    isHaStateAvailable: async () => false, hydrateChannelState: vi.fn(), publishChannelState: async () => true,
    readHaRecords: async () => [], writeHaRecord: async () => true,
}))
vi.mock('../channels/telegram.js', () => ({ createTelegramAdapter: mocks.create, connectL15NotifyCallback: vi.fn() }))
vi.mock('./runtime-readiness.js', () => ({ awaitRuntimeReady: async () => undefined }))
vi.mock('../tools/reminder-tool.js', () => ({ setReminderNotifyCallback: vi.fn(), setReminderWakeupCallback: vi.fn(), initReminders: vi.fn() }))
vi.mock('./runtime-event-log.js', () => ({ logRuntimeEvent: vi.fn() }))

async function startHarness(replies: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'nova-tg-card-'))
    mkdirSync(join(dir, '.nova-data'), { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    let onMessage: ((msg: any) => Promise<void>) | undefined
    const sent: string[] = []
    const progress: string[] = []
    const edits: Array<{ id: number; text: string }> = []
    const deleted: number[] = []
    mocks.create.mockImplementation(() => ({
        onMessage: (handler: any) => { onMessage = handler },
        connect: async () => undefined, disconnect: async () => undefined, getUsername: () => 'test-bot',
        send: async (_msg: any) => { sent.push(String(_msg?.content ?? '')); return { ok: true } },
        sendProgress: async (_chatId: string, text: string) => { progress.push(String(text)); return 42 },
        editMessage: async (_chatId: string, messageId: number, text: string) => { edits.push({ id: messageId, text: String(text) }) },
        deleteMessage: async (_chatId: string, messageId: number) => { deleted.push(messageId) },
    }))
    const { startTelegram } = await import('./daemon-channels.js')
    const handler = vi.fn(async (_c: string, _f: string, _t: string, reply: (text: string) => Promise<void>) => {
        for (const line of replies) await reply(line)
    })
    await startTelegram({ enabled: true, token: 'synthetic' }, handler as any, { channels: { telegram: null, whatsapp: null, discord: null } })
    return { handler, deliver: (msg: any) => onMessage!(msg), sent, progress, edits, deleted }
}

beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NOVA_NODE_ONLY', 'false')
    vi.stubEnv('NOVA_NO_TELEGRAM', 'false')
    vi.stubEnv('NOVA_TELEGRAM_MODE', 'primary')
    mocks.verify.mockResolvedValue(true)
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('2.89.4 Live-Statuskarte is removed after the answer (real Telegram inbound)', () => {
    it('deletes the progress message once the reply is delivered', async () => {
        const t = await startHarness(['⚙️ Schritt 1/2: Werkzeuge', 'Hier ist die Antwort.'])
        await t.deliver({ id: 'tg-update:1', from: '9', to: '100', content: 'mach mal' })
        expect(t.progress.length).toBeGreaterThan(0)
        expect(t.sent).toEqual(['Hier ist die Antwort.'])
        // The ✅ line is never written before the answer — the card is gone instead.
        expect(t.deleted).toEqual([42])
        expect(t.edits.some(edit => /^✅/.test(edit.text))).toBe(false)
    })

    it('keeps one ❌ line with the reason when the run fails', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nova-tg-card-fail-'))
        mkdirSync(join(dir, '.nova-data'), { recursive: true })
        vi.spyOn(process, 'cwd').mockReturnValue(dir)
        let onMessage: ((msg: any) => Promise<void>) | undefined
        const edits: Array<{ id: number; text: string }> = []
        const deleted: number[] = []
        mocks.create.mockImplementation(() => ({
            onMessage: (handler: any) => { onMessage = handler },
            connect: async () => undefined, disconnect: async () => undefined, getUsername: () => 'test-bot',
            send: async () => ({ ok: true }),
            sendProgress: async () => 42,
            editMessage: async (_chatId: string, messageId: number, text: string) => { edits.push({ id: messageId, text: String(text) }) },
            deleteMessage: async (_chatId: string, messageId: number) => { deleted.push(messageId) },
        }))
        const { startTelegram } = await import('./daemon-channels.js')
        const handler = vi.fn(async (_c: string, _f: string, _t: string, reply: (text: string) => Promise<void>) => {
            await reply('⚙️ Schritt 1/2: scan')
            throw new Error('scan aborted')
        })
        await startTelegram({ enabled: true, token: 'synthetic' }, handler as any, { channels: { telegram: null, whatsapp: null, discord: null } })
        await expect(onMessage!({ id: 'tg-update:2', from: '9', to: '100', content: 'scan' })).rejects.toThrow()
        expect(deleted).toEqual([])
        expect(edits.at(-1)?.text).toMatch(/^❌/)
    })
})
