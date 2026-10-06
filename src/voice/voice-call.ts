/**
 * 2.86 Paket O: „Anrufen“ — ein Gespräch ohne Sprechtaste.
 *
 * Übernommen aus dem Voice-Lab (Codex 03.10.2026, voice_demo_app.py auf ns1):
 * Phrasenpuffer (`pop_phrase`), Echo-Schutz beim Dazwischenreden
 * (`is_confirmed_barge_in`) und der Ablauf Endtext → Antwort → Sprache
 * phrasenweise. Neu ist nur: die Antwort kommt aus der Xaventra-Pipeline
 * (Gedächtnis, Werkzeuge, Regeln gelten), nicht direkt vom Modell.
 *
 * Diese Datei kennt kein Netz und kein Audio-Gerät; Spracherkennung (VAD,
 * Partials, Endtext) liefert der Sprachdienst, das Abspielen macht der Browser.
 */

export type VoiceName = 'female' | 'male'

export interface SpokenAudio {
    audio: Buffer
    mime: string
    durationSec: number
}

export type VoiceCallEvent =
    | { type: 'speech_start' }
    | { type: 'partial'; text: string }
    | { type: 'final'; turn: number; text: string }
    | { type: 'answer'; turn: number; text: string }
    | { type: 'audio'; turn: number; sequence: number; text: string; mime: string; durationSec: number; data: string }
    | { type: 'done'; turn: number }
    | { type: 'cancelled'; turn: number }
    | { type: 'notice'; turn: number; text: string }

/**
 * 2.87 Paket P: die Pipeline meldet unterwegs, was entsteht. Alles optional —
 * eine Pipeline ohne Strom liefert wie bisher nur den fertigen Text.
 */
export interface VoiceAnswerStream {
    /** Sichtbare Textstücke der laufenden Antwort. */
    onTextDelta(text: string): void
    /** Eine Werkzeugrunde beginnt (kurzer Füllsatz statt Stille). */
    onToolRound(names: string[]): void
    /** Ein Werkzeug ist gelaufen — bei Abbruch ehrlich nennen, nicht rückgängig machen. */
    onToolDone?(name: string, ok: boolean): void
}

export interface VoiceCallDeps {
    /** Antwort der Pipeline auf den gesprochenen Satz. Muss das Signal beachten (Dazwischenreden). */
    answer: (text: string, signal: AbortSignal, stream?: VoiceAnswerStream) => Promise<string>
    /** Eine Phrase sprechen (Sprachdienst). */
    speak: (text: string, voice: VoiceName, signal: AbortSignal) => Promise<SpokenAudio>
    emit: (event: VoiceCallEvent) => void
    voice?: VoiceName
    /** Uhr in ms (Tests). */
    now?: () => number
    /** Längere Antworten werden gekürzt vorgelesen; der volle Text steht im Gespräch. */
    maxSpokenChars?: number
}

/** Phrasen ab dieser Länge werden zusammen gesprochen (Voice-Lab: 120 Zeichen). */
const SPEAK_BATCH_CHARS = 120
/** Was während einer Werkzeugrunde gesagt wird (einmal pro Zug). */
export const TOOL_FILLER = 'Ich schau kurz nach.'

function words(text: string): string[] { return String(text || '').toLowerCase().match(/[a-z0-9äöüß]+/g) || [] }

/**
 * Was von der fertigen Antwort noch nicht gesprochen wurde. null = die fertige
 * Antwort beginnt NICHT mit dem Gesprochenen (die Pipeline hat korrigiert).
 */
export function unspokenRest(spoken: string, final: string): string | null {
    const said = words(spoken)
    const tokens = cleanForSpeech(final).split(' ').filter(Boolean)
    let index = 0
    let consumed = 0
    while (consumed < said.length && index < tokens.length) {
        for (const word of words(tokens[index])) {
            if (consumed >= said.length) return null
            if (word !== said[consumed]) return null
            consumed += 1
        }
        index += 1
    }
    if (consumed < said.length) return null
    return tokens.slice(index).join(' ')
}

const toolLabel = (name: string) => String(name || '').replace(/[_-]+/g, ' ').trim()

