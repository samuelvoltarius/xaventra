import { Duplex } from 'node:stream'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSensingConfig } from './config.js'
import { SensingBus } from './event-bus.js'
import { JsonlEventSink, JsonlThoughtSink } from './ports.js'
import { createMailAdapter, mailToEvent, resolveMailCredentials } from './adapters/mail.js'
import { decodeMimeWords, splitImapResponse } from './adapters/imap-readonly.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const BODY_SECRET = 'GEHEIMER-MAILTEXT-Kontonummer-AT611904300234573201'
const PASSWORD = 'pw-Imap-Sehr-Geheim-4711'

function mailCfg(extra: Record<string, unknown> = {}) {
    return parseSensingConfig({ enabled: true, adapters: { mail: { enabled: true, knownContacts: ['@firma-x.at'], ...extra } } }).adapters.mail
}

/** In-memory IMAP server: answers like a real one, records every command. */
function fakeImap(commands: string[], mails: Array<{ uid: number; from: string; subject: string; body: string }>) {
    let buffer = ''
    const socket = new Duplex({
        read() {},
        write(chunk, _enc, cb) {
            buffer += chunk.toString()
            let idx
            while ((idx = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 2)
                const [tag, ...rest] = line.split(' ')
                const cmd = rest.join(' ')
                commands.push(cmd.replace(/^LOGIN .*/, 'LOGIN ***'))
                if (/^LOGIN/.test(cmd)) socket.push(`${tag} OK LOGIN done\r\n`)
                else if (/^EXAMINE/.test(cmd)) socket.push(`* 3 EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n* OK [UIDNEXT 11] ok\r\n${tag} OK [READ-ONLY] EXAMINE done\r\n`)
                else if (/^UID SEARCH/.test(cmd)) socket.push(`* SEARCH ${mails.map(m => m.uid).join(' ')}\r\n${tag} OK SEARCH done\r\n`)
                else if (/^UID FETCH/.test(cmd)) {
                    let out = ''
                    mails.forEach((m, i) => {
                        const header = `From: ${m.from}\r\nSubject: ${m.subject}\r\nDate: Wed, 1 Oct 2026 09:00:00 +0200\r\n\r\n`
                        out += `* ${i + 1} FETCH (UID ${m.uid} BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(header)}}\r\n${header} BODY[TEXT]<0> {${Buffer.byteLength(m.body)}}\r\n${m.body})\r\n`
                    })
                    socket.push(`${out}${tag} OK FETCH done\r\n`)
                } else if (/^LOGOUT/.test(cmd)) socket.push(`* BYE\r\n${tag} OK\r\n`)
                else socket.push(`${tag} BAD unknown\r\n`)
            }
            cb()
        },
    })
    setImmediate(() => socket.push('* OK IMAP4rev1 ready\r\n'))
    return socket
}

describe('Mail-Sensor ohne Zugangsdaten', () => {
    it('tut nichts und rät nichts (kein Host aus der Adresse, kein Netz, keine Env-Suche)', async () => {
        const fetchSpy = vi.fn()
        const connectSpy = vi.fn()
        const env = { IMAP_PASSWORD: 'liegt-da-wird-aber-nicht-erraten', GMAIL_TOKEN: 'x' }
        for (const cfg of [mailCfg(), mailCfg({ imap: { user: 'alfred@firma.at' } }), mailCfg({ imap: { user: 'alfred@firma.at', host: 'imap.firma.at' } })]) {
            const status = resolveMailCredentials(cfg, { env, authProfiles: { anthropic: { type: 'oauth', provider: 'anthropic', access: 'a', refresh: 'b', expires: Date.now() + 1e6 } } })
            expect(status.credentials).toBeNull()
            const adapter = createMailAdapter({ config: cfg, credentials: () => status, fetch: fetchSpy as any, imapConnect: connectSpy as any })
            expect(await adapter.poll({ signal: new AbortController().signal, now: Date.now(), state: {} })).toEqual([])
        }
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(connectSpy).not.toHaveBeenCalled()
    })

    it('abgelaufenes Gmail-Token wird nicht erneuert (OAuth bleibt Owner-Schritt)', () => {
        const status = resolveMailCredentials(mailCfg(), { authProfiles: { google: { type: 'oauth', provider: 'google', access: 'old', refresh: 'r', expires: 1000 } }, now: 2000 })
        expect(status).toEqual({ credentials: null, reason: 'gmail-token-abgelaufen' })
    })

    it('nimmt nur ausdrücklich konfigurierte Zugangsdaten', () => {
        const status = resolveMailCredentials(mailCfg({ imap: { host: 'imap.firma.at', user: 'alfred', passwordEnv: 'MY_IMAP_PW' } }), { env: { MY_IMAP_PW: PASSWORD } })
        expect(status.credentials).toMatchObject({ kind: 'imap', host: 'imap.firma.at', port: 993, tls: true })
    })
})

