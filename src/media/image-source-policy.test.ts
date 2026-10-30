import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Abschnitt 5 Selbst-Anbindung (30.10.2026): local stills reach MiniMax only from the private image
// folders, only PNG/JPEG, only from a released source. Format test on VM 130: only
// `image_url` with a data URL is seen by the model; the `source` forms are silently ignored.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)])
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(32)])
let root = '', vision = ''
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'img-policy-')); vision = join(root, '.nova-vision')
    vi.stubEnv('NOVA_RUNTIME_ROOT', root)
    for (const dir of ['mesh-captures', 'kamera', 'auto']) mkdirSync(join(vision, dir), { recursive: true })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const file = (name: string, bytes: Buffer = PNG) => { const path = join(vision, name); writeFileSync(path, bytes); return path }
const policy = () => import('./image-source-policy.js')

describe('which images may leave for evaluation', () => {
    it('lab captures and camera stills pass, as PNG or JPEG', async () => {
        const { assertSendableImage } = await policy()
        expect(assertSendableImage(file('mesh-captures/node_xaventra-lab__1793313902295_abcdef.png'))).toMatchObject({ source: 'lab', mime: 'image/png' })
        expect(assertSendableImage(file('kamera/dev-0123456789_1793313902295.jpg', JPEG))).toMatchObject({ source: 'kamera', mime: 'image/jpeg' })
    })
    it.each([
        ['a capture of another node', 'mesh-captures/node_xaventra-pc__1_abcdef.png'],
        ['an old capture without a node', 'mesh-captures/node_1793313902295_abcdef.png'],
        ['an auto image', 'auto/ereignis.jpg'],
        ['a local desktop screenshot (PC)', 'desktop_1793313902295.png'],
    ])('refuses %s', async (_label, name) => {
        const { assertSendableImage } = await policy()
        expect(() => assertSendableImage(file(name))).toThrow(/nicht freigegeben/)
    })
    it('refuses free paths, non-images, oversized files and links', async () => {
        const { assertSendableImage } = await policy()
        const outside = join(root, 'geheim.png'); writeFileSync(outside, PNG)
        expect(() => assertSendableImage(outside)).toThrow(/nicht freigegeben/)
        expect(() => assertSendableImage(join(vision, 'kamera', '..', '..', 'geheim.png'))).toThrow(/nicht freigegeben/)
        expect(() => assertSendableImage(file('kamera/text.png', Buffer.from('kein bild, nur text....')))).toThrow(/PNG oder JPEG/)
        expect(() => assertSendableImage(file('kamera/gross.png', Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)])))).toThrow(/zu groß/)
        if (process.platform !== 'win32') {
            symlinkSync(outside, join(vision, 'kamera', 'link.png'))
            expect(() => assertSendableImage(join(vision, 'kamera', 'link.png'))).toThrow(/nicht freigegeben/)
        }
    })
    it('more nodes only by operator list', async () => {
        vi.stubEnv('XAVENTRA_VISION_NODES', 'xaventra-lab,xaventra-nas')
        const { assertSendableImage } = await policy()
        expect(assertSendableImage(file('mesh-captures/node_xaventra-nas__1_abcdef.png'))).toMatchObject({ source: 'lab' })
    })
    it('a private image folder is recognised; other paths are not', async () => {
        const { isPrivateImagePath } = await policy()
        expect(isPrivateImagePath(file('kamera/a.png'))).toBe(true)
        expect(isPrivateImagePath(file('desktop_1.png'))).toBe(true)
        expect(isPrivateImagePath(join(root, 'inbox-media', 'bild.png'))).toBe(false)
    })
})

