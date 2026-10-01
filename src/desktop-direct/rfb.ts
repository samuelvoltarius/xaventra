/**
 * Minimal RFB (VNC, RFC 6143) pieces for the /desktop gateway.
 *
 * The gateway sits between the browser (noVNC) and the real VNC server:
 * - upstream it authenticates itself with VNC-Auth (DES challenge) using the
 *   password file on the Main;
 * - towards the browser it offers only security type None — the browser never
 *   receives, needs or can request the password;
 * - every client message after ClientInit is parsed; in "view" mode input
 *   (KeyEvent, PointerEvent, ClientCutText, QEMU key, gii, SetDesktopSize)
 *   is dropped, xvp power actions are dropped in every mode, an unknown
 *   message type ends the session (fail closed).
 *
 * The password is only ever held in a Buffer passed to `vncAuthResponse`;
 * no error message, log line or response contains it.
 */
import { createCipheriv } from 'node:crypto'
import type { DesktopMode } from './config.js'

// ---------------------------------------------------------------------------
// VNC-Auth
// ---------------------------------------------------------------------------

function reverseBits(byte: number): number {
    let out = 0
    for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) out |= 1 << (7 - bit)
    return out
}

/**
 * DES-encrypt the 16-byte challenge with the (bit-reversed, zero-padded,
 * max. 8 byte) password. Single DES is not offered by OpenSSL 3's default
 * provider; two-key 3DES (EDE) with K1 = K2 is mathematically single DES.
 */
export function vncAuthResponse(challenge: Buffer, password: Buffer): Buffer {
    if (challenge.length !== 16) throw new Error('VNC-Challenge hat falsche Länge')
    const key = Buffer.alloc(8)
    for (let index = 0; index < 8 && index < password.length; index++) key[index] = reverseBits(password[index])
    const cipher = createCipheriv('des-ede-ecb', Buffer.concat([key, key]), null)
    cipher.setAutoPadding(false)
    const out = Buffer.concat([cipher.update(challenge), cipher.final()])
    key.fill(0)
    return out
}

// ---------------------------------------------------------------------------
// byte queue with exact reads
// ---------------------------------------------------------------------------

export class ByteQueue {
    private buffer = Buffer.alloc(0)
    private waiter: { size: number; resolve: (data: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null
    private closed: Error | null = null

    push(data: Buffer): void {
        if (this.closed) return
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : Buffer.from(data)
        this.settle()
    }

    fail(error: Error): void {
        if (this.closed) return
        this.closed = error
        if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.reject(error); this.waiter = null }
    }

    read(size: number, timeoutMs = 10_000): Promise<Buffer> {
        if (this.waiter) return Promise.reject(new Error('Parallele Lesezugriffe'))
        if (this.closed) return Promise.reject(this.closed)
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.waiter = null; reject(new Error('Zeitüberschreitung im VNC-Handshake')) }, timeoutMs)
            timer.unref?.()
            this.waiter = { size, resolve, reject, timer }
            this.settle()
        })
    }

    /** Remaining buffered bytes; the queue is empty afterwards. */
    takeRest(): Buffer {
        const rest = this.buffer
        this.buffer = Buffer.alloc(0)
        return rest
    }

    private settle(): void {
        if (!this.waiter || this.buffer.length < this.waiter.size) return
        const { size, resolve, timer } = this.waiter
        this.waiter = null
        clearTimeout(timer)
        const out = this.buffer.subarray(0, size)
        this.buffer = this.buffer.subarray(size)
        resolve(Buffer.from(out))
    }
}

export interface HandshakeIo {
    read(size: number): Promise<Buffer>
    write(data: Buffer): void
}

// ---------------------------------------------------------------------------
// handshakes
// ---------------------------------------------------------------------------

const VERSION_PATTERN = /^RFB (\d{3})\.(\d{3})\n$/

/** Gateway → real VNC server. Throws generic errors (never the password). */
export async function upstreamHandshake(io: HandshakeIo, password: Buffer | null): Promise<void> {
    const version = (await io.read(12)).toString('latin1')
    const match = VERSION_PATTERN.exec(version)
    if (!match || Number(match[1]) !== 3 || Number(match[2]) < 7) throw new Error('VNC-Server spricht kein RFB 3.7/3.8')
    const minor = Number(match[2]) >= 8 ? 8 : 7
    io.write(Buffer.from(`RFB 003.00${minor}\n`, 'latin1'))
    const count = (await io.read(1))[0]
    if (count === 0) throw new Error('VNC-Server lehnt die Verbindung ab')
    const types = [...(await io.read(count))]
    let chosen: number
    if (password && types.includes(2)) chosen = 2
    else if (types.includes(1)) chosen = 1
    else if (types.includes(2)) throw new Error('VNC-Server verlangt ein Passwort, aber keine Passwortdatei ist konfiguriert')
    else throw new Error('VNC-Server bietet kein unterstütztes Sicherheitsverfahren (nur None/VNC-Auth)')
    io.write(Buffer.from([chosen]))
    if (chosen === 2) io.write(vncAuthResponse(await io.read(16), password!))
    if (minor === 8 || chosen === 2) {
        const result = (await io.read(4)).readUInt32BE(0)
        if (result !== 0) throw new Error('VNC-Anmeldung fehlgeschlagen')
    }
}

