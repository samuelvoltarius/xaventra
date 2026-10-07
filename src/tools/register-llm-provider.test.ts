import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'admin') }))
vi.mock('../users/multi-user-middleware.js', async (original) => ({ ...(await original() as object), getUserPermission: perms.getUserPermission }))
const resolver = vi.hoisted(() => ({
    registerExternalProvider: vi.fn(async () => ({ success: true, modelsFound: ['m'], message: 'registered' })),
    listExternalProviders: vi.fn(() => [{ name: 'kimi', baseUrl: 'https://api.kimi.example/v1' }]),
}))
vi.mock('../core/model-resolver.js', async (original) => ({ ...(await original() as object), ...resolver }))

let register: (params: Record<string, unknown>) => Promise<string>
let withContext: typeof import('../core/lifecycle-policy.js').withExecutionPolicyContext
beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-provider-'))
    writeFileSync(join(dir, 'xaventra.config.json'), JSON.stringify({ providers: { openai: { enabled: true } } }))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    const { ALL_TOOLS } = await import('./complete-registry.js')
    register = ALL_TOOLS.find(tool => tool.name === 'register_llm_provider')!.handler as any
    withContext = (await import('../core/lifecycle-policy.js')).withExecutionPolicyContext
}, 120_000)
beforeEach(() => resolver.registerExternalProvider.mockClear())
const approved = async (params: Record<string, unknown>) => {
    const { ownerApprovalCode } = await import('../test-utils/owner-approval.js')
    const detail = `${String(params.name ?? '').trim()}@${String(params.base_url ?? '').trim().replace(/\/$/, '')}`
    return withContext({ authUserId: 'owner-1', channel: 'telegram' }, () => register({ ...params, confirm: ownerApprovalCode('register_llm_provider', detail) }))
}

describe('R2 R1/A8: register_llm_provider', () => {
    it.each([
        'http://93.184.215.14/v1',
        'https://127.0.0.1:18789/v1',
        'https://169.254.169.254/latest',
        'https://192.168.1.10/v1',
        'https://100.64.0.10:8000/v1',
        'file:///etc/passwd',
    ])('refuses base_url %s even with owner approval', async (base_url) => {
        const result = await approved({ name: 'fresh', api_key: 'k', base_url })
        expect(result).toMatch(/abgelehnt/)
        expect(resolver.registerExternalProvider).not.toHaveBeenCalled()
    })
    it.each(['kimi', 'KIMI', 'openai'])('does not overwrite the existing provider %s', async (name) => {
        const result = await approved({ name, api_key: 'k', base_url: 'https://93.184.215.14/v1' })
        expect(result).toMatch(/existiert bereits/)
        expect(resolver.registerExternalProvider).not.toHaveBeenCalled()
    })
    it('needs owner approval for a new public provider', async () => {
        const params = { name: 'fresh', api_key: 'k', base_url: 'https://93.184.215.14/v1' }
        expect(await register({ ...params, authorizationUserId: 'owner-1', channel: 'telegram' })).toMatch(/^❌/)
        expect(await register({ ...params, authorizationUserId: 'admin-1', channel: 'telegram', confirm: 'x' })).toMatch(/^❌/)
        expect(resolver.registerExternalProvider).not.toHaveBeenCalled()
        expect(await approved(params)).toBe('registered')
        expect(resolver.registerExternalProvider).toHaveBeenCalledTimes(1)
    })
})

describe('R2 UEB-8: the owner code is bound to name and base URL', () => {
    it('a code for another name or URL does not register; the matching one does, once', async () => {
        const { issueSetupConfirmation, setupConfirmationPrincipal } = await import('../core/setup-confirmation.js')
        const { toolApprovalTarget } = await import('./owner-approval.js')
        const principal = setupConfirmationPrincipal('telegram', 'owner-1')
        const base = { api_key: 'k', authorizationUserId: 'owner-1', userId: 'owner-1', channel: 'telegram' }
        const other = issueSetupConfirmation(principal, toolApprovalTarget('register_llm_provider', 'fresh2@https://93.184.215.15/v1'))
        expect(await register({ ...base, name: 'fresh2', base_url: 'https://93.184.215.14/v1', confirm: other })).toMatch(/^❌/)
        const generic = issueSetupConfirmation(principal, toolApprovalTarget('register_llm_provider'))
        expect(await register({ ...base, name: 'fresh2', base_url: 'https://93.184.215.14/v1', confirm: generic })).toMatch(/^❌/)
        expect(resolver.registerExternalProvider).not.toHaveBeenCalled()
        const exact = issueSetupConfirmation(principal, toolApprovalTarget('register_llm_provider', 'fresh2@https://93.184.215.14/v1'))
        expect(await register({ ...base, name: 'fresh2', base_url: 'https://93.184.215.14/v1', confirm: exact })).toBe('registered')
        expect(resolver.registerExternalProvider).toHaveBeenCalledTimes(1)
    })
})
