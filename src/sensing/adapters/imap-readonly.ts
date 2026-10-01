/**
 * Minimaler, NUR LESENDER IMAP-Client für den Mail-Sensor.
 *
 * - Postfach wird mit EXAMINE geöffnet (read-only), Inhalte nur mit
 *   BODY.PEEK geholt (setzt kein \Seen). Kein STORE/COPY/MOVE/EXPUNGE/APPEND.
 * - Holt Kopfzeilen (From/Subject/Date) und höchstens die ersten 2 KB Text,
 *   nur damit die Stichwortsuche laufen kann. Der Text verlässt dieses Modul
 *   nie Richtung Log oder Sink (siehe mail.ts).
 * - Der Transport ist injizierbar (Tests mit Fake-Server, keine echten Logins).
 */

import { connect as tlsConnect } from 'node:tls'
import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'

export interface ImapCredentials { host: string; port: number; user: string; password: string; tls: boolean }
export interface MailHeader { id: string; from: string; subject: string; date: string; text: string }

export type ImapConnect = (host: string, port: number, tls: boolean) => Duplex

const READ_ONLY_COMMANDS = /^(LOGIN|CAPABILITY|EXAMINE|UID SEARCH|UID FETCH|LOGOUT|NOOP)\b/

export const defaultImapConnect: ImapConnect = (host, port, tls) =>
    tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port })

interface Untagged { text: string; literals: Buffer[] }

/** Splits buffered server output into complete untagged responses up to the tagged one. */
export function splitImapResponse(buf: Buffer, tag: string): { untagged: Untagged[]; tagged: string } | null {
    let pos = 0
    let current: Untagged = { text: '', literals: [] }
    const untagged: Untagged[] = []
    while (pos < buf.length) {
        const end = buf.indexOf('\r\n', pos)
        if (end < 0) return null
        const line = buf.toString('latin1', pos, end)
        current.text += line
        const literal = /\{(\d+)\}$/.exec(line)
        if (literal) {
            const size = Number(literal[1])
            if (end + 2 + size > buf.length) return null
            current.literals.push(buf.subarray(end + 2, end + 2 + size))
            current.text += `\u0000${current.literals.length - 1}\u0000`
            pos = end + 2 + size
            continue
        }
        pos = end + 2
        if (current.text.startsWith(`${tag} `)) return { untagged, tagged: current.text }
        untagged.push(current)
        current = { text: '', literals: [] }
    }
    return null
}

function decodeWord(charset: string, encoding: string, data: string): string {
    try {
        const bytes = encoding.toUpperCase() === 'B'
            ? Buffer.from(data, 'base64')
            : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
        return new TextDecoder(/utf-?8/i.test(charset) ? 'utf-8' : 'latin1').decode(bytes)
    } catch { return data }
}

export function decodeMimeWords(value: string): string {
    return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, charset, enc, data) => decodeWord(charset, enc, data))
}

export function parseHeaderBlock(raw: string): Record<string, string> {
    const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ')
    const out: Record<string, string> = {}
    for (const line of unfolded.split(/\r?\n/)) {
        const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
        if (m) out[m[1].toLowerCase()] = decodeMimeWords(m[2].trim())
    }
    return out
}

export function parseFetch(untagged: Untagged[]): MailHeader[] {
    const mails: MailHeader[] = []
    for (const item of untagged) {
        if (!/^\* \d+ FETCH /i.test(item.text)) continue
        const uid = /UID (\d+)/i.exec(item.text)?.[1]
        if (!uid) continue
        let header = ''
        let text = ''
        const parts = item.text.split(/\u0000(\d+)\u0000/)
        for (let i = 1; i < parts.length; i += 2) {
            const before = parts[i - 1]
            const literal = item.literals[Number(parts[i])]?.toString('utf8') || ''
            if (/HEADER/i.test(before.slice(-60))) header = literal
            else if (/TEXT/i.test(before.slice(-60))) text = literal
        }
        const headers = parseHeaderBlock(header)
        mails.push({ id: uid, from: headers.from || '', subject: headers.subject || '', date: headers.date || '', text: text.slice(0, 2048) })
    }
    return mails
}

