import { describe, expect, it, vi } from 'vitest'
import { isConfirmedBargeIn, popPhrase, VoiceCallSession, type VoiceCallEvent } from './voice-call.js'

// Paket O (2.86): Freisprechen in der App. Die Logik ist aus dem Voice-Lab
// (voice_demo_app.py, Codex 03.10.) übernommen und hier ohne Netz geprüft.

describe('popPhrase (Phrasenpuffer aus dem Voice-Lab)', () => {
    it('schneidet am Satzende', () => {
        expect(popPhrase('Hallo Alfred. Wie geht')).toEqual({ phrase: 'Hallo Alfred.', rest: 'Wie geht' })
    })
    it('schneidet lange Puffer ohne Satzende an einem Leerzeichen', () => {
        const text = 'wort '.repeat(30)
        const { phrase, rest } = popPhrase(text)
        expect(phrase && phrase.length).toBeGreaterThanOrEqual(40)
        expect(phrase!.length).toBeLessThanOrEqual(90)
        expect(`${phrase} ${rest}`.replace(/\s+/g, ' ').trim()).toBe(text.trim())
    })
    it('gibt kurze Reste nur mit force heraus', () => {
        expect(popPhrase('noch nicht fertig')).toEqual({ phrase: null, rest: 'noch nicht fertig' })
        expect(popPhrase('noch nicht fertig', true)).toEqual({ phrase: 'noch nicht fertig', rest: '' })
    })
})

describe('isConfirmedBargeIn (Echo-Schutz beim Dazwischenreden)', () => {
    it('Stoppwort unterbricht sofort', () => {
        expect(isConfirmedBargeIn('stopp', 'Morgen wird es sonnig in Salzburg.')).toBe(true)
    })
    it('kurze unsichere Fragmente unterbrechen nicht', () => {
        expect(isConfirmedBargeIn('ja aber', 'Morgen wird es sonnig.')).toBe(false)
    })
    it('Lautsprecher-Echo der eigenen Antwort unterbricht nicht', () => {
        expect(isConfirmedBargeIn('morgen wird es sonnig in', 'Morgen wird es sonnig in Salzburg.')).toBe(false)
    })
    it('neue Sprache mit genug Kontext unterbricht', () => {
        expect(isConfirmedBargeIn('nein ich meinte eigentlich wien', 'Morgen wird es sonnig in Salzburg.')).toBe(true)
    })
})

function harness(options: { answer?: (text: string, signal: AbortSignal) => Promise<string> } = {}) {
    const events: VoiceCallEvent[] = []
    const spoken: string[] = []
    const session = new VoiceCallSession({
        answer: options.answer || (async text => `Du hast gesagt: ${text}. Noch etwas?`),
        speak: async (text, _voice, signal) => {
            if (signal.aborted) throw new Error('aborted')
            spoken.push(text)
            return { audio: Buffer.from(text), mime: 'audio/wav', durationSec: 1 }
        },
        emit: event => { events.push(event) },
    })
    return { session, events, spoken }
}

describe('VoiceCallSession', () => {
    it('Endtext → Pipeline-Antwort → Sprache phrasenweise, mit Turn-Nummer', async () => {
        const { session, events, spoken } = harness()
        await session.onSpeechStart()
        await session.onFinal('wie spät ist es')
        await session.idle()
        expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['speech_start', 'final', 'answer', 'audio', 'done']))
        expect(spoken.length).toBeGreaterThanOrEqual(1)
        expect(spoken.join(' ')).toContain('Du hast gesagt: wie spät ist es.')
        const final = events.find(e => e.type === 'final') as any
        expect(final.turn).toBe(1)
        expect(events.filter(e => e.type === 'audio').every((e: any) => e.turn === 1)).toBe(true)
    })

    it('leerer Endtext löst keine Antwort aus, sondern einen ehrlichen Satz', async () => {
        const answer = vi.fn(async () => 'x')
        const { session, events } = harness({ answer })
        await session.onSpeechStart()
        await session.onFinal('   ')
        await session.idle()
        expect(answer).not.toHaveBeenCalled()
        expect(events.some(e => e.type === 'notice')).toBe(true)
    })

    it('Barge-in: echte neue Sprache bricht Antwort + Sprachausgabe ab', async () => {
        let release!: () => void
        let seenSignal!: AbortSignal
        const { session, events } = harness({
            answer: (_text, signal) => { seenSignal = signal; return new Promise<string>(resolve => { release = () => resolve('Eine lange Antwort über das Wetter.') }) },
        })
        await session.onSpeechStart()
        await session.onFinal('erzähl mir was')
        expect(session.assistantActive).toBe(true)
        // Während sie „denkt“: VAD meldet Sprache, Partial ist eindeutig neu.
        await session.onSpeechStart()
        await session.onPartial('nein warte ich will etwas anderes')
        expect(seenSignal.aborted).toBe(true)
        expect(events.some(e => e.type === 'cancelled')).toBe(true)
        release()
        await session.idle()
        // Die abgebrochene Antwort wird nicht mehr gesprochen.
        expect(events.some(e => e.type === 'audio')).toBe(false)
    })

    it('Echo der eigenen Sprachausgabe bricht nicht ab', async () => {
        let release!: () => void
        const { session, events } = harness({
            answer: () => new Promise<string>(resolve => { release = () => resolve('ok') }),
        })
        await session.onSpeechStart()
        await session.onFinal('frage')
        session.noteAssistantText('Morgen wird es sonnig in Salzburg.')
        await session.onSpeechStart()
        await session.onPartial('morgen wird es sonnig')
        expect(events.some(e => e.type === 'cancelled')).toBe(false)
        release()
        await session.idle()
    })

    it('stop() beendet laufende Arbeit und meldet nichts mehr', async () => {
        const { session, events } = harness({ answer: () => new Promise<string>(() => { /* hängt */ }) })
        await session.onSpeechStart()
        await session.onFinal('hallo')
        session.stop()
        const before = events.length
        await session.onFinal('noch was')
        expect(events.length).toBe(before)
    })
})