/** Voice-Lab `pop_phrase`: bis zum Satzzeichen, sonst bei langem Puffer am Leerzeichen 45–90. */
export function popPhrase(buffer: string, force = false): { phrase: string | null; rest: string } {
    const match = /^([\s\S]+?[.!?;:])(?:\s+|$)/.exec(buffer)
    if (match) return { phrase: match[1].trim(), rest: buffer.slice(match[0].length) }
    if (buffer.length >= 90) {
        const cut = buffer.lastIndexOf(' ', 89)
        if (cut >= 45) return { phrase: buffer.slice(0, cut).trim(), rest: buffer.slice(cut).trimStart() }
    }
    if (force && buffer.trim()) return { phrase: buffer.trim(), rest: '' }
    return { phrase: null, rest: buffer }
}

/** Teilt eine fertige Antwort in sprechbare Stücke (≈120 Zeichen, an Satzgrenzen). */
export function speakableChunks(text: string): string[] {
    const chunks: string[] = []
    let pending = cleanForSpeech(text)
    let batch = ''
    for (;;) {
        const { phrase, rest } = popPhrase(pending)
        if (!phrase) break
        pending = rest
        batch = `${batch} ${phrase}`.trim()
        if (batch.length >= SPEAK_BATCH_CHARS) { chunks.push(batch); batch = '' }
    }
    const last = popPhrase(pending, true).phrase
    if (last) batch = `${batch} ${last}`.trim()
    if (batch) chunks.push(batch)
    return chunks
}

/** Kürzt an einer Satz- oder Wortgrenze und sagt, wo der Rest steht. */
export function limitSpoken(text: string, max?: number): string {
    const clean = cleanForSpeech(text)
    if (!max || clean.length <= max) return clean
    const cut = clean.slice(0, max)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    const head = end > max / 2 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ')).trim()
    return `${head} Den Rest siehst du im Text.`
}

/** Markdown/Emoji/Links sind zum Vorlesen ungeeignet. */
export function cleanForSpeech(text: string): string {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[*_~]+/g, '')
        .replace(/[#>|]+/g, ' ')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizedWords(text: string): string[] {
    return String(text || '').toLowerCase().match(/[a-z0-9äöüß]+/g) || []
}

/** Ähnlichkeit zweier Zeichenketten (Dice über Zeichenpaare, 0..1) — Ersatz für difflib.ratio. */
function similarity(a: string, b: string): number {
    if (!a || !b) return 0
    if (a === b) return 1
    const pairs = (s: string) => { const out = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const p = s.slice(i, i + 2); out.set(p, (out.get(p) || 0) + 1) } return out }
    const left = pairs(a), right = pairs(b)
    let common = 0
    for (const [pair, count] of left) common += Math.min(count, right.get(pair) || 0)
    return (2 * common) / Math.max(1, a.length - 1 + b.length - 1)
}

const STOP_WORDS = new Set(['stopp', 'stop', 'halt', 'unterbrich', 'ruhe'])

/** Voice-Lab `is_confirmed_barge_in`: neue Sprache ja, Lautsprecher-Echo der eigenen Antwort nein. */
export function isConfirmedBargeIn(partial: string, assistantText: string): boolean {
    const words = normalizedWords(partial)
    if (!words.length) return false
    const reference = normalizedWords(assistantText)
    if (words.some(word => STOP_WORDS.has(word) && !reference.includes(word))) return true
    // Frühe Fragmente sind unsicher („Ich bin Nova“ → „Benova“): auf Kontext warten.
    if (words.length < 4) return false
    if (!reference.length) return true
    const candidate = words.join(' ')
    const ref = reference.join(' ')
    const unique = new Set(words)
    const overlap = [...unique].filter(word => reference.includes(word)).length / Math.max(1, unique.size)
    return !ref.includes(candidate) && overlap < 0.6 && similarity(candidate, ref) < 0.58
}

/**
 * Ein Anruf: Ereignisse des Sprachdienstes rein, Antwort + Audio-Phrasen raus.
 * Barge-in bricht die laufende Antwort (Pipeline-Signal) und die Sprachausgabe ab.
 */
export class VoiceCallSession {
    private turn = 0
    private controller: AbortController | null = null
    private work: Promise<void> | null = null
    private assistantReference = ''
    private speechAnnounced = false
    private stopped = false
    /** Werkzeuge, die in diesem Zug schon gelaufen sind (Wirkung bleibt bei Abbruch). */
    private executedTools: string[] = []
    /** Ehrlicher Satz für den nächsten Zug nach einem Abbruch. */
    private carryNote = ''
    private voice: VoiceName
    /** Bis wann der Browser voraussichtlich noch spricht (Voice-Lab `assistant_audio_until`). */
    private audioUntil = 0
    private readonly now: () => number