const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export class ImapReadonlySession {
    private buffer = Buffer.alloc(0)
    private pending: { tag: string; resolve: (value: { untagged: Untagged[]; tagged: string }) => void; reject: (error: Error) => void } | null = null
    private greeting: Promise<void>
    private counter = 0
    private closed = false
    private readonly prefix = `x${randomBytes(2).toString('hex')}`

    constructor(private readonly socket: Duplex, private readonly signal?: AbortSignal) {
        let greeted: () => void
        let failed: (error: Error) => void
        this.greeting = new Promise((resolve, reject) => { greeted = resolve; failed = reject })
        let haveGreeting = false
        socket.on('data', (chunk: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, chunk])
            if (!haveGreeting) {
                const end = this.buffer.indexOf('\r\n')
                if (end < 0) return
                const line = this.buffer.toString('latin1', 0, end)
                this.buffer = this.buffer.subarray(end + 2)
                haveGreeting = true
                if (/^\* (OK|PREAUTH)/i.test(line)) greeted(); else failed(new Error('IMAP: unerwartete Begrüßung'))
            }
            this.drain()
        })
        const fail = (error: Error) => {
            this.closed = true
            if (!haveGreeting) failed(error)
            this.pending?.reject(error)
            this.pending = null
        }
        socket.on('error', error => fail(new Error(`IMAP-Verbindung: ${error.name}`)))
        socket.on('close', () => fail(new Error('IMAP-Verbindung geschlossen')))
        signal?.addEventListener('abort', () => { fail(new Error('IMAP: abgebrochen')); socket.destroy() }, { once: true })
    }

    private drain(): void {
        if (!this.pending) return
        const parsed = splitImapResponse(this.buffer, this.pending.tag)
        if (!parsed) return
        this.buffer = Buffer.alloc(0)
        const { resolve } = this.pending
        this.pending = null
        resolve(parsed)
    }

    async command(command: string): Promise<{ untagged: Untagged[]; tagged: string }> {
        if (!READ_ONLY_COMMANDS.test(command)) throw new Error('IMAP: nur lesende Befehle erlaubt')
        await this.greeting
        if (this.closed) throw new Error('IMAP-Verbindung geschlossen')
        const tag = `${this.prefix}${++this.counter}`
        const result = new Promise<{ untagged: Untagged[]; tagged: string }>((resolve, reject) => { this.pending = { tag, resolve, reject } })
        this.socket.write(`${tag} ${command}\r\n`)
        this.drain()
        const response = await result
        if (!new RegExp(`^${tag} OK`, 'i').test(response.tagged)) {
            // Never echo server text for LOGIN (could contain the user name or hints).
            throw new Error(command.startsWith('LOGIN') ? 'IMAP-Anmeldung abgelehnt' : `IMAP ${command.split(' ').slice(0, 2).join(' ')} fehlgeschlagen`)
        }
        return response
    }

    close(): void {
        try { this.socket.write(`${this.prefix}z LOGOUT\r\n`) } catch { /* closed */ }
        this.socket.destroy()
    }
}

/** Fetches mails with UID > sinceUid (first run: only the newest UID, no history). */
export async function fetchNewMailsImap(credentials: ImapCredentials, sinceUid: number | undefined, options: { connect?: ImapConnect; signal?: AbortSignal; max?: number } = {}): Promise<{ mails: MailHeader[]; lastUid: number; uidValidity?: string }> {
    const socket = (options.connect || defaultImapConnect)(credentials.host, credentials.port, credentials.tls)
    const session = new ImapReadonlySession(socket, options.signal)
    try {
        await session.command(`LOGIN ${quote(credentials.user)} ${quote(credentials.password)}`)
        const examine = await session.command('EXAMINE INBOX')
        const uidValidity = examine.untagged.map(item => /UIDVALIDITY (\d+)/i.exec(item.text)?.[1]).find(Boolean)
        const uidNext = Number(examine.untagged.map(item => /UIDNEXT (\d+)/i.exec(item.text)?.[1]).find(Boolean) || 0)
        if (sinceUid === undefined) return { mails: [], lastUid: Math.max(0, uidNext - 1), uidValidity }
        const search = await session.command(`UID SEARCH UID ${sinceUid + 1}:*`)
        const uids = search.untagged.flatMap(item => (/^\* SEARCH/i.test(item.text) ? item.text.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number) : []))
            .filter(uid => Number.isFinite(uid) && uid > sinceUid)
            .sort((a, b) => a - b)
            .slice(-(options.max ?? 20))
        if (!uids.length) return { mails: [], lastUid: sinceUid, uidValidity }
        const fetched = await session.command(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.2048>)`)
        return { mails: parseFetch(fetched.untagged), lastUid: uids[uids.length - 1], uidValidity }
    } finally {
        session.close()
    }
}
