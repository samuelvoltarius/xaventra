import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'admin') }))
vi.mock('../users/multi-user-middleware.js', () => perms)

import { saveConfigTool } from './config-tool.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { ownerApprovalCode } from '../test-utils/owner-approval.js'
import { approvalDetailOf } from './owner-approval.js'

let dir = ''
const configFile = () => join(dir, 'xaventra.config.json')
const original = { telegram: { allowFrom: ['111'] }, llm: { model: 'm' }, autonomy: { enabled: false } }
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'save-config-'))
    writeFileSync(configFile(), JSON.stringify(original))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
})
afterEach(() => vi.restoreAllMocks())

describe('R2 T1: save_config protects owner, channel and provider settings', () => {
    it.each([
        ['telegram', { allowFrom: ['666'] }],
        ['channels', { telegram: { allowFrom: [] } }],
        ['providers', { openai: { baseURL: 'https://evil.example', apiKey: 'x' } }],
        ['supabase', { url: 'https://evil.example' }],
        ['llm', { baseURL: 'https://evil.example' }],
        ['autonomy', { nested: { apiKey: 'x' } }],
    ])('refuses %s without owner approval, also for the owner and an admin', async (section, values) => {
        for (const id of ['owner-1', 'admin-1']) {
            const result = await saveConfigTool.handler({ section, values, authorizationUserId: id, channel: 'telegram', confirm: 'true' }) as any
            expect(result.success).toBe(false)
        }
        expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual(original)
    })
    it('still merges harmless sections', async () => {
        const result = await saveConfigTool.handler({ section: 'autonomy', values: { enabled: true }, authorizationUserId: 'admin-1', channel: 'telegram' }) as any
        expect(result.success).toBe(true)
        expect(JSON.parse(readFileSync(configFile(), 'utf8')).autonomy.enabled).toBe(true)
    })
    it('allows a protected change with the server-side owner approval', async () => {
        const confirm = ownerApprovalCode('save_config', approvalDetailOf({ section: 'telegram', values: { allowFrom: ['222'] } }))
        const result = await withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram' },
            () => saveConfigTool.handler({ section: 'telegram', values: { allowFrom: ['222'] }, confirm })) as any
        expect(result.success).toBe(true)
        expect(JSON.parse(readFileSync(configFile(), 'utf8')).telegram.allowFrom).toEqual(['222'])
    })
})
