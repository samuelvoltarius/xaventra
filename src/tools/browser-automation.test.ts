import { beforeEach, describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({ execFileSync: vi.fn(() => '{"text":"t","html":"","links":[],"images":[],"meta":{}}'), execSync: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original() as object), execFileSync: child.execFileSync, execSync: child.execSync }))

import { captureScreenshot, extractContent } from './browser-automation.js'

beforeEach(() => { child.execFileSync.mockClear(); child.execSync.mockClear() })

describe('R2 T27: browser-automation never puts a URL into a shell or raw JS source', () => {
    it('screenshot uses an argument vector and a JSON literal', () => {
        const url = "https://example.com/a?x=$(id)&y=`whoami`&z='); process.exit(1); ('"
        captureScreenshot(url)
        expect(child.execSync).not.toHaveBeenCalled()
        const [file, args, options] = child.execFileSync.mock.calls[0] as any
        expect(file).toBe(process.execPath)
        expect(options?.shell).toBeUndefined()
        expect(args).toContain(new URL(url).href)
    })
    it('extraction embeds the URL only as a JSON string literal', () => {
        const url = "https://example.com/?q=');require('child_process').execSync('calc');('"
        extractContent(url)
        expect(child.execSync).not.toHaveBeenCalled()
        const [, args] = child.execFileSync.mock.calls[0] as any
        expect(args[0]).toBe('-e')
        expect(args[1]).toContain(`page.goto(${JSON.stringify(new URL(url).href)}`)
    })
    it.each(['file:///etc/passwd', 'http://127.0.0.1:18789/', 'http://169.254.169.254/', 'javascript:alert(1)'])('refuses %s', (url) => {
        expect(() => captureScreenshot(url)).toThrow()
        expect(child.execFileSync).not.toHaveBeenCalled()
    })
})
