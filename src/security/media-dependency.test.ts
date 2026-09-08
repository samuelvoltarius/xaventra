import sharp from 'sharp'
import { it, expect } from 'vitest'

it('loads the actual patched media backend and preserves image decode/resize', async () => {
    const input = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#123456' } }).png().toBuffer()
    const result = await sharp(input).resize(2, 2).jpeg().toBuffer()
    const metadata = await sharp(result).metadata()
    expect(metadata.format).toBe('jpeg')
    expect([metadata.width, metadata.height]).toEqual([2, 2])
    const [major, minor, patch] = sharp.versions.sharp.split('.').map(Number)
    expect(major > 0 || minor > 35 || (minor === 35 && patch >= 4)).toBe(true)
})
