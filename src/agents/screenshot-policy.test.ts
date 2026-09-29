import { afterEach, expect, it, vi } from 'vitest'
import { authorizeToolExecution } from './tool-authorization.js'
import { DEFAULT_POLICY, loadPolicy } from '../tools/tool-policy.js'
vi.mock('../users/multi-user-middleware.js', () => ({
    isToolAllowed: (id: string) => id === 'fixture-owner',
    getToolRestrictionMessage: () => 'Role denied',
}))
const authority = { userId: 'fixture-principal', authUserId: 'fixture-owner', channel: 'Telegram',
    requestText: 'mach mal eine Screenshot deines Systems und send mir diesen', governedReadOnly: false }
afterEach(() => loadPolicy({ toolPolicy: { defaultAction: DEFAULT_POLICY.defaultAction, rules: [] } }))

it('reproduces the default remote desktop denial and scopes explicit capture enrollment', async () => {
    await expect(authorizeToolExecution('desktop_screenshot', {}, authority)).rejects.toThrow('Desktop-Steuerung nur lokal')
    // Operator configuration only: a single capture tool, channel and canonical
    // principal, not desktop_* and not model-supplied authorization.
    loadPolicy({ toolPolicy: { rules: [{ tool: 'desktop_screenshot', action: 'allow',
        channels: ['telegram'], users: ['fixture-principal'] }] } })
    await expect(authorizeToolExecution('desktop_screenshot', {}, authority)).resolves.toMatchObject({ channel: 'Telegram' })
    await expect(authorizeToolExecution('desktop_click', {}, authority)).rejects.toThrow('Desktop-Steuerung nur lokal')
    await expect(authorizeToolExecution('desktop_screenshot', { channel: 'telegram' }, { ...authority, channel: 'Discord' })).rejects.toThrow()
    await expect(authorizeToolExecution('desktop_screenshot', {}, { ...authority, userId: 'another' })).rejects.toThrow()
    await expect(authorizeToolExecution('desktop_screenshot', { authorizationUserId: 'fixture-owner' },
        { ...authority, authUserId: 'guest' })).rejects.toThrow('Role denied')
})
