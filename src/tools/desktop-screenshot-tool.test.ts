import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ capture: vi.fn(), send: vi.fn(), write: vi.fn() }))
vi.mock('../host/capture-agent.js', () => ({ requestSessionCapture: mocks.capture }))
vi.mock('../desktop/desktop-agent-context.js', () => ({ getDesktopAgentContext: () => undefined }))
vi.mock('./send-file-tool.js', () => ({ executeSendFile: mocks.send }))
vi.mock('node:fs', () => ({ existsSync: () => true, mkdirSync: vi.fn(), writeFileSync: mocks.write,
    readFileSync: () => Buffer.from('fixture-image') }))
import { desktopScreenshotTool } from './desktop-screenshot-tool.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NOVA_CAPTURE_SOCKET', '/fixture/capture.sock')
    vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '/fixture/token')
    mocks.capture.mockResolvedValue(Buffer.from('fixture-image'))
    mocks.send.mockResolvedValue('✅ Foto gesendet: **fixture.png** (1 KB)')
})
afterEach(() => vi.unstubAllEnvs())
it.each(['telegram', 'Telegram'])('sends on %s only to the authenticated initiating user, not a model-supplied recipient', async channel => {
    const result = await withExecutionPolicyContext({ channel, authUserId: '123' }, () =>
        desktopScreenshotTool.handler({ name: 'fixture', chat_id: '999' }))
    expect(result).toMatchObject({ success: true, captured: true, delivered: true })
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ chat_id: '123' }))
})
it.each(['rest', 'discord', ''])('does not send across the %s channel boundary', async channel => {
    const result = await withExecutionPolicyContext({ channel, authUserId: '123' }, () =>
        desktopScreenshotTool.handler({ name: 'fixture', channel: 'telegram', chat_id: '999' }))
    expect(result).toMatchObject({ success: false, delivered: false })
    expect(mocks.send).not.toHaveBeenCalled()
})
it('retains capture but fails completion when delivery fails', async () => {
    mocks.send.mockResolvedValue('❌ Telegram nicht verbunden.')
    const result = await withExecutionPolicyContext({ channel: 'telegram', authUserId: '123' }, () =>
        desktopScreenshotTool.handler({ name: 'fixture' }))
    expect(result).toMatchObject({ success: false, captured: true, delivered: false })
})
it('does not use last-active Telegram chat when authenticated recipient is missing', async () => {
    expect(await desktopScreenshotTool.handler({ name: 'fixture' })).toMatchObject({ success: false, delivered: false })
    expect(mocks.send).not.toHaveBeenCalled()
})
it('supports capture-only without claiming delivery', async () => {
    expect(await desktopScreenshotTool.handler({ name: 'fixture', send: false })).toMatchObject({ success: true, captured: true, delivered: false })
    expect(mocks.send).not.toHaveBeenCalled()
})
it('does not fall back to another capture path after adapter denial', async () => {
    mocks.capture.mockRejectedValue(new Error('Desktop session locked'))
    expect(await desktopScreenshotTool.handler({ name: 'fixture' })).toMatchObject({ success: false })
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
})
it('rejects filename traversal and shell syntax before capture', async () => {
    for (const name of ['../private', 'bad";command', 'a/b']) {
        expect(await desktopScreenshotTool.handler({ name })).toMatchObject({ success: false })
    }
    expect(mocks.capture).not.toHaveBeenCalled()
})
