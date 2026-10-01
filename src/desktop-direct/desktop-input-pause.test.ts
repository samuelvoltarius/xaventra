import { afterEach, expect, it, vi } from 'vitest'
const call = vi.hoisted(() => vi.fn(async (): Promise<any> => ({ status: 'completed' })))
vi.mock('../host/capture-agent.js', () => ({ requestSessionInput: call }))
import { desktopInputTool } from '../tools/desktop-input-tool.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { clearAgentDesktopInputHolds, holdAgentDesktopInput } from './pause.js'

afterEach(() => { vi.unstubAllEnvs(); call.mockClear(); clearAgentDesktopInputHolds() })

const params = { requestText: 'Klicke im Arbeitsdesktop auf OK', step: 'one', action: '{"action":"key","key":"Tab"}' }
const context = { channel: 'telegram', authUserId: '123', runId: 'r' }

it('/desktop Übernehmen pauses desktop_input until the hold is released', async () => {
    vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID', '123'); vi.stubEnv('NOVA_DESKTOP_INPUT_ENABLED', '1')
    const release = holdAgentDesktopInput('s1', 'spark')
    const paused = await withExecutionPolicyContext(context, () => desktopInputTool.handler(params))
    expect(paused).toMatchObject({ success: false, status: 'paused' })
    expect(String(paused.error)).toMatch(/übernommen/)
    expect(call).not.toHaveBeenCalled()
    release()
    expect(await withExecutionPolicyContext(context, () => desktopInputTool.handler(params))).toMatchObject({ success: true })
    expect(call).toHaveBeenCalledTimes(1)
})