describe('minimaxVisionFile', () => {
    it('sends the proven image_url data URL and never logs bytes', async () => {
        vi.stubEnv('MINIMAX_API_KEY', 'fixture-key-for-tests')
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Oben steht VIDEOGRAF' } }] }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const logged: string[] = []
        for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
        const { minimaxVisionFile } = await import('../tools/minimax-tools.js')
        const path = file('mesh-captures/node_xaventra-lab__1_abcdef.png')
        expect(await minimaxVisionFile(path, 'Was steht oben?')).toBe('Oben steht VIDEOGRAF')
        const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body)
        expect(body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } })
        expect(logged.join('\n')).not.toContain(PNG.toString('base64'))
    })
    it('a refused source never reaches the network', async () => {
        vi.stubEnv('MINIMAX_API_KEY', 'fixture-key-for-tests')
        const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
        const { minimaxVisionFile } = await import('../tools/minimax-tools.js')
        await expect(minimaxVisionFile(file('auto/ereignis.jpg', JPEG), 'x')).rejects.toThrow(/nicht freigegeben/)
        expect(fetchMock).not.toHaveBeenCalled()
    })
    it('minimaxVision with an https address also uses the image_url form', async () => {
        vi.stubEnv('MINIMAX_API_KEY', 'fixture-key-for-tests')
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const { minimaxVision } = await import('../tools/minimax-tools.js')
        await minimaxVision('https://example.com/a.png', 'x')
        expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/a.png' } })
    })
    it('the minimax_vision tool takes https addresses only, no local path or data URL', async () => {
        vi.stubEnv('MINIMAX_API_KEY', 'fixture-key-for-tests')
        const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
        const { minimaxTools } = await import('../tools/minimax-tools.js')
        const tool = minimaxTools.find((item: any) => item.name === 'minimax_vision')!
        for (const image_url of ['/etc/passwd', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'http://192.168.1.5/a.png'])
            await expect(tool.handler({ image_url })).rejects.toThrow(/https/)
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('analyze_image with private images', () => {
    const media = vi.hoisted(() => ({ processMedia: vi.fn(async () => ({ text: 'anderer Dienst' })) }))
    vi.mock('./media-providers.js', async importOriginal => ({ ...(await importOriginal<object>()), processMedia: media.processMedia }))
    const analyze = async () => (await import('../tools/complete-registry.js')).ALL_TOOLS.find(tool => tool.name === 'analyze_image')!
    beforeEach(() => media.processMedia.mockClear())
    it('goes over MiniMax and answers with the evaluation', async () => {
        vi.stubEnv('MINIMAX_API_KEY', 'fixture-key-for-tests')
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'VIDEOGRAF' } }] }), { status: 200 })))
        const tool = await analyze()
        expect(await tool.handler({ path: file('mesh-captures/node_xaventra-lab__1_abcdef.png') })).toMatchObject({ success: true, analysis: 'VIDEOGRAF', provider: 'minimax' })
        expect(media.processMedia).not.toHaveBeenCalled()
    })
    it('Gegenprobe: a refused source goes nowhere, also with a provider named by the model', async () => {
        vi.stubEnv('MINIMAX_API_KEY', 'fixture-key-for-tests')
        const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
        const tool = await analyze()
        await expect(tool.handler({ path: file('desktop_1793313902295.png'), provider: 'openai' })).rejects.toThrow(/nicht freigegeben/)
        await expect(tool.handler({ path: file('auto/ereignis.png') })).rejects.toThrow(/nicht freigegeben/)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(media.processMedia).not.toHaveBeenCalled()
    })
    it('Gegenprobe: without a MiniMax key an honest no, never another service', async () => {
        vi.stubEnv('MINIMAX_API_KEY', '')
        vi.resetModules()
        const { hasMiniMaxKey } = await import('../tools/minimax-tools.js')
        if (hasMiniMaxKey()) return // a key from the developer's own config: nothing to prove here
        const tool = await analyze()
        await expect(tool.handler({ path: file('kamera/a.png') })).rejects.toThrow(/kein MiniMax-Schlüssel/)
        expect(media.processMedia).not.toHaveBeenCalled()
    })
    it('other images (Telegram inbox) keep their way', async () => {
        const inbox = join(root, 'bild.png'); writeFileSync(inbox, PNG)
        const tool = await analyze()
        await tool.handler({ path: inbox })
        expect(media.processMedia).toHaveBeenCalledOnce()
    })
})
