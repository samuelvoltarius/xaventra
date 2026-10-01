import { describe, expect, it, vi } from 'vitest'

const users = vi.hoisted(() => ({ initMultiUser: vi.fn(), getOrCreateUser: vi.fn(), setUserPermission: vi.fn() }))
vi.mock('../users/multi-user-middleware.js', () => users)

import { createEvenG2RuntimeDeps, numericOwnerIds } from './even-g2-runtime.js'
import { EVEN_G2_CHANNEL, EVEN_G2_PRINCIPAL } from './even-g2.js'

const TOKEN = `g2-test-${'x'.repeat(32)}`

describe('Even G2 runtime wiring', () => {
    it('runs the normal pipeline as channel even-g2 with the owner principal', async () => {
        const handleMessage = vi.fn(async (_c, _f, _q, reply: (m: string) => Promise<void>) => { await reply('Zwischenstand'); await reply('Endgültig') })
        const deps = createEvenG2RuntimeDeps(TOKEN, { handleMessage, ownerIds: () => ['100200300'], sendTelegram: vi.fn() })
        const controller = new AbortController()
        expect(await deps.ask('Hallo', controller.signal)).toBe('Endgültig')
        expect(handleMessage).toHaveBeenCalledTimes(1)
        const [channel, from, content, , image, execution, context] = handleMessage.mock.calls[0] as any[]
        expect([channel, from, content, image]).toEqual([EVEN_G2_CHANNEL, EVEN_G2_PRINCIPAL, 'Hallo', undefined])
        expect(execution.abortSignal).toBe(controller.signal)
        expect(context).toEqual({ chatId: EVEN_G2_PRINCIPAL })
        expect(users.getOrCreateUser).toHaveBeenCalledWith(EVEN_G2_PRINCIPAL, EVEN_G2_CHANNEL, 'Even G2')
        expect(users.setUserPermission).toHaveBeenCalledWith(EVEN_G2_PRINCIPAL, 'owner')
    })

    it('late answers go to the first Telegram owner, nowhere without owner', async () => {
        const sendTelegram = vi.fn(async () => undefined)
        const deps = createEvenG2RuntimeDeps(TOKEN, { handleMessage: vi.fn(), ownerIds: () => ['100200300', '400500600'], sendTelegram })
        await deps.overflow('Recherche', 'Ergebnis')
        expect(sendTelegram).toHaveBeenCalledTimes(1)
        expect(sendTelegram.mock.calls[0][0]).toBe('100200300')
        expect(sendTelegram.mock.calls[0][1]).toContain('Recherche')
        expect(sendTelegram.mock.calls[0][1]).toContain('Ergebnis')
        const none = vi.fn()
        await createEvenG2RuntimeDeps(TOKEN, { handleMessage: vi.fn(), ownerIds: () => [], sendTelegram: none }).overflow('a', 'b')
        expect(none).not.toHaveBeenCalled()
    })

    it('owner ids are numeric allowFrom entries only', () => {
        expect(numericOwnerIds({ channels: { telegram: { allowFrom: ['100200300', '@name', 7] } } })).toEqual(['100200300', '7'])
        expect(numericOwnerIds({})).toEqual([])
    })
})
