import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readVoicePrefs, voiceReplyRequest, writeVoicePrefs } from './voice-prefs.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'voice-prefs-')); dirs.push(dir); return join(dir, 'voice-prefs.json') }

describe('voiceReplyRequest — „antworte per Sprache“ in Alltagssprache', () => {
    it.each([
        ['Antworte mir per Sprache', 'once'],
        ['kannst du mir das vorlesen', 'once'],
        ['sag es mir per Sprachnachricht', 'once'],
        ['Antworte ab jetzt immer per Sprache', 'on'],
        ['ab sofort bitte mit Stimme antworten', 'on'],
        ['antworte wieder per Text', 'off'],
        ['keine Sprachnachrichten mehr bitte', 'off'],
        ['Wie wird das Wetter morgen?', null],
        ['Die Sprache von Python ist schön', null],
    ])('%s → %s', (text, expected) => {
        expect(voiceReplyRequest(text)).toBe(expected)
    })
})

describe('Owner-Einstellung', () => {
    it('Standard: Text-Antwort, Stimme Ramona; Änderungen bleiben gespeichert', () => {
        const path = file()
        expect(readVoicePrefs(path)).toEqual({ replyByVoice: false, voice: 'female' })
        writeVoicePrefs({ replyByVoice: true }, path)
        expect(readVoicePrefs(path)).toEqual({ replyByVoice: true, voice: 'female' })
        writeVoicePrefs({ voice: 'male' }, path)
        expect(readVoicePrefs(path)).toEqual({ replyByVoice: true, voice: 'male' })
        writeVoicePrefs({ voice: 'robot' as any }, path)
        expect(readVoicePrefs(path).voice).toBe('male')
    })
})
