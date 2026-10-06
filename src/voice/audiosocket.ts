/**
 * 2.87 Paket P: Asterisk-AudioSocket — das kleine TCP-Protokoll, mit dem eine
 * Telefonanlage das Gespräch an einen lokalen Dienst reicht.
 *
 * Rahmen: 1 Byte Art, 2 Byte Länge (Big Endian), Nutzlast.
 *   0x00 Auflegen · 0x01 Kennung (16 Byte UUID) · 0x03 Tastenton (1 Zeichen)
 *   0x10 Audio: signed linear 16 bit, 8 kHz, mono, Little Endian · 0xFF Fehler
 * Quelle: Asterisk-Doku „AudioSocket“ (app_audiosocket / res_audiosocket).
 *
 * Dazu einfache Umrechnungen: 8 kHz ⇄ 16 kHz (Sprachdienst) und WAV → 8 kHz.
 */
export const AS_HANGUP = 0x00
export const AS_UUID = 0x01
export const AS_DTMF = 0x03
export const AS_AUDIO = 0x10
export const AS_ERROR = 0xff

/** 20 ms bei 8 kHz, 16 bit. */
export const PHONE_FRAME_BYTES = 320
export const PHONE_RATE = 8000
/** Obergrenze einer Nutzlast (Schutz vor kaputten Rahmen). */
const MAX_PAYLOAD = 16 * 1024

export interface AudioSocketFrame { type: number; payload: Buffer }

export function encodeFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
    const head = Buffer.alloc(3)
    head.writeUInt8(type, 0)
    head.writeUInt16BE(payload.length, 1)
    return Buffer.concat([head, payload])
}

/** Zerlegt einen TCP-Strom in Rahmen; zu große oder unbekannte Längen = Fehler. */
export class FrameReader {
    private buffer = Buffer.alloc(0)
    push(chunk: Buffer): AudioSocketFrame[] {
        this.buffer = Buffer.concat([this.buffer, chunk])
        const frames: AudioSocketFrame[] = []
        while (this.buffer.length >= 3) {
            const length = this.buffer.readUInt16BE(1)
            if (length > MAX_PAYLOAD) throw new Error('AudioSocket-Rahmen zu groß')
            if (this.buffer.length < 3 + length) break
            frames.push({ type: this.buffer.readUInt8(0), payload: this.buffer.subarray(3, 3 + length) })
            this.buffer = this.buffer.subarray(3 + length)
        }
        return frames
    }
}

/** 16 Byte → „xxxxxxxx-xxxx-…“ */
export function uuidFromBytes(bytes: Buffer): string {
    const hex = bytes.toString('hex')
    if (hex.length !== 32) return ''
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function samples(pcm: Buffer): Int16Array {
    const count = Math.floor(pcm.length / 2)
    const out = new Int16Array(count)
    for (let i = 0; i < count; i++) out[i] = pcm.readInt16LE(i * 2)
    return out
}

function toBuffer(values: ArrayLike<number>): Buffer {
    const out = Buffer.alloc(values.length * 2)
    for (let i = 0; i < values.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(values[i]))), i * 2)
    return out
}

/** Lineare Umrechnung der Abtastrate (PCM16 mono). Für Sprache ausreichend. */
export function resamplePcm16(pcm: Buffer, from: number, to: number): Buffer {
    if (from === to || !pcm.length) return Buffer.from(pcm)
    const input = samples(pcm)
    const ratio = from / to
    const length = Math.max(1, Math.floor(input.length / ratio))
    const out = new Float64Array(length)
    for (let i = 0; i < length; i++) {
        if (ratio > 1) {
            // Herunter: über das Fenster mitteln (einfacher Tiefpass gegen Aliasing).
            const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio))
            let sum = 0
            for (let j = start; j < end; j++) sum += input[j]
            out[i] = end > start ? sum / (end - start) : input[Math.min(start, input.length - 1)]
        } else {
            const position = i * ratio
            const left = Math.floor(position)
            const right = Math.min(input.length - 1, left + 1)
            out[i] = input[left] + (input[right] - input[left]) * (position - left)
        }
    }
    return toBuffer(out)
}

/** WAV (PCM 16 bit, beliebige Rate, mono/stereo) → PCM16 mono mit Rate. */
export function wavToPcm16(wav: Buffer): { pcm: Buffer; sampleRate: number } {
    if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('kein WAV')
    let offset = 12
    let channels = 1, sampleRate = 0, bits = 0
    let data: Buffer | null = null
    while (offset + 8 <= wav.length) {
        const id = wav.toString('ascii', offset, offset + 4)
        const size = wav.readUInt32LE(offset + 4)
        const body = wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size))
        if (id === 'fmt ') {
            if (body.readUInt16LE(0) !== 1) throw new Error('WAV nicht PCM')
            channels = body.readUInt16LE(2); sampleRate = body.readUInt32LE(4); bits = body.readUInt16LE(14)
        } else if (id === 'data') data = body
        offset += 8 + size + (size % 2)
    }
    if (!data || bits !== 16 || !sampleRate || channels < 1) throw new Error('WAV-Format nicht unterstützt')
    if (channels === 1) return { pcm: Buffer.from(data), sampleRate }
    const input = samples(data)
    const frames = Math.floor(input.length / channels)
    const mono = new Float64Array(frames)
    for (let i = 0; i < frames; i++) { let sum = 0; for (let c = 0; c < channels; c++) sum += input[i * channels + c]; mono[i] = sum / channels }
    return { pcm: toBuffer(mono), sampleRate }
}

/** Zerlegt PCM16 8 kHz in 20-ms-Rahmen (letzter mit Stille aufgefüllt). */
export function phoneFrames(pcm8k: Buffer): Buffer[] {
    const frames: Buffer[] = []
    for (let offset = 0; offset < pcm8k.length; offset += PHONE_FRAME_BYTES) {
        const frame = Buffer.alloc(PHONE_FRAME_BYTES)
        pcm8k.copy(frame, 0, offset, Math.min(pcm8k.length, offset + PHONE_FRAME_BYTES))
        frames.push(frame)
    }
    return frames
}
