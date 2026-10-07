import { describe, expect, it, vi } from 'vitest'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'admin') }))
vi.mock('../users/multi-user-middleware.js', () => perms)
const manager = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('./operator-browser-manager.js', () => ({ getOperatorBrowserManager: () => ({ getSession: manager.getSession, status: () => ({ running: false }) }) }))

import { BrowserAdapter, assertBrowserUrlAllowed, safeScreenshotName } from './browser.js'
import { browserUseTools } from './browser-use.js'
import { withExecutionPolicyContext } from '../core/lifecycle-policy.js'
import { ownerApprovalCode } from '../test-utils/owner-approval.js'
import { approvalDetailOf } from './owner-approval.js'

const tool = (name: string) => browserUseTools.find(entry => entry.name === name)!

describe('R2 T6: browser navigation only to public http(s) targets', () => {
    it.each([
        'file:///home/user/.ssh/id_ed25519',
        'file:///C:/Users/x/xaventra.config.json',
        'http://127.0.0.1:18789/api/status',
        'http://localhost:18789/',
        'http://169.254.169.254/latest/meta-data/',
        'http://192.168.1.1/',
        'http://100.64.0.10:3301/',
        'javascript:alert(1)',
        'chrome://settings',
        '',
    ])('refuses %j', async (url) => {
        await expect(assertBrowserUrlAllowed(url)).rejects.toThrow(/blockiert/)
    })
    it('goto and newTab refuse before the page navigates', async () => {
        const page = { goto: vi.fn() }
        const context = { newPage: vi.fn(async () => page) }
        const adapter = new BrowserAdapter()
        Object.assign(adapter as any, { browser: {}, context, page })
        await expect(adapter.goto('file:///etc/passwd')).rejects.toThrow(/blockiert/)
        await expect(adapter.newTab('http://127.0.0.1:18789/')).rejects.toThrow(/blockiert/)
        expect(page.goto).not.toHaveBeenCalled()
        expect(context.newPage).not.toHaveBeenCalled()
    })
})

describe('R2 T31: screenshot names stay inside the screenshot directory', () => {
    it('reduces a name to a plain png file name', () => {
        expect(safeScreenshotName('../../../home/x/.bashrc')).toBe('bashrc.png')
        expect(safeScreenshotName('..\\..\\evil.png')).toBe('evil.png')
        expect(safeScreenshotName('shot')).toBe('shot.png')
        expect(safeScreenshotName(undefined)).toBeUndefined()
    })
})

describe('R2 T7: browser_upload needs owner approval and never uploads secret files', () => {
    it('refuses without approval, for admins, and for secret files even with approval', async () => {
        const upload = tool('browser_upload')
        const base = { selector: 'input[type=file]', paths: ['xaventra.config.json'] }
        expect((await upload.handler({ ...base, authorizationUserId: 'owner-1', channel: 'telegram' }) as any).success).toBe(false)
        expect((await upload.handler({ ...base, authorizationUserId: 'admin-1', channel: 'telegram', confirm: 'yes' }) as any).success).toBe(false)
        const confirm = ownerApprovalCode('browser_upload', approvalDetailOf({ selector: base.selector, paths: base.paths }))
        const approved = await withExecutionPolicyContext({ authUserId: 'owner-1', channel: 'telegram' },
            () => upload.handler({ ...base, confirm })) as any
        expect(approved.success).toBe(false)
        expect(approved.error).toMatch(/Geschützte Datei/)
        expect(manager.getSession).not.toHaveBeenCalled()
    }, 120_000)
})
