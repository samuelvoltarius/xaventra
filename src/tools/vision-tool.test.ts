import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'admin') }))
vi.mock('../users/multi-user-middleware.js', async (original) => ({ ...(await original() as object), getUserPermission: perms.getUserPermission }))
const child = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
    ...(await original() as object),
    spawn: (...args: unknown[]) => {
        child.spawn(...args)
        const proc: any = new EventEmitter()
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        setTimeout(() => proc.emit('close', 1), 0)
        return proc
    },
}))

let root = ''
let vision: typeof import('./vision-tool.js')
let policy: typeof import('./tool-policy.js')
beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'vision-'))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    vi.resetModules()
    vision = await import('./vision-tool.js')
    policy = await import('./tool-policy.js')
})
beforeEach(() => child.spawn.mockClear())
const owner = { authorizationUserId: 'owner-1', channel: 'telegram' }

describe('R2 T11: screen and webcam capture are under the desktop lock', () => {
    it.each(['screen_capture', 'webcam_capture'])('%s is denied on every channel by default', (name) => {
        for (const channel of ['telegram', 'discord', 'whatsapp', 'cli', 'rest', 'web']) {
            expect(policy.checkTool(name, { channel, userId: 'owner-1', authUserId: 'owner-1' }).allowed).toBe(false)
        }
    })
    it('webcam_capture never writes outside the vision directory', async () => {
        await vision.webcamCaptureTool.handler({ outputPath: '../../../home/x/.bashrc', cameraIndex: '0); import os #' as any })
        const [, args] = child.spawn.mock.calls[0] as [string, string[]]
        expect(args[1]).toBe(join(root, '.nova-data', 'vision', 'bashrc.jpg'))
        const script = readFileSync(args[0], 'utf8')
        expect(script).not.toContain('import os #')
        expect(script).toContain('cv2.VideoCapture(0)')
    })
})

describe('R2 T12: image paths never become Python source', () => {
    it('face_detect and hand_gesture pass the path as argv only', async () => {
        const evil = 'x"); __import__("os").system("calc"); ("'
        await vision.faceDetectionTool.handler({ ...owner, imagePath: evil, minConfidence: '0.5); import os #' as any })
        await vision.handGestureTool.handler({ ...owner, imagePath: evil })
        expect(child.spawn).toHaveBeenCalledTimes(2)
        for (const [, args] of child.spawn.mock.calls as Array<[string, string[]]>) {
            expect(readFileSync(args[0], 'utf8')).not.toContain('__import__("os")')
            expect(args[1]).toContain('__import__("os")')
        }
        expect(readFileSync(join(root, '.nova-data', 'vision', 'face_detect.py'), 'utf8')).not.toContain('import os #')
    })
    it('refuses secret files as image input (also for screen_analyze)', async () => {
        writeFileSync(join(root, 'xaventra.config.json'), '{"token":"secret"}')
        const face = await vision.faceDetectionTool.handler({ ...owner, imagePath: join(root, 'xaventra.config.json') }) as any
        const analyze = await vision.screenAnalysisTool.handler({ ...owner, imagePath: join(root, 'xaventra.config.json') }) as any
        expect(face.success).toBe(false)
        expect(analyze.success).toBe(false)
        expect(JSON.stringify(analyze)).not.toContain(Buffer.from('{"token":"secret"}').toString('base64'))
        expect(child.spawn).not.toHaveBeenCalled()
    })
})
