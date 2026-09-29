import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const tg = vi.hoisted(() => ({ getLastActiveChat: vi.fn(() => '555'), sendPhoto: vi.fn(async () => {}), sendDocument: vi.fn(async () => {}) }))
vi.mock('../channels/telegram.js', () => ({ getTelegramAdapter: () => tg }))
import { executeSendFile, sendFileTool } from './send-file-tool.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'

let file = ''
beforeEach(() => {
    vi.clearAllMocks()
    file = join(mkdtempSync(join(tmpdir(), 'send-file-')), 'shot.png')
    writeFileSync(file, 'fixture')
})
afterEach(() => vi.unstubAllEnvs())

it('sends only to the authenticated Telegram requester, never to a model-supplied chat_id', async () => {
    const result = await withExecutionPolicyContext({ channel: 'telegram', authUserId: '123', runId: 'r' },
        () => executeSendFile({ path: file, chat_id: '999' }))
    expect(result).toMatch(/^✅ Foto gesendet:/)
    expect(tg.sendPhoto).toHaveBeenCalledWith('123', file, expect.any(String))
    expect(tg.getLastActiveChat).not.toHaveBeenCalled()
})
it.each([
    ['no execution context', undefined],
    ['a non-Telegram channel', { channel: 'cli', authUserId: '123' }],
    ['a REST caller claiming a Telegram id', { channel: 'rest', authUserId: '123' }],
    ['a missing principal', { channel: 'telegram' }],
    ['a non-numeric principal', { channel: 'telegram', authUserId: 'desktop:owner' }],
])('refuses without an authenticated Telegram recipient (%s), even with a model chat_id', async (_label, context) => {
    const run = () => executeSendFile({ path: file, chat_id: '999' })
    const result = context ? await withExecutionPolicyContext(context, run) : await run()
    expect(result).toMatch(/^❌/)
    expect(tg.sendPhoto).not.toHaveBeenCalled()
    expect(tg.sendDocument).not.toHaveBeenCalled()
    expect(tg.getLastActiveChat).not.toHaveBeenCalled()
})
it('does not offer a model-controlled recipient parameter', () => {
    expect(sendFileTool.parameters.map(p => p.name)).not.toContain('chat_id')
})
