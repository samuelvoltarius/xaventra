import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { prepareVisionImage, VISION_MAX_EDGE } from './image-prepare.js'

async function jpeg(width: number, height: number): Promise<string> {
    const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 90, b: 160 } } }).jpeg({ quality: 92 }).toBuffer()
    return bytes.toString('base64')
}

describe('vision image preparation (2.89.3)', () => {
    it('shrinks a 6000x4000 original to 1536 px on the long edge as JPEG', async () => {
        const prepared = await prepareVisionImage({ data: await jpeg(6000, 4000), mimeType: 'image/jpeg' })
        expect(prepared.resized).toBe(true)
        const meta = await sharp(Buffer.from(prepared.data, 'base64')).metadata()
        expect(Math.max(meta.width!, meta.height!)).toBe(VISION_MAX_EDGE)
        expect(meta.width! / meta.height!).toBeCloseTo(1.5, 1)
        expect(prepared.mimeType).toBe('image/jpeg')
    })
    it('turns a large PNG into a smaller JPEG', async () => {
        const png = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: { r: 200, g: 20, b: 20 } } }).png().toBuffer()
        const prepared = await prepareVisionImage({ data: png.toString('base64'), mimeType: 'image/png' })
        expect(prepared.resized).toBe(true)
        expect(prepared.mimeType).toBe('image/jpeg')
    })
    it('leaves a small picture untouched', async () => {
        const data = await jpeg(800, 600)
        const prepared = await prepareVisionImage({ data, mimeType: 'image/jpeg' })
        expect(prepared.resized).toBe(false)
        expect(prepared.data).toBe(data)
    })
    it('falls back to the original when the bytes are not a picture', async () => {
        const data = Buffer.from('not-a-real-jpeg-but-bytes').toString('base64')
        const prepared = await prepareVisionImage({ data, mimeType: 'image/jpeg' })
        expect(prepared.resized).toBe(false)
        expect(prepared.data).toBe(data)
    })
})
