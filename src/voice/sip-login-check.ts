/**
 * 2.87 Paket P: Stimmt der SIP-Zugang? — eine reine Abfrage beim Anbieter.
 *
 * Gesendet wird ein REGISTER OHNE Contact-Kopf. Nach RFC 3261 Abschnitt 10.2.3
 * ist das eine Abfrage der bestehenden Anmeldungen: der Anbieter prüft den
 * Login (Digest, RFC 2617/8760) und ändert nichts — andere Telefone bleiben
 * angemeldet, eingehende Anrufe werden nicht umgeleitet.
 *
 * Nur TLS oder TCP (ausgehende Verbindung; kein UDP-Socket, kein lauschender
 * Port). Kein Medienstrom, kein Anruf. Das Passwort verlässt diese Datei nur
 * als Digest-Hash, steht nie in einem Ergebnis, Log oder Fehlertext.
 */
import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { SipTransport } from './telefon-config.js'

export interface SipConnection {
    send(text: string): void
    /** Nächstes Datenstück der Gegenseite (beliebig geschnitten). */
    next(): Promise<string>
    close(): void
}

export interface SipLoginTarget { server: string; port: number; transport: SipTransport; login: string }
export interface SipCheckOptions {
    connect?: (target: SipLoginTarget, timeoutMs: number) => Promise<SipConnection>
    timeoutMs?: number
    /** Anzeigename des Anbieters im Satz („Zadarma“). */
    anbieter?: string
}
export interface SipCheckResult { ok: boolean; text: string }

const md5 = (value: string) => createHash('md5').update(value).digest('hex')
const token = (bytes = 8) => randomBytes(bytes).toString('hex')

export function parseSipResponse(text: string): { status: number; headers: Record<string, string> } {
    const [head] = String(text).split('\r\n\r\n')
    const [statusLine, ...lines] = head.split('\r\n')
    const status = Number(/^SIP\/2\.0 (\d{3})/.exec(statusLine || '')?.[1] || 0)
    const headers: Record<string, string> = {}
    for (const line of lines) {
        const index = line.indexOf(':')
        if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
    }
    return { status, headers }
}

function digestParams(header: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const match of String(header).replace(/^Digest\s+/i, '').matchAll(/([a-z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gi)) out[match[1].toLowerCase()] = match[2] ?? match[3]
    return out
}

/** Zerlegt einen Byte-Strom in einzelne SIP-Nachrichten (Kopf + Content-Length). */
class MessageReader {
    private buffer = ''
    constructor(private readonly connection: SipConnection) {}
    async read(): Promise<string> {
        for (;;) {
            const end = this.buffer.indexOf('\r\n\r\n')
            if (end >= 0) {
                const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(this.buffer.slice(0, end + 2))?.[1] || 0)
                const total = end + 4 + length
                if (this.buffer.length >= total) {
                    const message = this.buffer.slice(0, total)
                    this.buffer = this.buffer.slice(total)
                    return message
                }
            }
            if (this.buffer.length > 64 * 1024) throw new Error('zu große Antwort')
            this.buffer += await this.connection.next()
        }
    }
    /** Nächste endgültige Antwort (1xx überspringen). */
    async final(): Promise<{ status: number; headers: Record<string, string> }> {
        for (;;) {
            const parsed = parseSipResponse(await this.read())
            if (parsed.status >= 200) return parsed
        }
    }
}

function viaTransport(transport: SipTransport): string { return transport === 'tls' ? 'TLS' : 'TCP' }

function buildRegister(target: SipLoginTarget, state: { callId: string; tag: string; cseq: number }, authorization?: string): string {
    const uri = `sip:${target.server}`
    return [
        `REGISTER ${uri} SIP/2.0`,
        `Via: SIP/2.0/${viaTransport(target.transport)} xaventra.invalid;branch=z9hG4bK${token()};rport`,
        'Max-Forwards: 70',
        `From: <sip:${target.login}@${target.server}>;tag=${state.tag}`,
        `To: <sip:${target.login}@${target.server}>`,
        `Call-ID: ${state.callId}`,
        `CSeq: ${state.cseq} REGISTER`,
        ...(authorization ? [authorization] : []),
        'User-Agent: Xaventra',
        'Content-Length: 0',
        '', '',
    ].join('\r\n')
}