    constructor(private readonly deps: VoiceCallDeps) {
        this.voice = deps.voice === 'male' ? 'male' : 'female'
        this.now = deps.now || Date.now
    }

    /** Sie denkt, erzeugt Sprache oder der Browser spielt noch ab. */
    get assistantActive(): boolean { return Boolean(this.controller && !this.controller.signal.aborted) || this.now() < this.audioUntil }

    setVoice(voice: unknown): void { if (voice === 'male' || voice === 'female') this.voice = voice }

    /** Was sie gerade sagt (für den Echo-Vergleich beim Dazwischenreden). */
    noteAssistantText(text: string): void { this.assistantReference = `${this.assistantReference} ${text}`.trim() }

    private emit(event: VoiceCallEvent): void { if (!this.stopped) this.deps.emit(event) }

    /** VAD hat Sprache erkannt. Während sie spricht/denkt, erst nach bestätigtem Barge-in melden. */
    async onSpeechStart(): Promise<void> {
        if (this.stopped) return
        this.speechAnnounced = !this.assistantActive
        if (this.speechAnnounced) this.emit({ type: 'speech_start' })
    }

    async onPartial(text: string): Promise<void> {
        if (this.stopped || !text) return
        if (!this.speechAnnounced) {
            if (this.assistantActive && !isConfirmedBargeIn(text, this.assistantReference)) return
            this.cancel()
            this.speechAnnounced = true
            this.emit({ type: 'speech_start' })
        }
        this.emit({ type: 'partial', text })
    }

    /** Endtext eines Satzes (VAD-Ende). Nur gemeldete Sprache wird beantwortet, kein Echo. */
    async onFinal(text: string): Promise<void> {
        if (this.stopped) return
        const announced = this.speechAnnounced || !this.assistantActive
        this.speechAnnounced = false
        if (!announced) return
        const transcript = String(text || '').trim()
        this.turn += 1
        const turn = this.turn
        this.emit({ type: 'final', turn, text: transcript })
        if (!transcript) {
            this.emit({ type: 'notice', turn, text: 'Ich habe dich nicht verstanden. Sag es bitte noch einmal.' })
            return
        }
        this.cancel(false)
        const controller = new AbortController()
        this.controller = controller
        this.assistantReference = ''
        this.work = this.respond(turn, transcript, controller).finally(() => {
            if (this.controller === controller) this.controller = null
        })
    }

    private async respond(turn: number, transcript: string, controller: AbortController): Promise<void> {
        const signal = controller.signal
        const speaker = new TurnSpeaker(this, turn, signal)
        this.executedTools = []
        let pending = ''
        let streamed = false
        let fillerSaid = false
        const carry = this.carryNote
        this.carryNote = ''
        const stream: VoiceAnswerStream = {
            onTextDelta: text => {
                if (signal.aborted || this.stopped || !text) return
                if (!streamed && carry) speaker.say(carry, true)
                streamed = true
                pending += text
                for (;;) {
                    const { phrase, rest } = popPhrase(pending)
                    if (!phrase) break
                    pending = rest
                    speaker.say(cleanForSpeech(phrase))
                }
            },
            onToolRound: () => {
                if (signal.aborted || this.stopped) return
                // Halbe Sätze vor einer Werkzeugrunde werden nicht gesprochen.
                pending = ''
                if (fillerSaid) return
                fillerSaid = true
                speaker.say(TOOL_FILLER, true)
            },
            onToolDone: (name, ok) => { if (ok && name && !this.executedTools.includes(name)) this.executedTools.push(name) },
        }
        try {
            const answer = await this.deps.answer(transcript, signal, stream)
            if (signal.aborted || this.stopped) return
            this.emit({ type: 'answer', turn, text: answer })
            if (!streamed) {
                for (const chunk of speakableChunks(limitSpoken(`${carry} ${answer}`.trim(), this.deps.maxSpokenChars))) speaker.say(chunk)
            } else {
                const rest = unspokenRest(speaker.answerText, answer)
                if (rest === null) speaker.say(`Korrektur: ${limitSpoken(answer, this.deps.maxSpokenChars)}`, true)
                else if (rest) for (const chunk of speakableChunks(rest)) speaker.say(chunk)
            }
            await speaker.finished()
            if (signal.aborted || this.stopped) return
            this.emit({ type: 'done', turn })
        } catch {
            if (!signal.aborted) this.emit({ type: 'notice', turn, text: 'Das hat gerade nicht geklappt. Sag es bitte noch einmal.' })
        }
    }

