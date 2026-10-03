import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_POLICY, loadPolicy } from '../tools/tool-policy.js'

vi.mock('../users/multi-user-middleware.js', () => ({
    isToolAllowed: (id: string) => id === 'owner-raw',
    getToolRestrictionMessage: () => 'Role denied',
}))

const { runAuthorizedScreenshotFallback } = await import('./message-pipeline.js')

function fixtureImage(): string {
    const dir = join(process.cwd(), '.nova-test-tmp', `shot-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'shot.png')
    writeFileSync(path, 'png')
    return path
}

function harness() {
    const path = fixtureImage()
    const execute = vi.fn(async () => ({ success: true, screenshotPath: path, size: 3 }))
    const sendPhoto = vi.fn(async () => undefined)
    return { path, execute, sendPhoto }
}

function enrollCapture(users: string[]) {
    loadPolicy({ toolPolicy: { rules: [{ tool: 'desktop_screenshot', action: 'allow', channels: ['telegram'], users }] } })
}

const request = 'Schick mir einen Screenshot vom Desktop'

afterEach(() => loadPolicy({ toolPolicy: { defaultAction: DEFAULT_POLICY.defaultAction, rules: [] } }))

describe('deterministic screenshot fallback authorization (H1)', () => {
    it('never substitutes a local image for a mesh-node screenshot request', async () => {
        enrollCapture(['owner-principal'])
        const { execute, sendPhoto } = harness()
        expect(await runAuthorizedScreenshotFallback({
            channel: 'Telegram', from: 'owner-raw', principalId: 'owner-principal',
            content: 'send mir mal einen screnn schots von allen nodes bitte',
            tools: { execute }, telegram: { sendPhoto },
        })).toBeNull()
        expect(execute).not.toHaveBeenCalled()
        expect(sendPhoto).not.toHaveBeenCalled()
    })
    it('never captures or sends for a guest after a failed model turn, even with capture enrolled', async () => {
        enrollCapture(['guest-principal'])
        const { execute, sendPhoto } = harness()
        const delivered = await runAuthorizedScreenshotFallback({
            channel: 'Telegram', from: 'guest-raw', principalId: 'guest-principal', content: request,
            tools: { execute }, telegram: { sendPhoto },
        })
        expect(delivered).toBeNull()
        expect(execute).not.toHaveBeenCalled()
        expect(sendPhoto).not.toHaveBeenCalled()
    })

    it('does nothing for the owner when desktop capture is not enrolled for remote channels', async () => {
        const { execute, sendPhoto } = harness()
        const delivered = await runAuthorizedScreenshotFallback({
            channel: 'Telegram', from: 'owner-raw', principalId: 'owner-principal', content: request,
            tools: { execute }, telegram: { sendPhoto },
        })
        expect(delivered).toBeNull()
        expect(execute).not.toHaveBeenCalled()
        expect(sendPhoto).not.toHaveBeenCalled()
    })

    it('does nothing outside Telegram', async () => {
        enrollCapture(['owner-principal'])
        const { execute, sendPhoto } = harness()
        const delivered = await runAuthorizedScreenshotFallback({
            channel: 'Discord', from: 'owner-raw', principalId: 'owner-principal', content: request,
            tools: { execute }, telegram: { sendPhoto },
        })
        expect(delivered).toBeNull()
        expect(execute).not.toHaveBeenCalled()
        expect(sendPhoto).not.toHaveBeenCalled()
    })

    it('has no direct, unauthorized screenshot execution left in the pipeline', async () => {
        const { readFileSync } = await import('node:fs')
        const { fileURLToPath } = await import('node:url')
        const source = readFileSync(fileURLToPath(new URL('./message-pipeline.ts', import.meta.url)), 'utf8')
        expect(source).not.toMatch(/state\.tools\.execute\(\s*['"]desktop_screenshot['"]/)
        expect(source).toContain('runAuthorizedScreenshotFallback({')
    })

    it('captures and sends only for an authorized, enrolled principal with authorized arguments', async () => {
        enrollCapture(['owner-principal'])
        const { path, execute, sendPhoto } = harness()
        const delivered = await runAuthorizedScreenshotFallback({
            channel: 'Telegram', from: 'owner-raw', principalId: 'owner-principal', content: request,
            tools: { execute }, telegram: { sendPhoto },
        })
        expect(delivered).toEqual({ path, size: 3 })
        expect(execute).toHaveBeenCalledTimes(1)
        expect(execute).toHaveBeenCalledWith('desktop_screenshot', expect.objectContaining({
            send: false, chat_id: 'owner-raw', userId: 'owner-principal', authorizationUserId: 'owner-raw',
        }))
        expect(sendPhoto).toHaveBeenCalledWith('owner-raw', path, 'Desktop Screenshot')
    })
})
