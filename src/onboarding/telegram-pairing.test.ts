import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramAdapter } from '../channels/telegram.js'
import { claimTelegramPairing, issueTelegramPairing, telegramPairingLink, telegramPairingStatus } from './telegram-pairing.js'

function installation(allowFrom: string[] = []) {
    const root = mkdtempSync(join(tmpdir(), 'xaventra-pairing-'))
    writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify({ provider: 'local', channels: { telegram: { enabled: true, token: '', allowFrom } } }), { mode: 0o600 })
    return root
}
const allowFromOf = (root: string) => JSON.parse(readFileSync(join(root, 'xaventra.config.json'), 'utf8')).channels.telegram.allowFrom
const T0 = Date.parse('2026-10-02T08:00:00.000Z')

afterEach(() => { delete process.env.NOVA_RUNTIME_ROOT; vi.restoreAllMocks() })

describe('Telegram koppeln per Einmal-Code (2.85 Paket B, Punkt 3)', () => {
    it('builds a t.me deep link and stores only a hash of the code', () => {
        const root = installation()
        const { code, expiresAt } = issueTelegramPairing({ root, now: T0, env: {} })
        expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/)
        expect(expiresAt).toBe('2026-10-02T08:10:00.000Z')
        expect(telegramPairingLink('example_bot', code)).toBe(`https://t.me/example_bot?start=${code}`)
        expect(readFileSync(join(root, '.nova-data', 'telegram-pairing.json'), 'utf8')).not.toContain(code)
        expect(() => telegramPairingLink('bad name', code)).toThrow()
    })

    it('binds the sender as owner exactly once', () => {
        const root = installation(['111'])
        const { code } = issueTelegramPairing({ root, now: T0, env: {} })
        const first = claimTelegramPairing(`/start ${code}`, { id: '222', username: 'example' }, { root, now: T0 + 60_000 })
        expect(first).toMatchObject({ handled: true, ok: true, userId: '222' })
        expect(allowFromOf(root)).toEqual(['111', '222'])
        expect(telegramPairingStatus(root, T0 + 60_000).pending).toBe(false)
        const again = claimTelegramPairing(`/start ${code}`, { id: '333' }, { root, now: T0 + 61_000 })
        expect(again).toMatchObject({ handled: true, ok: false })
        expect(allowFromOf(root)).toEqual(['111', '222'])
    })

    it('refuses wrong and expired codes without consuming a valid one', () => {
        const root = installation()
        const { code } = issueTelegramPairing({ root, now: T0, env: {} })
        expect(claimTelegramPairing('/start AAAAAAAAAAAAAAAAAAAAAAAA', { id: '222' }, { root, now: T0 })).toMatchObject({ handled: true, ok: false })
        expect(claimTelegramPairing(`/start ${code}`, { id: '222' }, { root, now: T0 + 11 * 60_000 })).toMatchObject({ handled: true, ok: false })
        expect(allowFromOf(root)).toEqual([])
        const fresh = issueTelegramPairing({ root, now: T0, env: {} })
        expect(claimTelegramPairing(`/start@example_bot ${fresh.code}`, { id: '222' }, { root, now: T0 + 1000 })).toMatchObject({ ok: true })
    })

    it('ignores groups, plain /start and installations without a pending code', () => {
        const root = installation()
        expect(claimTelegramPairing('/start AAAAAAAAAAAAAAAAAAAAAAAA', { id: '222' }, { root, now: T0 })).toEqual({ handled: false })
        const { code } = issueTelegramPairing({ root, now: T0, env: {} })
        expect(claimTelegramPairing(`/start ${code}`, { id: '222', isGroup: true }, { root, now: T0 })).toEqual({ handled: false })
        expect(claimTelegramPairing('/start', { id: '222' }, { root, now: T0 })).toEqual({ handled: false })
        expect(claimTelegramPairing('hallo', { id: '222' }, { root, now: T0 })).toEqual({ handled: false })
    })

    it('stays off when TELEGRAM_ALLOW_FROM already fixes the owner', () => {
        expect(() => issueTelegramPairing({ root: installation(), env: { TELEGRAM_ALLOW_FROM: '111' } })).toThrow(/TELEGRAM_ALLOW_FROM/)
    })

    it('the Telegram adapter pairs before its allowlist and never forwards the code to the pipeline', async () => {
        const root = installation(['111'])
        process.env.NOVA_RUNTIME_ROOT = root
        const persisted: unknown[] = []
        const adapter = new TelegramAdapter({ token: 'fixture', allowFrom: ['111'], verifyAuthority: async () => true, persistInbound: entry => { persisted.push(entry) } })
        const sendMessage = vi.fn(async () => ({ message_id: 1 }))
        ;(adapter as any).bot = (adapter as any).guardBotEffects({ sendMessage, sendChatAction: vi.fn(async () => undefined), setMessageReaction: vi.fn(async () => undefined) })
        const handler = vi.fn(async () => undefined)
        adapter.onMessage(handler)
        const { code } = issueTelegramPairing({ root, env: {} })
        const dm = (text: string) => ({ message_id: 7, date: 1, text, chat: { id: 222, type: 'private' }, from: { id: 222, username: 'example' } })
        ;(adapter as any).persistInboundSync(dm(`/start ${code}`))
        await (adapter as any).handleMessage(dm(`/start ${code}`))
        expect(handler).not.toHaveBeenCalled()
        expect(persisted).toEqual([])
        expect(sendMessage).toHaveBeenCalledWith('222', expect.stringContaining('Gekoppelt'))
        expect(allowFromOf(root)).toEqual(['111', '222'])
        await (adapter as any).handleMessage({ ...dm('Hallo'), message_id: 8 })
        expect(handler).toHaveBeenCalledTimes(1)
    })
})
