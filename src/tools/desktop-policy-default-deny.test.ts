import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../users/multi-user-middleware.js', () => ({
    // Owner/admin role everywhere: only the tool policy may stop desktop tools.
    isToolAllowed: () => true,
    getToolRestrictionMessage: () => 'Role denied',
}))
import { checkTool, loadPolicy, DEFAULT_POLICY } from './tool-policy.js'
import { authorizeToolExecution } from '../agents/tool-authorization.js'
import { runWithDesktopAgentContext } from '../desktop/desktop-agent-context.js'

const DESKTOP_TOOLS = ['desktop_screenshot', 'desktop_input', 'desktop_workspace', 'desktop_control', 'desktop_status', 'desktop_click']
const desktopClient = { principalId: 'owner-a', clientId: 'client-a', authorizationUserId: 'desktop:owner-a', roomId: 'room',
    botId: 'bot', preferredNodeIds: [], modelMode: 'auto' as const }
afterEach(() => { vi.unstubAllEnvs(); loadPolicy({ toolPolicy: { defaultAction: DEFAULT_POLICY.defaultAction, rules: [] } }) })

it.each(['cli', 'web', 'api', 'rest', 'mcp', 'desktop', 'voice', ''])('denies desktop_* by default on the %s channel for owner/admin', async channel => {
    for (const tool of DESKTOP_TOOLS) {
        for (const userId of ['owner', 'admin', '123']) {
            expect(checkTool(tool, { channel, userId, authUserId: userId }).allowed, `${tool}@${channel}`).toBe(false)
        }
        await expect(authorizeToolExecution(tool, {}, { userId: 'owner', authUserId: 'owner', channel,
            requestText: 'mach einen Screenshot vom Desktop', governedReadOnly: false })).rejects.toThrow()
    }
})
it('keeps the enrolled owner grant scoped to Telegram, not web/api/cli', () => {
    vi.stubEnv('NOVA_DESKTOP_TELEGRAM_OWNER_ID', '123'); vi.stubEnv('NOVA_CAPTURE_SOCKET', '/s'); vi.stubEnv('NOVA_CAPTURE_TOKEN_FILE', '/t')
    vi.stubEnv('NOVA_DESKTOP_INPUT_ENABLED', '1')
    for (const channel of ['cli', 'web', 'api', 'rest'])
        for (const tool of ['desktop_screenshot', 'desktop_input'])
            expect(checkTool(tool, { channel, userId: '123', authUserId: '123' }).allowed).toBe(false)
    expect(checkTool('desktop_screenshot', { channel: 'telegram', userId: 'p', authUserId: '123' }).allowed).toBe(true)
})
it('allows an explicit operator grant', () => {
    loadPolicy({ toolPolicy: { rules: [{ tool: 'desktop_status', action: 'allow', channels: ['cli'], users: ['owner'] }] } })
    expect(checkTool('desktop_status', { channel: 'cli', userId: 'owner' }).allowed).toBe(true)
    expect(checkTool('desktop_status', { channel: 'cli', userId: 'admin' }).allowed).toBe(false)
    expect(checkTool('desktop_control', { channel: 'cli', userId: 'owner' }).allowed).toBe(false)
})
it('grants Nova Desktop client tools only inside an authenticated desktop client context on the desktop channel', () => {
    runWithDesktopAgentContext(desktopClient, () => {
        for (const tool of ['desktop_workspace', 'desktop_control', 'desktop_status', 'desktop_screenshot'])
            expect(checkTool(tool, { channel: 'desktop', userId: 'owner-a', authUserId: 'desktop:owner-a' }).allowed, tool).toBe(true)
        expect(checkTool('desktop_input', { channel: 'desktop', userId: 'owner-a' }).allowed).toBe(false)
        expect(checkTool('desktop_workspace', { channel: 'rest', userId: 'owner-a' }).allowed).toBe(false)
    })
    runWithDesktopAgentContext({ ...desktopClient, clientId: '' }, () =>
        expect(checkTool('desktop_workspace', { channel: 'desktop', userId: 'owner-a' }).allowed).toBe(false))
})
it('lets an operator deny override every grant', () => {
    loadPolicy({ toolPolicy: { rules: [{ tool: 'desktop_*', action: 'deny' }] } })
    runWithDesktopAgentContext(desktopClient, () =>
        expect(checkTool('desktop_workspace', { channel: 'desktop', userId: 'owner-a' }).allowed).toBe(false))
})
