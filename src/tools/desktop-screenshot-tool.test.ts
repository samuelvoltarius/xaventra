import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ capture: vi.fn(), send: vi.fn(), write: vi.fn(), exec: vi.fn() }))
vi.mock('node:child_process', () => ({ execSync: mocks.exec }))
vi.mock('../host/capture-agent.js', () => ({ requestSessionCapture: mocks.capture }))
vi.mock('../desktop/desktop-agent-context.js', () => ({ getDesktopAgentContext: () => undefined }))
vi.mock('./send-file-tool.js', () => ({ executeSendFile: mocks.send }))
vi.mock('node:fs', () => ({ existsSync: () => true, mkdirSync: vi.fn(), writeFileSync: mocks.write,
    readFileSync: () => Buffer.from('fixture-image') }))
import { desktopScreenshotTool } from './desktop-screenshot-tool.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'
const owner = { channel: 'telegram', authUserId: '123', runId: 'run-1' }

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NOVA_CAPTURE_SOCKET', '/fixture/capture.sock')
    vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '/fixture/token')
    // Defense in depth (H1): the handler itself requires the enrolled owner.
    vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID', '123')
    mocks.capture.mockResolvedValue(Buffer.from('fixture-image'))
    mocks.send.mockResolvedValue('✅ Foto gesendet: **fixture.png** (1 KB)')
})
afterEach(() => vi.unstubAllEnvs())
it.each(['telegram', 'Telegram'])('sends on %s only to the authenticated initiating user, not a model-supplied recipient', async channel => {
    const result = await withExecutionPolicyContext({ channel, authUserId: '123', runId: 'run-1' }, () =>
        desktopScreenshotTool.handler({ name: 'fixture', chat_id: '999' }))
    expect(result).toMatchObject({ success: true, captured: true, delivered: true })
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ chat_id: '123' }))
})
it.each(['rest', 'discord', ''])('does not send across the %s channel boundary', async channel => {
    const result = await withExecutionPolicyContext({ channel, authUserId: '123', runId: 'run-1' }, () =>
        desktopScreenshotTool.handler({ name: 'fixture', channel: 'telegram', chat_id: '999' }))
    expect(result).toMatchObject({ success: false, delivered: false })
    expect(mocks.send).not.toHaveBeenCalled()
})
it('retains capture but fails completion when delivery fails', async () => {
    mocks.send.mockResolvedValue('❌ Telegram nicht verbunden.')
    const result = await withExecutionPolicyContext(owner, () =>
        desktopScreenshotTool.handler({ name: 'fixture' }))
    expect(result).toMatchObject({ success: false, captured: true, delivered: false })
})
it('does not use last-active Telegram chat when authenticated recipient is missing', async () => {
    expect(await desktopScreenshotTool.handler({ name: 'fixture' })).toMatchObject({ success: false, delivered: false })
    expect(mocks.send).not.toHaveBeenCalled()
})
it('supports capture-only without claiming delivery', async () => {
    // Adapted for H1: capture-only still needs the enrolled owner context.
    expect(await withExecutionPolicyContext(owner, () => desktopScreenshotTool.handler({ name: 'fixture', send: false })))
        .toMatchObject({ success: true, captured: true, delivered: false })
    expect(mocks.send).not.toHaveBeenCalled()
})
it('does not fall back to another capture path after adapter denial', async () => {
    mocks.capture.mockRejectedValue(new Error('Desktop session locked'))
    expect(await withExecutionPolicyContext(owner, () => desktopScreenshotTool.handler({ name: 'fixture' }))).toMatchObject({ success: false })
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
})
it('rejects filename traversal and shell syntax before capture', async () => {
    for (const name of ['../private', 'bad";command', 'a/b']) {
        expect(await desktopScreenshotTool.handler({ name })).toMatchObject({ success: false })
    }
    expect(mocks.capture).not.toHaveBeenCalled()
})
it.each([
    ['no execution context (direct caller bypassing the governed executor)', undefined],
    ['a different Telegram principal', { channel: 'telegram', authUserId: '999', runId: 'run-1' }],
    ['the owner on a non-Telegram channel', { channel: 'cli', authUserId: '123', runId: 'run-1' }],
    ['the owner without a run', { channel: 'telegram', authUserId: '123' }],
])('refuses capture for %s', async (_label, context) => {
    const run = () => desktopScreenshotTool.handler({ name: 'fixture', send: false })
    const result = context ? await withExecutionPolicyContext(context, run) : await run()
    expect(result).toMatchObject({ success: false })
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
})
it('refuses capture when the owner opt-in is not configured', async () => {
    vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID', '')
    expect(await withExecutionPolicyContext(owner, () => desktopScreenshotTool.handler({ name: 'fixture', send: false })))
        .toMatchObject({ success: false })
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.exec).not.toHaveBeenCalled()
})
it.each([['socket only', 'NOVA_CAPTURE_TOKEN_FILE'], ['token only', 'NOVA_CAPTURE_SOCKET']])(
    'never captures the local display when workstation enrollment is partially configured (%s)', async (_label, unset) => {
    vi.stubEnv(unset, '')
    mocks.capture.mockRejectedValue(new Error('An enrolled local capture socket is required'))
    expect(await withExecutionPolicyContext(owner, () => desktopScreenshotTool.handler({ name: 'fixture', send: false })))
        .toMatchObject({ success: false })
    expect(mocks.exec).not.toHaveBeenCalled()
})
// INT-4: the owner path without an enrolled capture adapter used to capture
// the daemon's local display. It must refuse instead.
it('refuses the owner without an enrolled capture adapter and never captures the local display', async () => {
    vi.stubEnv('NOVA_CAPTURE_SOCKET', '')
    vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '')
    const result = await withExecutionPolicyContext(owner, () => desktopScreenshotTool.handler({ name: 'fixture' }))
    expect(result).toEqual({ success: false, captured: false, delivered: false, error: 'no enrolled capture adapter; local capture disabled' })
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
})

// Live 30.09.2026: the model passed the name of an earlier capture from the
// conversation ("desktop_1790796410061"); the exclusive write failed with EEXIST.
it('writes every capture to a fresh file even when the model repeats a name', async () => {
    const reused = 'desktop_1790796410061'
    for (let i = 0; i < 2; i++) {
        expect(await withExecutionPolicyContext(owner, () => desktopScreenshotTool.handler({ name: reused, send: false })))
            .toMatchObject({ success: true, captured: true })
    }
    const paths = mocks.write.mock.calls.map(call => String(call[0]))
    expect(paths).toHaveLength(2)
    expect(new Set(paths).size).toBe(2)
    for (const path of paths) expect(path).toMatch(/desktop_1790796410061_\d+_[0-9a-f]{8}\.png$/)
    for (const call of mocks.write.mock.calls) expect(call[2]).toMatchObject({ flag: 'wx' })
})
