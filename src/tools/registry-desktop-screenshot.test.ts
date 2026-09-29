import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    execSync: vi.fn(),
    capture: vi.fn(async () => Buffer.from('89504e47', 'hex')),
    send: vi.fn(async (_params: Record<string, unknown>) => '✅ Foto gesendet: shot.png'),
}))
vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    execSync: mocks.execSync,
}))
vi.mock('../host/capture-agent.js', () => ({ requestSessionCapture: mocks.capture }))
vi.mock('./send-file-tool.js', () => ({ executeSendFile: mocks.send }))

import { ToolRegistry, registerBuiltinTools } from './registry.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

const owner = { channel: 'telegram', authUserId: '123', runId: 'r1' }

function legacyScreenshot() {
    const registry = new ToolRegistry()
    registerBuiltinTools(registry)
    const tool = registry.get('desktop_screenshot')
    if (!tool) throw new Error('legacy desktop_screenshot missing')
    return tool
}

beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'nova-legacy-shot-')))
})
afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    mocks.execSync.mockReset()
    mocks.capture.mockClear()
    mocks.send.mockClear()
})

describe('legacy registry desktop_screenshot', () => {
    it('keeps the tool name but refuses without the enrolled owner context', async () => {
        vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID', '123')
        vi.stubEnv('NOVA_CAPTURE_SOCKET', '/run/x/desktop.sock')
        vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '/run/x/token')
        const tool = legacyScreenshot()
        for (const context of [{}, { ...owner, authUserId: '999' }, { ...owner, channel: 'cli' }]) {
            const result: any = await withExecutionPolicyContext(context, () => tool.handler({ chat_id: '123' }))
            expect(result).toMatchObject({ success: false })
        }
        expect(mocks.capture).not.toHaveBeenCalled()
        expect(mocks.execSync).not.toHaveBeenCalled()
        expect(mocks.send).not.toHaveBeenCalled()
    })

    it('never captures the local display, even for the enrolled owner', async () => {
        vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID', '123')
        vi.stubEnv('NOVA_CAPTURE_SOCKET', '')
        vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '')
        const result: any = await withExecutionPolicyContext(owner, () => legacyScreenshot().handler({}))
        expect(result).toMatchObject({ success: false, captured: false })
        expect(mocks.execSync).not.toHaveBeenCalled()
        expect(mocks.send).not.toHaveBeenCalled()
    })

    it('captures only through the enrolled adapter and ignores a model-supplied chat_id', async () => {
        vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID', '123')
        vi.stubEnv('NOVA_CAPTURE_SOCKET', '/run/x/desktop.sock')
        vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '/run/x/token')
        const result: any = await withExecutionPolicyContext(owner, () => legacyScreenshot().handler({ chat_id: '666', name: 'shot' }))
        expect(result).toMatchObject({ success: true, captured: true, delivered: true })
        expect(mocks.capture).toHaveBeenCalledTimes(1)
        expect(mocks.execSync).not.toHaveBeenCalled()
        expect(mocks.send).toHaveBeenCalledTimes(1)
        expect(mocks.send.mock.calls[0][0]).toMatchObject({ chat_id: '123' })
    })
})