describe('Mail-Sensor liest nur und protokolliert keinen Volltext/kein Secret', () => {
    it('IMAP: EXAMINE + BODY.PEEK, Zusammenfassung ohne Text, nichts Geheimes in Log/Sinks', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'sense-mail-')); dirs.push(dataDir)
        const logs: string[] = []
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
        const commands: string[] = []
        const cfg = mailCfg({ imap: { host: 'imap.firma.at', user: 'alfred', passwordEnv: 'MY_IMAP_PW' } })
        const credentials = () => resolveMailCredentials(cfg, { env: { MY_IMAP_PW: PASSWORD } })
        const mails = [
            { uid: 9, from: '"Firma X" <office@firma-x.at>', subject: 'Angebot Y für Videodreh', body: `Hallo Alfred, ${BODY_SECRET}` },
            { uid: 10, from: 'newsletter@shop.example', subject: 'Sale', body: 'egal' },
        ]
        const adapter = createMailAdapter({ config: cfg, credentials, imapConnect: () => fakeImap(commands, mails) })
        const bus = new SensingBus({ dataDir, eventSink: new JsonlEventSink(dataDir), thoughtSink: new JsonlThoughtSink(dataDir), now: () => Date.parse('2026-10-01T10:00:00Z') })
        bus.register(adapter)
        expect(await bus.runAdapter('mail')).toEqual([]) // erster Lauf: nur Ausgangslage
        const state = JSON.parse(readFileSync(join(dataDir, 'sensing', 'bus-state.json'), 'utf8'))
        state.adapters.mail.imap['imap.firma.at|alfred'].uid = 8
        const { writeFileSync } = await import('node:fs')
        writeFileSync(join(dataDir, 'sensing', 'bus-state.json'), JSON.stringify(state))
        const bus2 = new SensingBus({ dataDir, eventSink: new JsonlEventSink(dataDir), thoughtSink: new JsonlThoughtSink(dataDir), now: () => Date.parse('2026-10-01T10:00:00Z') })
        bus2.register(createMailAdapter({ config: cfg, credentials, imapConnect: () => fakeImap(commands, mails) }))
        const events = await bus2.runAdapter('mail')
        expect(events).toHaveLength(1)
        expect(events[0].summary).toBe('E-Mail von Firma X (firma-x.at) wegen Angebot: „Angebot Y für Videodreh“')
        expect(commands.some(cmd => /^EXAMINE INBOX/.test(cmd))).toBe(true)
        expect(commands.some(cmd => /^SELECT|STORE|EXPUNGE|COPY|MOVE|APPEND/.test(cmd))).toBe(false)
        expect(commands.filter(cmd => /^UID FETCH/.test(cmd)).every(cmd => cmd.includes('BODY.PEEK[') && !/BODY\[/.test(cmd))).toBe(true)
        const written = readdirSync(join(dataDir, 'sensing')).map(name => readFileSync(join(dataDir, 'sensing', name), 'utf8')).join('\n')
        for (const haystack of [written, logs.join('\n')]) {
            expect(haystack).not.toContain('GEHEIMER-MAILTEXT')
            expect(haystack).not.toContain('AT611904300234573201')
            expect(haystack).not.toContain(PASSWORD)
        }
    })

    it('Gmail: erster Lauf holt keine Inhalte, danach nur Metadaten per GET', async () => {
        const urls: string[] = []
        const fetch = async (url: string, init: any) => {
            urls.push(`${init.method} ${url}`)
            if (url.includes('/messages?')) return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1' }, { id: 'm2' }] }) }
            return { ok: true, status: 200, json: async () => ({ snippet: `Termin morgen ${BODY_SECRET}`, payload: { headers: [{ name: 'From', value: 'Kunde <k@firma-x.at>' }, { name: 'Subject', value: 'Rückfrage' }] } }) }
        }
        const cfg = mailCfg()
        const adapter = createMailAdapter({ config: cfg, credentials: () => ({ credentials: { kind: 'gmail', accessToken: 'tok', account: 'alfred@gmail' }, reason: 'gmail-profil' }), fetch })
        const state: Record<string, unknown> = {}
        expect(await adapter.poll({ signal: new AbortController().signal, now: 0, state })).toEqual([])
        expect(urls).toHaveLength(1)
        state.gmailSeen = ['m1']
        const events = await adapter.poll({ signal: new AbortController().signal, now: 0, state })
        expect(urls.slice(1).every(url => url.startsWith('GET ') && (url.includes('format=metadata') || url.includes('/messages?')))).toBe(true)
        expect(events).toHaveLength(1)
        expect(JSON.stringify(events)).not.toContain('GEHEIMER-MAILTEXT')
        expect(events[0].evidence.stichworte).toBe('termin')
    })

    it('unbekannter Absender ohne Stichwort erzeugt nichts; Stichwort allein nur Protokoll', () => {
        const cfg = mailCfg()
        expect(mailToEvent({ id: '1', from: 'x@y.z', subject: 'Hallo', date: '', text: '' }, cfg, 'a')).toBeNull()
        expect(mailToEvent({ id: '2', from: 'x@y.z', subject: 'Ihre Rechnung', date: '', text: '' }, cfg, 'a')?.hint?.importance).toBe('niedrig')
    })

    it('IMAP-Hilfen: Literale und MIME-Wörter', () => {
        expect(decodeMimeWords('=?UTF-8?B?QW5nZWJvdCDDvGJlcg==?=')).toBe('Angebot über')
        expect(splitImapResponse(Buffer.from('* 1 FETCH (UID 3 BODY[TEXT] {5}\r\nab'), 'a1')).toBeNull()
    })
})