function authorizationHeader(kind: 'Authorization' | 'Proxy-Authorization', challenge: string, target: SipLoginTarget, password: string): string {
    const params = digestParams(challenge)
    const uri = `sip:${target.server}`
    const ha1 = md5(`${target.login}:${params.realm || ''}:${password}`)
    const ha2 = md5(`REGISTER:${uri}`)
    const qop = (params.qop || '').split(',').map(item => item.trim()).includes('auth') ? 'auth' : ''
    const nc = '00000001'
    const cnonce = token()
    const response = qop ? md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${params.nonce}:${ha2}`)
    const fields = [
        `username="${target.login}"`, `realm="${params.realm || ''}"`, `nonce="${params.nonce || ''}"`, `uri="${uri}"`, `response="${response}"`, 'algorithm=MD5',
        ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
        ...(params.opaque ? [`opaque="${params.opaque}"`] : []),
    ]
    return `${kind}: Digest ${fields.join(', ')}`
}

/** Echte Verbindung: TLS (Standard) oder TCP; UDP wird für die Prüfung über TCP versucht. */
export function connectSip(target: SipLoginTarget, timeoutMs: number): Promise<SipConnection> {
    return new Promise((resolve, reject) => {
        const socket = target.transport === 'tls'
            ? tlsConnect({ host: target.server, port: target.port, servername: target.server })
            : netConnect({ host: target.server, port: target.port })
        const chunks: string[] = []
        const waiting: Array<(value: string) => void> = []
        const failures: Array<(error: Error) => void> = []
        let closed = false
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout')))
        socket.setEncoding('utf8')
        socket.on('data', (data: string) => { const next = waiting.shift(); failures.shift(); if (next) next(data); else chunks.push(data) })
        socket.on('error', error => { closed = true; for (const fail of failures.splice(0)) fail(error); reject(error) })
        socket.on('close', () => { closed = true; for (const fail of failures.splice(0)) fail(new Error('geschlossen')) })
        socket.once(target.transport === 'tls' ? 'secureConnect' : 'connect', () => resolve({
            send: text => { socket.write(text) },
            next: () => chunks.length ? Promise.resolve(chunks.shift()!) : closed ? Promise.reject(new Error('geschlossen'))
                : new Promise((ok, fail) => { waiting.push(ok); failures.push(fail) }),
            close: () => { closed = true; socket.destroy() },
        }))
    })
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})

export async function checkSipLogin(target: SipLoginTarget, password: string, options: SipCheckOptions = {}): Promise<SipCheckResult> {
    const wer = options.anbieter || 'dem Telefonanbieter'
    const beiWem = options.anbieter ? `bei ${options.anbieter}` : 'beim Telefonanbieter'
    if (!target.server || !target.login) return { ok: false, text: 'Server oder Login fehlt noch.' }
    if (!password) return { ok: false, text: 'Das Passwort fehlt noch.' }
    const timeoutMs = options.timeoutMs ?? 8_000
    const checked: SipLoginTarget = { ...target, transport: target.transport === 'udp' ? 'tcp' : target.transport }
    let connection: SipConnection
    try {
        connection = await withTimeout((options.connect || connectSip)(checked, timeoutMs), timeoutMs)
    } catch (error) {
        return /timeout/i.test(String((error as Error)?.message)) ? { ok: false, text: 'Der Telefonanbieter antwortet nicht. Später noch einmal prüfen.' }
            : { ok: false, text: 'Der Telefonanbieter ist gerade nicht erreichbar. Später noch einmal prüfen.' }
    }
    const reader = new MessageReader(connection)
    const state = { callId: `${token(12)}@xaventra.invalid`, tag: token(), cseq: 1 }
    try {
        connection.send(buildRegister(checked, state))
        let response = await withTimeout(reader.final(), timeoutMs)
        if (response.status === 401 || response.status === 407) {
            const kind = response.status === 401 ? 'Authorization' : 'Proxy-Authorization'
            const challenge = response.headers[response.status === 401 ? 'www-authenticate' : 'proxy-authenticate'] || ''
            state.cseq += 1
            connection.send(buildRegister(checked, state, authorizationHeader(kind, challenge, checked, password)))
            response = await withTimeout(reader.final(), timeoutMs)
            if (response.status === 401 || response.status === 407) return { ok: false, text: `Anmeldung ${beiWem} hat nicht geklappt — Passwort prüfen.` }
        }
        if (response.status >= 200 && response.status < 300) return { ok: true, text: `Telefon angemeldet: der Zugang ${beiWem} stimmt.` }
        if (response.status === 403 || response.status === 404) return { ok: false, text: `Anmeldung ${beiWem} hat nicht geklappt — Login und Passwort prüfen.` }
        return { ok: false, text: `${wer.charAt(0).toUpperCase()}${wer.slice(1)} hat die Anmeldung abgelehnt (Code ${response.status}).` }
    } catch (error) {
        return /timeout/i.test(String((error as Error)?.message)) ? { ok: false, text: 'Der Telefonanbieter antwortet nicht. Später noch einmal prüfen.' }
            : { ok: false, text: 'Die Verbindung zum Telefonanbieter ist abgebrochen. Später noch einmal prüfen.' }
    } finally {
        try { connection.close() } catch { /* schon zu */ }
    }
}
