import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { cachedIcon, fetchCommunityIcon, type IconFetch } from './icon-cache.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-icon-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)])
const reply = (body: Buffer, type: string, status = 200): IconFetch => async () => ({ ok: status === 200, status, contentType: type, body })

describe('community icons: fetched by the Main, checked, cached', () => {
    it('accepts a real PNG once and serves it from the cache afterwards', async () => {
        const dir = tmp()
        let calls = 0
        const fetchFn: IconFetch = async (...args) => { calls++; return reply(PNG, 'image/png')(...args) }
        const first = await fetchCommunityIcon('https://cdn.example.com/a.png', { fetchFn, cacheDir: dir })
        expect(first).toMatchObject({ ok: true, hash: createHash('sha256').update(PNG).digest('hex') })
        expect(first.ok && first.dataUri.startsWith('data:image/png;base64,')).toBe(true)
        const again = await fetchCommunityIcon('https://cdn.example.com/a.png', { fetchFn, cacheDir: dir })
        expect(again.ok).toBe(true)
        expect(calls).toBe(1)
        expect(cachedIcon('https://cdn.example.com/a.png', dir)).toMatch(/^data:image\/png;base64,/)
    })

    it('refuses SVG, wrong magic bytes, oversized bodies, non-https and a wrong icon_hash', async () => {
        const dir = tmp()
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
        expect((await fetchCommunityIcon('https://cdn.example.com/a.svg', { fetchFn: reply(svg, 'image/svg+xml'), cacheDir: dir })).ok).toBe(false)
        expect((await fetchCommunityIcon('https://cdn.example.com/fake.png', { fetchFn: reply(svg, 'image/png'), cacheDir: dir })).ok).toBe(false)
        expect((await fetchCommunityIcon('https://cdn.example.com/big.png', { fetchFn: reply(Buffer.concat([PNG, Buffer.alloc(70_000)]), 'image/png'), cacheDir: dir })).ok).toBe(false)
        expect((await fetchCommunityIcon('http://cdn.example.com/a.png', { fetchFn: reply(PNG, 'image/png'), cacheDir: dir })).ok).toBe(false)
        expect((await fetchCommunityIcon('https://cdn.example.com/a.png', { fetchFn: reply(PNG, 'image/png'), cacheDir: dir, expectedHash: 'b'.repeat(64) })).ok).toBe(false)
        expect(readdirSync(dir).filter(name => name !== 'index.json')).toEqual([])
    })

    it('a network failure is no icon, never an exception', async () => {
        const dir = tmp()
        const failing: IconFetch = async () => { throw new Error('offline') }
        expect(await fetchCommunityIcon('https://cdn.example.com/a.png', { fetchFn: failing, cacheDir: dir })).toMatchObject({ ok: false })
    })
})
