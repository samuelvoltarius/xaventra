import { describe, expect, it, vi } from 'vitest'
import { isConfirmedBargeIn, popPhrase, VoiceCallSession, type VoiceCallDeps, type VoiceCallEvent } from './voice-call.js'

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

    it('solange die Antwort noch abgespielt wird, gilt der Echo-Schutz weiter (kein Antworten auf sich selbst)', async () => {
        let now = 1_000
        const events: VoiceCallEvent[] = []
        const answer = vi.fn(async () => 'Morgen wird es sonnig in Salzburg.')
        const session = new VoiceCallSession({
            answer, now: () => now,
            speak: async text => ({ audio: Buffer.from(text), mime: 'audio/wav', durationSec: 3 }),
            emit: event => { events.push(event) },
        })
        await session.onSpeechStart()
        await session.onFinal('wie wird das wetter')
        await session.idle()
        expect(session.assistantActive).toBe(true) // Browser spielt noch 3 s
        await session.onSpeechStart()
        await session.onPartial('morgen wird es sonnig')
        await session.onFinal('morgen wird es sonnig')
        expect(answer).toHaveBeenCalledTimes(1)
        now += 4_000
        expect(session.assistantActive).toBe(false)
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

// 2.87 Paket P: die Antwort wird gesprochen, während die Pipeline noch arbeitet.
describe('VoiceCallSession — wortweise sprechen (Paket P)', () => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

    function streamingHarness(answer: VoiceCallDeps['answer'], speakMs = 5) {
        const events: Array<VoiceCallEvent & { at: number }> = []
        const spoken: string[] = []
        const started = performance.now()
        const session = new VoiceCallSession({
            answer,
            speak: async (text, _voice, signal) => {
                await wait(speakMs)
                if (signal.aborted) throw new Error('aborted')
                spoken.push(text)
                return { audio: Buffer.from(text), mime: 'audio/wav', durationSec: 0.01 }
            },
            emit: event => { events.push({ ...event, at: performance.now() - started }) },
        })
        return { session, events, spoken }
    }

    it('erstes Audio vor Pipeline-Ende (Fake-Modell mit 300 ms Restarbeit)', async () => {
        let pipelineDoneAt = 0
        const started = performance.now()
        const { session, events, spoken } = streamingHarness(async (_text, _signal, stream) => {
            stream?.onTextDelta('Guten Morgen, ')
            stream?.onTextDelta('Alfred. Heute ')
            await wait(150)
            stream?.onTextDelta('wird es sonnig. ')
            await wait(150)
            stream?.onTextDelta('Am Abend kommt Regen.')
            pipelineDoneAt = performance.now() - started
            return 'Guten Morgen, Alfred. Heute wird es sonnig. Am Abend kommt Regen.'
        })
        await session.onSpeechStart()
        await session.onFinal('wie wird das wetter')
        await session.idle()
        const firstAudio = events.find(event => event.type === 'audio')!
        expect(firstAudio).toBeTruthy()
        expect(firstAudio.at).toBeLessThan(pipelineDoneAt)
        expect((firstAudio as any).text).toBe('Guten Morgen, Alfred.')
        // Alles genau einmal gesprochen, nichts doppelt.
        expect(spoken.join(' ')).toBe('Guten Morgen, Alfred. Heute wird es sonnig. Am Abend kommt Regen.')
        expect(events.at(-1)!.type).toBe('done')
        console.log(`[Paket P] erstes Audio nach ${firstAudio.at.toFixed(0)} ms, Pipeline fertig nach ${pipelineDoneAt.toFixed(0)} ms`)
    })

    it('Werkzeugrunde bekommt einen kurzen Füllsatz statt Stille (einmal pro Zug)', async () => {
        const { session, spoken } = streamingHarness(async (_text, _signal, stream) => {
            stream?.onToolRound(['ha_state'])
            await wait(30)
            stream?.onToolRound(['ha_state'])
            stream?.onToolDone?.('ha_state', true)
            stream?.onTextDelta('Im Wohnzimmer sind es 21 Grad.')
            return 'Im Wohnzimmer sind es 21 Grad.'
        })
        await session.onSpeechStart()
        await session.onFinal('wie warm ist es im wohnzimmer')
        await session.idle()
        expect(spoken).toEqual(['Ich schau kurz nach.', 'Im Wohnzimmer sind es 21 Grad.'])
    })

    it('ändert die Pipeline die Antwort nachträglich (Prüfung), wird ehrlich korrigiert', async () => {
        const { session, spoken, events } = streamingHarness(async (_text, _signal, stream) => {
            stream?.onTextDelta('Das Licht ist aus. ')
            await wait(20)
            return 'Ich konnte nicht prüfen, ob das Licht aus ist.'
        })
        await session.onSpeechStart()
        await session.onFinal('ist das licht aus')
        await session.idle()
        expect(spoken[0]).toBe('Das Licht ist aus.')
        expect(spoken.slice(1).join(' ')).toBe('Korrektur: Ich konnte nicht prüfen, ob das Licht aus ist.')
        expect((events.find(event => event.type === 'answer') as any).text).toBe('Ich konnte nicht prüfen, ob das Licht aus ist.')
    })

    it('ergänzt die Pipeline nur etwas, wird nur der Rest gesprochen', async () => {
        const { session, spoken } = streamingHarness(async (_text, _signal, stream) => {
            stream?.onTextDelta('Es ist 10:30 Uhr. ')
            await wait(20)
            return 'Es ist 10:30 Uhr. Sonst noch etwas?'
        })
        await session.onSpeechStart()
        await session.onFinal('wie spät')
        await session.idle()
        expect(spoken.join(' ')).toBe('Es ist 10:30 Uhr. Sonst noch etwas?')
    })

    it('Barge-in bricht Strom und Werkzeugrunde ab und sagt ehrlich, was schon erledigt war', async () => {
        let seen!: AbortSignal
        let calls = 0
        const { session, events, spoken } = streamingHarness(async (_text, signal, stream) => {
            if (++calls > 1) return 'Gut.'
            seen = signal
            stream?.onToolRound(['geraet_schalten'])
            stream?.onToolDone?.('geraet_schalten', true)
            stream?.onTextDelta('Ich habe die Stehlampe ')
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
            stream?.onTextDelta('eingeschaltet und noch viel mehr.')
            return 'zu spät'
        })
        await session.onSpeechStart()
        await session.onFinal('mach die stehlampe an und erzähl mir was')
        await wait(30)
        await session.onSpeechStart()
        await session.onPartial('stopp')
        await session.idle()
        expect(seen.aborted).toBe(true)
        expect(spoken.join(' ')).not.toContain('eingeschaltet')
        const notice = events.find(event => event.type === 'notice') as any
        expect(notice.text).toContain('Schon erledigt war: geraet schalten')
        expect(notice.text).toContain('bleibt so')
        // Der nächste Zug beginnt mit demselben ehrlichen Satz (gesprochen, nicht nur Text).
        await session.onSpeechStart()
        await session.onFinal('was ist jetzt')
        await session.idle()
        expect(spoken.at(-1)).toBe('Übrigens: Schon erledigt war: geraet schalten – das bleibt so. Gut.')
    })
})

describe('VoiceCallSession — Werkzeug wird nach dem Abbruch fertig (Paket P)', () => {
    it('nennt die Wirkung trotzdem ehrlich', async () => {
        let finishTool!: () => void
        const events: VoiceCallEvent[] = []
        const session = new VoiceCallSession({
            answer: async (_text, signal, stream) => {
                await new Promise<void>(resolve => { finishTool = resolve })
                stream?.onToolDone?.('licht_schalten', true)
                return signal.aborted ? '' : 'ok'
            },
            speak: async text => ({ audio: Buffer.from(text), mime: 'audio/wav', durationSec: 0.01 }),
            emit: event => { events.push(event) },
        })
        await session.onSpeechStart()
        await session.onFinal('licht an')
        await session.onSpeechStart()
        await session.onPartial('stopp')
        finishTool()
        await session.idle()
        expect((events.filter(e => e.type === 'notice').at(-1) as any).text).toBe('Nach dem Abbruch ist noch fertig geworden: licht schalten – das bleibt so.')
    })
})
