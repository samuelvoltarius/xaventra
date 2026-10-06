/**
 * 2.86.1 Ergänzung b: der Telegram-Sprachweg (Paket O) nutzt whisper-gpu im
 * eigenen Netz; zu lange, nicht teilbare Nachrichten werden ehrlich abgelehnt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ whisper: null as null | { endpoint: string }, result: { text: 'Licht aus', stuecke: 1 } as any, error: null as null | Error }))
vi.mock('../voice/voice-mesh.js', async importOriginal => ({ ...(await importOriginal<any>()), discoverVoiceService: vi.fn(async () => null) }))
vi.mock('../voice/voice-input.js', () => ({ transcribe: vi.fn(async () => { throw new Error('whisper missing') }) }))
vi.mock('../voice/whisper-gpu.js', async importOriginal => ({
    ...(await importOriginal<any>()),
    discoverWhisperGpu: vi.fn(async () => state.whisper),
    transcribeWithWhisperGpu: vi.fn(async () => { if (state.error) throw state.error; return state.result }),
}))

import { transcribeVoiceNote, voiceTooLongNotice } from './telegram-voice.js'
import { transcribeWithWhisperGpu, WhisperZuLangError } from '../voice/whisper-gpu.js'

beforeEach(() => { state.whisper = { endpoint: 'http://192.0.2.40:8017' }; state.error = null; state.result = { text: 'Licht aus', stuecke: 1 } })

describe('2.86.1 b: Sprachnachricht über whisper-gpu', () => {
    it('ohne eigenen Sprachdienst versteht whisper-gpu die Nachricht (mit Länge aus Telegram)', async () => {
        const heard = await transcribeVoiceNote(Buffer.from('OggS'), 'audio/ogg', undefined, 42)
        expect(heard).toEqual({ text: 'Licht aus', via: 'whisper-gpu' })
        expect((transcribeWithWhisperGpu as any).mock.calls.at(-1)[3]).toMatchObject({ durationSec: 42 })
    })

    it('zu lang und nicht teilbar → ehrlicher Satz statt „kann nicht anhören“', async () => {
        state.error = new WhisperZuLangError(95)
        const heard = await transcribeVoiceNote(Buffer.from('OggS'), 'audio/ogg', undefined, 95)
        expect(heard).toEqual({ text: '', via: 'whisper-gpu', zuLang: true })
        expect(voiceTooLongNotice()).toMatch(/30 Sekunden/)
    })

    it('leerer Text gilt nicht als verstanden', async () => {
        state.result = { text: '', stuecke: 1 }
        expect(await transcribeVoiceNote(Buffer.from('OggS'), 'audio/ogg', undefined, 5)).toBeNull()
    })
})
