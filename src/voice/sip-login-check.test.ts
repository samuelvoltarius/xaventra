import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkSipLogin, parseSipResponse, type SipConnection } from './sip-login-check.js'

// 2.87 Paket P: Login beim SIP-Anbieter prüfen, ohne etwas zu verändern
// (REGISTER ohne Contact = nur Abfrage, RFC 3261 10.2.3). Kein Netz: Fake-Verbindung.

const md5 = (value: string) => createHash('md5').update(value).digest('hex')
const PASSWORT = 'Beispiel-Passwort-123'
const config = { server: 'sip.example.com', port: 5061, transport: 'tls' as const, login: '100100' }

function fakeServer(answers: Array<(request: string) => string>) {
    const requests: string[] = []
    let pending: ((value: string) => void) | null = null
    const queue: string[] = []
    const connection: SipConnection = {
        send(text) {
            requests.push(text)
            const answer = answers.shift()
            if (answer) { const response = answer(text); if (pending) { pending(response); pending = null } else queue.push(response) }
        },
        next() { return queue.length ? Promise.resolve(queue.shift()!) : new Promise(resolve => { pending = resolve }) },
        close() { /* nichts */ },
    }
    return { connection, requests }
}

const challenge = (qop = true) => () => [
    'SIP/2.0 401 Unauthorized', 'Via: SIP/2.0/TLS x', 'CSeq: 1 REGISTER',
    `WWW-Authenticate: Digest realm="sip.example.com", nonce="abc123"${qop ? ', qop="auth"' : ''}, algorithm=MD5`, 'Content-Length: 0', '', '',
].join('\r\n')

describe('checkSipLogin', () => {
    it('richtiges Passwort: Digest stimmt, REGISTER ohne Contact (keine Änderung beim Anbieter)', async () => {
        let authorization = ''
        const { connection, requests } = fakeServer([
            challenge(),
            request => { authorization = /Authorization: (.*)\r\n/.exec(request)![1]; return 'SIP/2.0 100 Trying\r\nContent-Length: 0\r\n\r\nSIP/2.0 200 OK\r\nCSeq: 2 REGISTER\r\nContent-Length: 0\r\n\r\n' },
        ])
        const result = await checkSipLogin(config, PASSWORT, { connect: async () => connection, anbieter: 'Zadarma' })
        expect(result).toEqual({ ok: true, text: 'Telefon angemeldet: der Zugang bei Zadarma stimmt.' })
        expect(requests).toHaveLength(2)
        for (const request of requests) {
            expect(request.startsWith('REGISTER sip:sip.example.com SIP/2.0\r\n')).toBe(true)
            expect(request).not.toMatch(/^Contact:/m)
            expect(request).not.toContain(PASSWORT)
        }
        const field = (name: string) => new RegExp(`${name}="?([^",]+)"?`).exec(authorization)![1]
        const ha1 = md5(`100100:sip.example.com:${PASSWORT}`)
        const ha2 = md5('REGISTER:sip:sip.example.com')
        expect(field('response')).toBe(md5(`${ha1}:abc123:${field('nc')}:${field('cnonce')}:auth:${ha2}`))
    })

    it('falsches Passwort: Alltagssatz, nie das Passwort', async () => {
        const { connection } = fakeServer([challenge(false), challenge(false)])
        const result = await checkSipLogin(config, PASSWORT, { connect: async () => connection, anbieter: 'Zadarma' })
        expect(result).toEqual({ ok: false, text: 'Anmeldung bei Zadarma hat nicht geklappt — Passwort prüfen.' })
        expect(JSON.stringify(result)).not.toContain(PASSWORT)
    })

    it('403 ohne Rückfrage = gesperrt/falscher Login', async () => {
        const { connection } = fakeServer([() => 'SIP/2.0 403 Forbidden\r\nContent-Length: 0\r\n\r\n'])
        expect((await checkSipLogin(config, PASSWORT, { connect: async () => connection })).text).toBe('Anmeldung beim Telefonanbieter hat nicht geklappt — Login und Passwort prüfen.')
    })

    it('nicht erreichbar / Zeitüberschreitung: ehrlich, ohne Technikballast', async () => {
        const result = await checkSipLogin(config, PASSWORT, { connect: async () => { throw new Error('connect ECONNREFUSED 192.0.2.1:5061') } })
        expect(result.ok).toBe(false)
        expect(result.text).toBe('Der Telefonanbieter ist gerade nicht erreichbar. Später noch einmal prüfen.')
        const silent = fakeServer([])
        const slow = await checkSipLogin(config, PASSWORT, { connect: async () => silent.connection, timeoutMs: 30 })
        expect(slow.text).toBe('Der Telefonanbieter antwortet nicht. Später noch einmal prüfen.')
    })

    it('ohne Passwort oder Login wird gar nicht erst verbunden', async () => {
        let connected = false
        const result = await checkSipLogin({ ...config, login: '' }, PASSWORT, { connect: async () => { connected = true; throw new Error('x') } })
        expect(connected).toBe(false)
        expect(result.ok).toBe(false)
        expect((await checkSipLogin(config, '', { connect: async () => { connected = true; throw new Error('x') } })).text).toContain('Passwort fehlt')
        expect(connected).toBe(false)
    })
})

describe('parseSipResponse', () => {
    it('liest Status und Kopfzeilen', () => {
        const parsed = parseSipResponse('SIP/2.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm="r", nonce="n"\r\n\r\n')
        expect(parsed.status).toBe(401)
        expect(parsed.headers['www-authenticate']).toBe('Digest realm="r", nonce="n"')
    })
})
