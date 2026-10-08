/**
 * 2.89.3 picture turn over the REAL Telegram entry (live incident 08.10.2026 18:37):
 * photo + "was siehst du da?" ended in analyze_image ENOENT, a 90 s timeout and silence.
 * Only the model is scripted; every check reads what the model was shown.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import sharp from 'sharp'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

const T = 90_000

async function bigPhoto(): Promise<{ data: string; mimeType: string; bytes: Buffer }> {
    const bytes = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: { r: 30, g: 60, b: 120 } } }).jpeg({ quality: 90 }).toBuffer()
    return { data: bytes.toString('base64'), mimeType: 'image/jpeg', bytes }
}

function systemText(call: { messages: Array<{ role: string; content: any }> }): string {
    return call.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
}

describe('2.89.3 picture turn over the real Telegram entry', () => {
    it('one path: the prompt names the stored file; the model gets the picture shrunk; analyze_image is not offered', async () => {
        h = await createE2EHarness()
        ;(h.model as any).modelId = 'e2e-vision-vl'
        const photo = await bigPhoto()
        const result = await h.send('Telegram', OWNER_TELEGRAM_ID, 'was siehst du da?', [{ text: 'Ein blaues Bild.' }], {
            image: { data: photo.data, mimeType: photo.mimeType }, messageContext: { chatId: OWNER_TELEGRAM_ID },
        })
        expect(result.error).toBeUndefined()
        const call = h.model.calls.find(entry => entry.scripted)!
        expect(call).toBeDefined()
        const system = systemText(call)
        const stored = system.match(/liegt als Datei unter (\S+inbox-media\S+\.jpg)\./)?.[1]
        expect(stored, system.slice(-800)).toBeDefined()
        expect(existsSync(stored!)).toBe(true)
        expect(readFileSync(stored!).equals(photo.bytes)).toBe(true) // stored file stays the original
        expect(system).toContain('Das Bild liegt dir bereits vor')
        expect(call.tools).not.toContain('analyze_image')
        const sent = call.messages.map(message => message.image).find(Boolean) as { data: string } | undefined
        expect(sent, 'the model call carries the picture').toBeDefined()
        const meta = await sharp(Buffer.from(sent!.data, 'base64')).metadata()
        expect(Math.max(meta.width || 0, meta.height || 0)).toBeLessThanOrEqual(1536)
    }, T)

    it('a model that cannot read pictures is still offered analyze_image', async () => {
        h = await createE2EHarness()
        ;(h.model as any).modelId = 'e2e-text-only'
        const photo = await bigPhoto()
        const result = await h.send('Telegram', OWNER_TELEGRAM_ID, 'was siehst du da?', [{ text: 'Ich kann das Bild nicht sehen.' }], {
            image: { data: photo.data, mimeType: photo.mimeType }, messageContext: { chatId: OWNER_TELEGRAM_ID },
        })
        expect(result.error).toBeUndefined()
        const call = h.model.calls.find(entry => entry.scripted)!
        expect(call.tools).toContain('analyze_image')
        expect(systemText(call)).not.toContain('Das Bild liegt dir bereits vor')
    }, T)

    it('a picture turn that runs into the deadline always ends with an honest answer', async () => {
        h = await createE2EHarness()
        ;(await h.module('core/message-pipeline.js')).setImageTurnTimeoutForTests(1500)
        const photo = await bigPhoto()
        const result = await h.send('Telegram', OWNER_TELEGRAM_ID, 'was siehst du da?', [
            { delayMs: 8_000, then: { text: 'zu spät' } },
        ], { image: { data: photo.data, mimeType: photo.mimeType }, messageContext: { chatId: OWNER_TELEGRAM_ID } })
        // The deadline answer comes first; a straggler of the abandoned run must not be what the owner reads as the result.
        expect(result.replies[0]).toMatch(/Bildauswertung hat zu lange gedauert/)
        expect(result.replies[0]).toMatch(/noch einmal versuchen/)
    }, T)
})