    /** @internal für TurnSpeaker: eine Phrase sprechen und als Audio melden. */
    async speakOne(turn: number, sequence: number, text: string, signal: AbortSignal): Promise<boolean> {
        this.noteAssistantText(text)
        const spoken = await this.deps.speak(text, this.voice, signal)
        if (signal.aborted || this.stopped) return false
        this.audioUntil = Math.max(this.now(), this.audioUntil) + spoken.durationSec * 1000 + 500
        this.emit({ type: 'audio', turn, sequence, text, mime: spoken.mime, durationSec: spoken.durationSec, data: spoken.audio.toString('base64') })
        return true
    }

    /** @internal Obergrenze der gesprochenen Zeichen pro Zug. */
    get spokenLimit(): number | undefined { return this.deps.maxSpokenChars }

    /** Laufende Antwort abbrechen (Barge-in). Schon Erledigtes bleibt — und wird ehrlich genannt. */
    cancel(notify = true): void {
        const controller = this.controller
        const playing = this.now() < this.audioUntil
        this.audioUntil = 0
        if (!controller && !playing) return
        const wasWorking = Boolean(controller && !controller.signal.aborted)
        controller?.abort()
        this.controller = null
        this.assistantReference = ''
        if (notify) this.emit({ type: 'cancelled', turn: this.turn })
        if (wasWorking && this.executedTools.length) {
            const done = `Schon erledigt war: ${this.executedTools.map(toolLabel).join(', ')} – das bleibt so.`
            this.carryNote = `Übrigens: ${done}`
            this.emit({ type: 'notice', turn: this.turn, text: `Ich habe aufgehört. ${done}` })
        }
        this.executedTools = []
    }

    /** Wartet, bis die aktuelle Antwort fertig oder abgebrochen ist (Tests, sauberes Beenden). */
    async idle(): Promise<void> { await this.work?.catch(() => undefined) }

    stop(): void {
        this.cancel(false)
        this.stopped = true
    }
}

/**
 * Spricht die Stücke eines Zugs der Reihe nach. Was wartet, während gerade
 * gesprochen wird, geht zusammen raus (weniger Pausen, Voice-Lab ≈120 Zeichen).
 * Das erste Stück geht sofort allein raus — das ist das „erste Audio“.
 */
class TurnSpeaker {
    private queue: string[] = []
    private running: Promise<void> | null = null
    private failure: unknown = null
    private sequence = 0
    private chars = 0
    private limited = false
    /** Alles, was als Antworttext (nicht Füll-/Hinweissatz) an die Sprache ging. */
    answerText = ''

    constructor(private readonly session: VoiceCallSession, private readonly turn: number, private readonly signal: AbortSignal) {}

    say(text: string, extra = false): void {
        const clean = String(text || '').trim()
        if (!clean || this.signal.aborted || this.limited) return
        const max = this.session.spokenLimit
        if (max && !extra && this.chars + clean.length > max) {
            this.limited = true
            this.queue.push('Den Rest siehst du im Text.')
        } else {
            if (!extra) { this.chars += clean.length; this.answerText = `${this.answerText} ${clean}`.trim() }
            this.queue.push(clean)
        }
        if (!this.running) this.running = this.drain().catch(error => { this.failure = error }).finally(() => { this.running = null })
    }

    private async drain(): Promise<void> {
        while (this.queue.length && !this.signal.aborted) {
            let batch = this.queue.shift()!
            while (this.sequence > 0 && this.queue.length && batch.length < SPEAK_BATCH_CHARS) batch = `${batch} ${this.queue.shift()}`
            this.sequence += 1
            if (!(await this.session.speakOne(this.turn, this.sequence, batch, this.signal))) return
        }
    }

    async finished(): Promise<void> {
        while (this.running) await this.running
        if (this.failure && !this.signal.aborted) throw this.failure
    }
}
