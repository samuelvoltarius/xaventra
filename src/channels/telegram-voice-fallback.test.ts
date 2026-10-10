import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// When local Whisper fails, the voice handler must not resolve/install a
// capability or run a remote shell command. The old fallback ran
// `${sshPrefix} 'python3 -c ...'` through a local shell, transcribed the
// remote "/tmp/" directory instead of the (never uploaded) voice file and fed
// the stdout ("done") into the pipeline as if the user had said it.

const cp = vi.hoisted(() => ({
    execSync: vi.fn(() => Buffer.from('done')),
    execFileSync: vi.fn(() => Buffer.from('ok')),
    exec: vi.fn(),
    execFile: vi.fn(),
    spawn: vi.fn(),
}))
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<any>()), ...cp }))
vi.mock('child_process', async importOriginal => ({ ...(await importOriginal<any>()), ...cp }))
vi.mock('../voice/voice-input.js', () => ({ transcribe: vi.fn(async () => { throw new Error('whisper missing') }) }))
const router = vi.hoisted(() => ({ resolveCapability: vi.fn() }))
vi.mock('../intelligence/capability-router.js', async importOriginal => ({ ...(await importOriginal<any>()), resolveCapability: router.resolveCapability }))
vi.mock('../core/llm-factory.js', () => ({ availableLLMs: [], createLLM: vi.fn() }))

import { TelegramAdapter } from './telegram.js'

beforeEach(() => {
    for (const fn of Object.values(cp)) fn.mockClear()
    router.resolveCapability.mockReset()
    router.resolveCapability.mockResolvedValue({
        node: { id: 'spark', ip: '100.64.0.10', hostname: 'spark', platform: 'linux' },
        installed: false, runRemotely: true, sshPrefix: 'ssh -o StrictHostKeyChecking=accept-new xaventra@100.64.0.10',
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) })))
})
afterEach(() => vi.unstubAllGlobals())

describe('Telegram voice fallback without local Whisper', () => {
    it('neither resolves/installs a capability nor runs a remote shell, and injects no fake transcript', async () => {
        const instance = new TelegramAdapter({ token: 'fixture', verifyAuthority: async () => true })
        const bot = {
            getFile: vi.fn(async () => ({ file_path: 'voice/file.oga' })),
            sendMessage: vi.fn(async () => ({ message_id: 1 })),
            sendChatAction: vi.fn(async () => true),
        }
        ;(instance as any).bot = bot
        const handler = vi.fn()
        instance.onMessage(handler)

        await (instance as any).handleVoiceMessage({
            message_id: 5, date: 1, chat: { id: 222, type: 'private' }, from: { id: 222 }, voice: { file_id: 'f1' },
        })

        expect(router.resolveCapability).not.toHaveBeenCalled()
        expect(cp.execSync).not.toHaveBeenCalled()
        expect(cp.exec).not.toHaveBeenCalled()
        expect(handler).not.toHaveBeenCalled()
        expect(bot.sendMessage).toHaveBeenCalled()
    })
})
