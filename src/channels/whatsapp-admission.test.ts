import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// R2 H-4 / M-3 / M-4 / N-6 regressions for the WhatsApp adapter. Before:
// Nova's own sends came back via `append` upserts and were answered, the
// owner's messages to third parties were processed, groups bypassed the
// allow-list and `mention-only` was never evaluated, only the first message of
// a batch was handled, the allow-list was a reversed substring test, and
// disconnect() unlinked the device via logout().

const fake = vi.hoisted(() => ({ sock: null as any }))
vi.mock('@whiskeysockets/baileys', () => ({
    default: () => {
        const ev = new EventEmitter()
        fake.sock = {
            ev,
            user: { id: '4366000000001:7@s.whatsapp.net' },
            end: vi.fn(),
            logout: vi.fn(async () => undefined),
            sendMessage: vi.fn(async () => ({ key: { id: 'SENT-1' } })),
        }
        return fake.sock
    },
    DisconnectReason: { loggedOut: 401 },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => undefined }),
}))

const { WhatsAppAdapter, normalizeWhatsAppNumber } = await import('./whatsapp.js')

const OWN = '4366000000001@s.whatsapp.net'
const FRIEND = '4366000000002@s.whatsapp.net'
const STRANGER = '4366000000003@s.whatsapp.net'
const GROUP = '120363000000000000@g.us'

let n = 0
function text(remoteJid: string, content: string, extra: { fromMe?: boolean; participant?: string; mentioned?: string[] } = {}) {
    return {
        key: { id: `M${++n}`, remoteJid, fromMe: Boolean(extra.fromMe), participant: extra.participant },
        messageTimestamp: 1_700_000_000,
        message: extra.mentioned
            ? { extendedTextMessage: { text: content, contextInfo: { mentionedJid: extra.mentioned } } }
            : { conversation: content },
    }
}

async function adapter(config: Record<string, unknown> = {}) {
    const instance = new WhatsAppAdapter({ authStatePath: '.nova-test-wa', allowFrom: ['+43 660 00000002'], ...config } as any)
    const received: any[] = []
    instance.onMessage(msg => received.push(msg))
    await instance.connect()
    const upsert = (type: string, ...messages: any[]) => fake.sock.ev.emit('messages.upsert', { type, messages })
    return { instance, received, upsert }
}

describe('WhatsApp admission (H-4, M-4, N-6)', () => {
    beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined) })

    it('normalizes numbers and JIDs to digits', () => {
        expect(normalizeWhatsAppNumber('+43 660 00000002')).toBe('4366000000002')
        expect(normalizeWhatsAppNumber('4366000000001:7@s.whatsapp.net')).toBe('4366000000001')
    })

    it('ignores append upserts (own sends, history sync)', async () => {
        const { received, upsert } = await adapter({ allowFrom: ['4366000000002'] })
        upsert('append', text(FRIEND, 'echo'))
        expect(received).toHaveLength(0)
    })

    it('never re-reads a message this adapter sent', async () => {
        // Even with the own number allow-listed, an echo of Nova's send is dropped.
        const { instance, received, upsert } = await adapter({ allowFrom: ['4366000000002', '4366000000001'] })
        fake.sock.sendMessage.mockResolvedValueOnce({ key: { id: 'OWN-SEND' } })
        ;(instance as any).state.connected = true
        await instance.send({ channel: 'whatsapp', to: FRIEND, content: 'hi' } as any)
        upsert('notify', { ...text(OWN, 'hi', { fromMe: true }), key: { id: 'OWN-SEND', remoteJid: OWN, fromMe: true } })
        expect(received).toHaveLength(0)
    })

    it('processes fromMe only in the self-chat', async () => {
        const { received, upsert } = await adapter()
        upsert('notify', text(FRIEND, 'owner writes to a friend', { fromMe: true }))
        expect(received).toHaveLength(0)
        upsert('notify', text(OWN, 'owner notes to self', { fromMe: true }))
        expect(received.map(m => m.content)).toEqual(['owner notes to self'])
    })

    it('admits DMs only from exact allow-list numbers, fail-closed when empty', async () => {
        const { received, upsert } = await adapter()
        upsert('notify', text(STRANGER, 'stranger'))
        upsert('notify', text('436600000000@s.whatsapp.net', 'substring of an allowed number'))
        upsert('notify', text(FRIEND, 'friend'))
        expect(received.map(m => m.content)).toEqual(['friend'])

        const closed = await adapter({ allowFrom: [] })
        closed.upsert('notify', text(FRIEND, 'friend'))
        expect(closed.received).toHaveLength(0)
    })

    it('handles every message of a batch', async () => {
        const { received, upsert } = await adapter()
        upsert('notify', text(FRIEND, 'one'), text(FRIEND, 'two'), text(FRIEND, 'three'))
        expect(received.map(m => m.content)).toEqual(['one', 'two', 'three'])
    })

    it('groups: allow-listed participant only, mention required, participant is the identity', async () => {
        const { received, upsert } = await adapter()
        upsert('notify', text(GROUP, 'hello all', { participant: FRIEND }))
        upsert('notify', text(GROUP, '@nova hi', { participant: STRANGER, mentioned: [OWN] }))
        expect(received).toHaveLength(0)
        upsert('notify', text(GROUP, '@nova hi', { participant: FRIEND, mentioned: [OWN] }))
        expect(received).toHaveLength(1)
        expect(received[0]).toMatchObject({ from: FRIEND, isGroup: true, groupId: GROUP })

        const denied = await adapter({ groupPolicy: 'deny' })
        denied.upsert('notify', text(GROUP, '@nova hi', { participant: FRIEND, mentioned: [OWN] }))
        expect(denied.received).toHaveLength(0)
    })
})

describe('WhatsApp disconnect (M-3)', () => {
    it('closes the socket without unlinking the device', async () => {
        const { instance } = await adapter()
        const sock = fake.sock
        await instance.disconnect()
        expect(sock.logout).not.toHaveBeenCalled()
        expect(sock.end).toHaveBeenCalled()
    })
})
