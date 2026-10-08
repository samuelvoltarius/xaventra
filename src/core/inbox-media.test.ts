import { mkdtempSync, rmSync, utimesSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INBOX_MEDIA_MAX_AGE_MS, inboxMediaDir, inboxImagePromptBlock, pruneInboxMedia, resolveInboxImagePath, storeInboxImage } from './inbox-media.js'

let root = ''
let previous = ''
beforeEach(() => { previous = process.cwd(); root = mkdtempSync(join(tmpdir(), 'xv-inbox-')); process.chdir(root) })
afterEach(() => { process.chdir(previous); try { rmSync(root, { recursive: true, force: true }) } catch { /* handle */ } })

describe('inbox media', () => {
    it('stores a picture once per content and returns an absolute path', () => {
        const data = Buffer.from('bytes-1').toString('base64')
        const a = storeInboxImage({ data, mimeType: 'image/png' })!
        expect(a.endsWith('.png')).toBe(true)
        expect(storeInboxImage({ data, mimeType: 'image/png' })).toBe(a)
        expect(readdirSync(inboxMediaDir())).toHaveLength(1)
    })
    it('rejects empty data and prunes files past the retention window', () => {
        expect(storeInboxImage({ data: '', mimeType: 'image/png' })).toBeNull()
        const old = storeInboxImage({ data: Buffer.from('old').toString('base64'), mimeType: 'image/jpeg' })!
        const past = new Date(Date.now() - INBOX_MEDIA_MAX_AGE_MS - 60_000)
        utimesSync(old, past, past)
        const fresh = storeInboxImage({ data: Buffer.from('fresh').toString('base64'), mimeType: 'image/jpeg' })!
        expect(pruneInboxMedia()).toBe(0)
        expect(existsSync(old)).toBe(false)
        expect(existsSync(fresh)).toBe(true)
    })
})

describe('inbox image prompt', () => {
    it('hands the stored path to plate solving', () => {
        const path = storeInboxImage({ data: Buffer.from('astro-bytes').toString('base64'), mimeType: 'image/jpeg' })!
        const block = inboxImagePromptBlock(path)
        expect(block).toContain(`image_path=${path}`)
        expect(block).toContain('astro_plate_solve')
        expect(block).toContain('load_skill_pack')
    })
})

describe('inbox image path resolution (2.89.3)', () => {
    it('maps the path a model garbled (live 08.10.2026) to the stored picture', () => {
        const real = storeInboxImage({ data: Buffer.from('live-photo').toString('base64'), mimeType: 'image/jpeg' })!
        expect(resolveInboxImagePath(real)).toBe(real)
        const hash = /-([0-9a-f]{12})\.jpg$/.exec(real)![1]
        const garbled = join(inboxMediaDir(), '2026-10-08', `18-37-08_${hash.slice(-6)}.jpg`)
        expect(existsSync(garbled)).toBe(false)
        expect(resolveInboxImagePath(garbled)).toBe(real)
        expect(resolveInboxImagePath(join(inboxMediaDir(), 'x', 'y-no-hash.jpg'))).toBe(real)
    })
    it('never guesses outside the inbox folder or from an empty folder', () => {
        expect(resolveInboxImagePath('/etc/passwd-not-there.jpg')).toBeNull()
        expect(resolveInboxImagePath('')).toBeNull()
        expect(resolveInboxImagePath(join(inboxMediaDir(), 'nothing.jpg'))).toBeNull()
    })
    it('does not pick a picture older than an hour for an unknown name', () => {
        const old = storeInboxImage({ data: Buffer.from('stale').toString('base64'), mimeType: 'image/jpeg' })!
        const past = new Date(Date.now() - 2 * 3600_000)
        utimesSync(old, past, past)
        expect(resolveInboxImagePath(join(inboxMediaDir(), 'unknown.jpg'))).toBeNull()
    })
    it('prompt block says the picture is already in the call only when the model sees it', () => {
        expect(inboxImagePromptBlock('/x/inbox-media/a.jpg', true)).toContain('Das Bild liegt dir bereits vor')
        expect(inboxImagePromptBlock('/x/inbox-media/a.jpg')).not.toContain('bereits vor')
    })
})