/** Gateway → browser: present a server that needs no authentication. Returns the ClientInit shared flag. */
export async function clientHandshake(io: HandshakeIo): Promise<number> {
    io.write(Buffer.from('RFB 003.008\n', 'latin1'))
    const version = (await io.read(12)).toString('latin1')
    const match = VERSION_PATTERN.exec(version)
    if (!match || Number(match[1]) !== 3 || (Number(match[2]) !== 7 && Number(match[2]) !== 8)) throw new Error('Browser spricht kein RFB 3.7/3.8')
    const minor = Number(match[2])
    io.write(Buffer.from([1, 1]))
    const selected = (await io.read(1))[0]
    if (selected !== 1) throw new Error('Browser wählt ein nicht angebotenes Sicherheitsverfahren')
    if (minor === 8) io.write(Buffer.from([0, 0, 0, 0]))
    return (await io.read(1))[0]
}

// ---------------------------------------------------------------------------
// client message filter
// ---------------------------------------------------------------------------

export const RFB_CLIENT = {
    SetPixelFormat: 0, SetEncodings: 2, FramebufferUpdateRequest: 3, KeyEvent: 4, PointerEvent: 5, ClientCutText: 6,
    EnableContinuousUpdates: 150, ClientFence: 248, Xvp: 250, SetDesktopSize: 251, Gii: 253, Qemu: 255,
} as const

const MAX_CUT_TEXT = 4 * 1024 * 1024

export interface FilterResult { forward: Buffer[]; dropped: number; error?: string }

/** Size of the next complete message, 0 = need more bytes, -1 = unknown/invalid. */
function messageSize(buffer: Buffer): number {
    const type = buffer[0]
    const need = (size: number) => buffer.length >= size
    switch (type) {
        case RFB_CLIENT.SetPixelFormat: return 20
        case RFB_CLIENT.SetEncodings: return need(4) ? 4 + 4 * buffer.readUInt16BE(2) : 0
        case RFB_CLIENT.FramebufferUpdateRequest: return 10
        case RFB_CLIENT.KeyEvent: return 8
        case RFB_CLIENT.PointerEvent: return 6
        case RFB_CLIENT.ClientCutText: {
            if (!need(8)) return 0
            const length = Math.abs(buffer.readInt32BE(4))
            return length > MAX_CUT_TEXT ? -1 : 8 + length
        }
        case RFB_CLIENT.EnableContinuousUpdates: return 10
        case RFB_CLIENT.ClientFence: return need(9) ? (buffer[8] > 64 ? -1 : 9 + buffer[8]) : 0
        case RFB_CLIENT.Xvp: return 4
        case RFB_CLIENT.SetDesktopSize: return need(7) ? 8 + 16 * buffer[6] : 0
        case RFB_CLIENT.Gii: return need(4) ? 4 + buffer.readUInt16BE(2) : 0
        case RFB_CLIENT.Qemu: {
            if (!need(2)) return 0
            if (buffer[1] === 0) return 12
            if (buffer[1] === 1) {
                if (!need(4)) return 0
                const op = buffer.readUInt16BE(2)
                return op === 0 || op === 1 ? 4 : op === 2 ? 10 : -1
            }
            return -1
        }
        default: return -1
    }
}

function isInput(buffer: Buffer): boolean {
    const type = buffer[0]
    return type === RFB_CLIENT.KeyEvent || type === RFB_CLIENT.PointerEvent || type === RFB_CLIENT.ClientCutText
        || type === RFB_CLIENT.SetDesktopSize || type === RFB_CLIENT.Gii || (type === RFB_CLIENT.Qemu && buffer[1] === 0)
}

/**
 * Stateful parser for browser → server messages (after ClientInit).
 * "view": input is dropped. Both modes: xvp (reboot/shutdown) is dropped.
 */
export class RfbClientFilter {
    private buffer = Buffer.alloc(0)
    private broken = false
    constructor(readonly mode: DesktopMode) {}

    push(chunk: Buffer): FilterResult {
        if (this.broken) return { forward: [], dropped: 0, error: 'Filter bereits beendet' }
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk)
        const forward: Buffer[] = []
        let dropped = 0
        while (this.buffer.length > 0) {
            const size = messageSize(this.buffer)
            if (size < 0) {
                this.broken = true
                return { forward, dropped, error: `Unbekannte RFB-Nachricht (Typ ${this.buffer[0]})` }
            }
            if (size === 0 || this.buffer.length < size) break
            const message = this.buffer.subarray(0, size)
            this.buffer = this.buffer.subarray(size)
            if (message[0] === RFB_CLIENT.Xvp || (this.mode === 'view' && isInput(message))) dropped++
            else forward.push(Buffer.from(message))
        }
        return { forward, dropped }
    }
}
