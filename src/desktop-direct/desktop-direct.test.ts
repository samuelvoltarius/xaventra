import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { getCommandMinimumRole } from '../core/slash-commands.js'
import { parseDesktopDirectConfig, type DesktopDirectConfig } from './config.js'
import { createDesktopGateway, isAllowedDesktopSource } from './gateway.js'
import { agentDesktopInputPauseReason, clearAgentDesktopInputHolds } from './pause.js'
import { ByteQueue, RfbClientFilter, vncAuthResponse } from './rfb.js'
import { desktopPicker, formatLinkMessage, isDesktopDirectActive, pressDesktopButton, startDesktopDirect, stopDesktopDirect } from './runtime.js'
import { DesktopDirectStore } from './store.js'

// /desktop – Direktverbindung. Gegenproben (guard removed -> red) are listed
// in the branch report: one-time link, foreign IP, password leak.

const OWNER = '111'
const STRANGER = '222'
/** Test dummy, not a real credential. */
const TEST_PASSWORD = 'attrappe7'
let clock = Date.parse('2026-10-01T10:00:00Z')
let dataDir: string
let passwordFile: string
let novncDir: string

function rawConfig(overrides: Record<string, unknown> = {}, desktops?: unknown[]) {
    return {
        desktop: {
            direct: {
                enabled: true, publicBaseUrl: 'https://desktop.example.com', port: 18793,
                desktops: desktops || [
                    { id: 'lab', label: 'Labor-VM', target: 'tcp://127.0.0.1:5901', vncPasswordFile: passwordFile },
                    { id: 'spark', label: 'Spark', target: 'ws://127.0.0.1:6080', agentInput: true },
                    { id: 'kiosk', label: 'Kiosk', target: 'tcp://127.0.0.1:5902', allowControl: false },
                ],
                ...overrides,
            },
        },
    }
}

function newStore(overrides: Record<string, unknown> = {}, desktops?: unknown[]): DesktopDirectStore {
    const { config } = parseDesktopDirectConfig(rawConfig(overrides, desktops))
    return new DesktopDirectStore(config, { now: () => clock, dataDir })
}

const buttonFor = (keyboard: Array<Array<{ text: string; callback_data: string }>>, label: string) =>
    keyboard.flat().find(button => button.text.includes(label))!.callback_data

const tokenOf = (url: string) => url.split('/desktop/s/')[1]

beforeEach(() => {
    clock = Date.parse('2026-10-01T10:00:00Z')
    dataDir = mkdtempSync(join(tmpdir(), 'desktop-direct-'))
    passwordFile = join(dataDir, 'vnc.pass')
    writeFileSync(passwordFile, `${TEST_PASSWORD}\n`)
    chmodSync(passwordFile, 0o600)
    novncDir = join(dataDir, 'novnc')
    mkdirSync(join(novncDir, 'core'), { recursive: true })
    writeFileSync(join(novncDir, 'core', 'rfb.js'), 'export default class RFB {}\n')
    clearAgentDesktopInputHolds()
})

afterEach(async () => {
    vi.restoreAllMocks()
    await stopDesktopDirect()
    clearAgentDesktopInputHolds()
})

describe('config', () => {
    it('is off by default and refuses an incomplete config', () => {
        expect(parseDesktopDirectConfig({}).config.enabled).toBe(false)
        expect(parseDesktopDirectConfig({ desktop: { direct: { enabled: false, publicBaseUrl: 'https://desktop.example.com', desktops: [{ id: 'lab', target: 'tcp://127.0.0.1:5901' }] } } }).config.enabled).toBe(false)
        expect(parseDesktopDirectConfig(rawConfig({ publicBaseUrl: 'http://desktop.example.com' })).config.enabled).toBe(false)
        expect(parseDesktopDirectConfig(rawConfig({}, [{ id: 'lab', target: 'http://127.0.0.1:5901' }])).config.enabled).toBe(false)
    })
    it('never allows a link lifetime above 10 minutes', () => {
        expect(parseDesktopDirectConfig(rawConfig({ linkTtlMinutes: 120 })).config.linkTtlMs).toBe(10 * 60_000)
    })
})

describe('one-time link: single use, expiry, binding', () => {
    it('issues a 32-byte base64url token, stores only its hash, redeems exactly once', () => {
        const store = newStore()
        const picker = store.createPicker(OWNER)
        const press = store.press(buttonFor(picker.keyboard, 'Labor-VM – Ansehen'), { userId: OWNER, ownerIds: [OWNER] })
        expect(press.code).toBe('link')
        const token = tokenOf(press.link!.url)
        expect(press.link!.url.startsWith('https://desktop.example.com/desktop/s/')).toBe(true)
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(Buffer.from(token, 'base64url')).toHaveLength(32)
        expect(store.checkLink(token)).toBe('ok')
        expect(store.checkLink(token)).toBe('ok') // GET does not consume
        const first = store.redeemLink(token, '127.0.0.1')
        expect(first.code).toBe('ok')
        expect(store.redeemLink(token, '127.0.0.1').code).toBe('verbraucht')
        expect(store.checkLink(token)).toBe('verbraucht')
        // Neither token nor session id is stored or audited in plain text.
        const audit = readFileSync(join(dataDir, 'desktop-sessions.jsonl'), 'utf8')
        expect(audit).not.toContain(token)
        expect(audit).not.toContain(first.sessionId!)
        expect(JSON.stringify((store as any).links)).not.toContain(token)
    })

    it('expires after 10 minutes', () => {
        const store = newStore()
        const press = store.press(buttonFor(store.createPicker(OWNER).keyboard, 'Labor-VM – Ansehen'), { userId: OWNER, ownerIds: [OWNER] })
        clock += 10 * 60_000 + 1
        expect(store.redeemLink(tokenOf(press.link!.url), '127.0.0.1').code).toBe('abgelaufen')
    })

    it('binds the session to the pressed desktop and mode', () => {
        const store = newStore()
        const picker = store.createPicker(OWNER)
        const press = store.press(buttonFor(picker.keyboard, 'Spark – Übernehmen'), { userId: OWNER, ownerIds: [OWNER] })
        const result = store.redeemLink(tokenOf(press.link!.url), '100.64.102.103')
        expect(result.session).toMatchObject({ mode: 'control', ownerId: OWNER, sourceIp: '100.64.102.103' })
        expect(result.session!.desktop.id).toBe('spark')
        // A view-only desktop never offers control.
        expect(picker.keyboard.flat().some(button => button.text.includes('Kiosk – Übernehmen'))).toBe(false)
    })

    it('consumes the whole picker on the first press; unknown and forged tokens are refused', () => {
        const store = newStore()
        const picker = store.createPicker(OWNER)
        const view = buttonFor(picker.keyboard, 'Labor-VM – Ansehen')
        const control = buttonFor(picker.keyboard, 'Labor-VM – Übernehmen')
        expect(store.press(view, { userId: OWNER, ownerIds: [OWNER] }).code).toBe('link')
        expect(store.press(view, { userId: OWNER, ownerIds: [OWNER] }).code).toBe('verbraucht')
        expect(store.press(control, { userId: OWNER, ownerIds: [OWNER] }).code).toBe('verbraucht')
        expect(store.press('dk:0123456789abcdef', { userId: OWNER, ownerIds: [OWNER] }).code).toBe('unbekannt')
        expect(store.press('dk:lab:control', { userId: OWNER, ownerIds: [OWNER] }).code).toBe('unbekannt')
        expect(store.redeemLink('A'.repeat(43), '127.0.0.1').code).toBe('unbekannt')
    })

    it('a session id opens exactly one WebSocket within 60 s', () => {
        const store = newStore()
        const press = store.press(buttonFor(store.createPicker(OWNER).keyboard, 'Labor-VM – Ansehen'), { userId: OWNER, ownerIds: [OWNER] })
        const { sessionId } = store.redeemLink(tokenOf(press.link!.url), '127.0.0.1')
        expect(store.claimSession(sessionId!)).not.toBeNull()
        expect(store.claimSession(sessionId!)).toBeNull()
        const late = store.press(buttonFor(store.createPicker(OWNER).keyboard, 'Labor-VM – Ansehen'), { userId: OWNER, ownerIds: [OWNER] })
        const lateSession = store.redeemLink(tokenOf(late.link!.url), '127.0.0.1')
        clock += 61_000
        expect(store.claimSession(lateSession.sessionId!)).toBeNull()
    })
})

describe('owner only', () => {
    it('refuses a non-owner press and keeps the picker usable for the owner', () => {
        const store = newStore()
        const picker = store.createPicker(OWNER)
        const data = buttonFor(picker.keyboard, 'Labor-VM – Ansehen')
        expect(store.press(data, { userId: STRANGER, ownerIds: [OWNER] })).toMatchObject({ ok: false, code: 'kein-owner' })
        expect(store.press(data, { userId: '@alfred', ownerIds: ['@alfred'] })).toMatchObject({ ok: false, code: 'kein-owner' })
        expect(store.press(data, { userId: OWNER, ownerIds: [OWNER] }).code).toBe('link')
    })

    it('/desktop requires the owner role (default for unlisted commands)', () => {
        expect(getCommandMinimumRole('desktop')).toBe('owner')
    })
})

describe('source address', () => {
    it('accepts loopback and 100.64.0.0/10 only', () => {
        for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.127.255.254', '::ffff:100.64.100.2']) expect(isAllowedDesktopSource(ip)).toBe(true)
        for (const ip of ['', '192.168.1.5', '10.0.0.1', '100.63.255.255', '100.128.0.1', '203.0.113.9', '::ffff:192.0.2.1', 'fd7a:115c:a1e0::1']) expect(isAllowedDesktopSource(ip)).toBe(false)
    })

    function fakeExchange(remoteAddress: string, url: string, method = 'GET') {
        const req = Object.assign(new PassThrough(), { url, method, headers: { host: 'desktop.example.com' }, socket: { remoteAddress } })
        const res = { status: 0, body: '', headers: {} as Record<string, unknown>, setHeader(k: string, v: unknown) { this.headers[k] = v }, writeHead(s: number) { this.status = s; return this }, end(b?: unknown) { this.body = String(b ?? '') } }
        return { req, res }
    }

    it('answers 403 to a foreign IP and does not consume the link', () => {
        const store = newStore()
        const press = store.press(buttonFor(store.createPicker(OWNER).keyboard, 'Labor-VM – Ansehen'), { userId: OWNER, ownerIds: [OWNER] })
        const token = tokenOf(press.link!.url)
        const server = createDesktopGateway(store.config, store, { novncDir, log: () => {} })
        for (const method of ['GET', 'POST']) {
            const { req, res } = fakeExchange('203.0.113.9', `/desktop/s/${token}`, method)
            server.emit('request', req, res)
            expect(res.status).toBe(403)
        }
        const upgrade = { written: '', destroyed: false, write(chunk: string) { this.written += chunk }, destroy() { this.destroyed = true } }
        server.emit('upgrade', Object.assign(new PassThrough(), { url: '/desktop/ws/x', headers: {}, socket: { remoteAddress: '192.168.1.5' } }), upgrade, Buffer.alloc(0))
        expect(upgrade.written).toMatch(/^HTTP\/1\.1 403/)
        expect(upgrade.destroyed).toBe(true)
        expect(store.checkLink(token)).toBe('ok')
        expect(readFileSync(join(dataDir, 'desktop-sessions.jsonl'), 'utf8')).toContain('fremde-ip')
        // The same request from the tailnet is served.
        const { req, res } = fakeExchange('100.64.90.2', `/desktop/s/${token}`)
        server.emit('request', req, res)
        expect(res.status).toBe(200)
    })
})

describe('RFB client filter', () => {
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61])
    const pointer = Buffer.from([5, 1, 0, 10, 0, 20])
    const cut = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from('abc')])
    const fbur = Buffer.from([3, 1, 0, 0, 0, 0, 3, 32, 2, 88])
    const qemuKey = Buffer.from([255, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 30])
    const xvp = Buffer.from([250, 0, 1, 4])

    it('view-only drops KeyEvent, PointerEvent, ClientCutText and QEMU keys, also when fragmented', () => {
        const filter = new RfbClientFilter('view')
        const all = Buffer.concat([key, pointer, cut, qemuKey, fbur])
        const forwarded: Buffer[] = []
        let dropped = 0
        for (let index = 0; index < all.length; index += 3) {
            const result = filter.push(all.subarray(index, index + 3))
            expect(result.error).toBeUndefined()
            forwarded.push(...result.forward)
            dropped += result.dropped
        }
        expect(Buffer.concat(forwarded)).toEqual(fbur)
        expect(dropped).toBe(4)
    })

    it('control forwards input but never xvp power actions; unknown types end the session', () => {
        const control = new RfbClientFilter('control')
        const result = control.push(Buffer.concat([key, pointer, xvp, fbur]))
        expect(Buffer.concat(result.forward)).toEqual(Buffer.concat([key, pointer, fbur]))
        expect(result.dropped).toBe(1)
        expect(new RfbClientFilter('control').push(Buffer.from([99, 0, 0])).error).toMatch(/Unbekannte/)
    })

    it('computes the VNC-Auth response as single DES (known test vector)', () => {
        // Bit-reversed key bytes of the classic DES vector 133457799BBCDFF1.
        const key = Buffer.from([0x13, 0x34, 0x57, 0x79, 0x9b, 0xbc, 0xdf, 0xf1].map(byte => parseInt(byte.toString(2).padStart(8, '0').split('').reverse().join(''), 2)))
        const challenge = Buffer.concat([Buffer.from('0123456789abcdef', 'hex'), Buffer.from('0123456789abcdef', 'hex')])
        expect(vncAuthResponse(challenge, key).toString('hex')).toBe('85e813540f0ab40585e813540f0ab405')
    })
})

// ---------------------------------------------------------------------------
// end to end: browser (ws) -> gateway -> fake VNC server with VNC-Auth
// ---------------------------------------------------------------------------

interface FakeVnc { server: NetServer; port: number; received: Buffer[]; shared: number[]; authOk: boolean[] }

function fakeVncServer(password: string): Promise<FakeVnc> {
    const state: FakeVnc = { server: null as any, port: 0, received: [], shared: [], authOk: [] }
    state.server = createNetServer((socket: Socket) => {
        const queue = new ByteQueue()
        let streaming = false
        socket.on('data', data => { if (streaming) state.received.push(Buffer.from(data)); else queue.push(data) })
        socket.on('error', () => {})
        void (async () => {
            socket.write('RFB 003.008\n')
            await queue.read(12)
            socket.write(Buffer.from([1, 2]))
            if ((await queue.read(1))[0] !== 2) return socket.destroy()
            const challenge = randomBytes(16)
            socket.write(challenge)
            const response = await queue.read(16)
            const ok = response.equals(vncAuthResponse(challenge, Buffer.from(password)))
            state.authOk.push(ok)
            if (!ok) {
                socket.write(Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 13]), Buffer.from('Auth failed!!')]))
                return socket.end()
            }
            socket.write(Buffer.from([0, 0, 0, 0]))
            state.shared.push((await queue.read(1))[0])
            const name = Buffer.from('lab')
            const init = Buffer.alloc(24)
            init.writeUInt16BE(800, 0); init.writeUInt16BE(600, 2); init[4] = 32; init[5] = 24; init.writeUInt32BE(name.length, 20)
            socket.write(Buffer.concat([init, name]))
            streaming = true
            const rest = queue.takeRest()
            if (rest.length) state.received.push(rest)
        })().catch(() => socket.destroy())
    })
    return new Promise(resolve => state.server.listen(0, '127.0.0.1', () => { state.port = (state.server.address() as AddressInfo).port; resolve(state) }))
}

async function startE2e(desktopPassword: string, serverPassword = TEST_PASSWORD) {
    writeFileSync(passwordFile, `${desktopPassword}\n`)
    chmodSync(passwordFile, 0o600)
    const vnc = await fakeVncServer(serverPassword)
    const store = newStore({}, [
        { id: 'lab', label: 'Labor-VM', target: `tcp://127.0.0.1:${vnc.port}`, vncPasswordFile: passwordFile, agentInput: true },
    ])
    const logs: string[] = []
    const gateway: Server = createDesktopGateway(store.config, store, { novncDir, log: line => logs.push(line) })
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', () => resolve()))
    const port = (gateway.address() as AddressInfo).port
    return { vnc, store, gateway, port, logs }
}

async function openSession(env: Awaited<ReturnType<typeof startE2e>>, label: string, bodies: string[]) {
    const press = env.store.press(buttonFor(env.store.createPicker(OWNER).keyboard, label), { userId: OWNER, ownerIds: [OWNER] })
    bodies.push(formatLinkMessage(press.link!))
    const path = `/desktop/s/${tokenOf(press.link!.url)}`
    const get = await fetch(`http://127.0.0.1:${env.port}${path}`)
    bodies.push(await get.text())
    expect(get.status).toBe(200)
    const post = await fetch(`http://127.0.0.1:${env.port}${path}`, { method: 'POST' })
    const html = await post.text()
    bodies.push(html)
    expect(post.status).toBe(200)
    const again = await fetch(`http://127.0.0.1:${env.port}${path}`, { method: 'POST' })
    bodies.push(await again.text())
    expect(again.status).toBe(410)
    const sessionId = /data-session="([^"]+)"/.exec(html)![1]
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}/desktop/ws/${sessionId}`, { headers: { Origin: `http://127.0.0.1:${env.port}` } })
    const queue = new ByteQueue()
    const browserReceived: Buffer[] = []
    ws.on('message', (data: Buffer) => { browserReceived.push(Buffer.from(data)); queue.push(Buffer.from(data)) })
    const closed = new Promise<void>(resolve => ws.on('close', () => resolve()))
    ws.on('error', () => {})
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('unexpected-response', () => reject(new Error('upgrade refused'))) })
    return { ws, queue, browserReceived, closed, press }
}

async function browserHandshake(ws: WebSocket, queue: ByteQueue) {
    expect((await queue.read(12)).toString()).toBe('RFB 003.008\n')
    ws.send(Buffer.from('RFB 003.008\n'))
    expect([...(await queue.read(2))]).toEqual([1, 1]) // only security type None
    ws.send(Buffer.from([1]))
    expect([...(await queue.read(4))]).toEqual([0, 0, 0, 0])
    ws.send(Buffer.from([0])) // ClientInit exclusive — the gateway forces shared
    const init = await queue.read(27)
    expect(init.readUInt16BE(0)).toBe(800)
}

const waitFor = async (check: () => boolean, ms = 3000) => {
    const start = Date.now()
    while (!check()) {
        if (Date.now() - start > ms) throw new Error('timeout')
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

describe('gateway end to end (fake VNC server, test password dummy)', () => {
    let env: Awaited<ReturnType<typeof startE2e>> | null = null
    afterEach(async () => {
        if (!env) return
        await new Promise<void>(resolve => { env!.gateway.closeAllConnections?.(); env!.gateway.close(() => resolve()) })
        await new Promise<void>(resolve => env!.vnc.server.close(() => resolve()))
        env = null
    })

    it('view: authenticates upstream itself, browser needs no password, input is dropped, password never leaks', async () => {
        const console$ = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
        env = await startE2e(TEST_PASSWORD)
        const bodies: string[] = []
        const session = await openSession(env, 'Labor-VM – Ansehen', bodies)
        await browserHandshake(session.ws, session.queue)
        expect(env.vnc.authOk).toEqual([true])
        expect(env.vnc.shared).toEqual([1])
        const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61])
        const pointer = Buffer.from([5, 1, 0, 10, 0, 20])
        const fbur = Buffer.from([3, 0, 0, 0, 0, 0, 3, 32, 2, 88])
        session.ws.send(Buffer.concat([key, pointer, fbur]))
        await waitFor(() => Buffer.concat(env!.vnc.received).length >= fbur.length)
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(Buffer.concat(env.vnc.received)).toEqual(fbur)
        expect(agentDesktopInputPauseReason()).toBeNull() // view never pauses
        session.ws.close()
        await session.closed
        await waitFor(() => env!.store.activeSessions().length === 0)
        const audit = readFileSync(join(dataDir, 'desktop-sessions.jsonl'), 'utf8')
        expect(audit).toContain('"event":"sitzung-ende"')
        const everything = [...bodies, Buffer.concat(session.browserReceived).toString('latin1'), audit, ...env.logs,
            ...console$.flatMap(spy => spy.mock.calls.map(call => call.map(String).join(' ')))].join('\n')
        expect(everything).not.toContain(TEST_PASSWORD)
    })

    it('control: input passes and the agent desktop input is paused until the session ends', async () => {
        env = await startE2e(TEST_PASSWORD)
        const session = await openSession(env, 'Labor-VM – Übernehmen', [])
        expect(agentDesktopInputPauseReason()).toMatch(/pausiert/)
        await browserHandshake(session.ws, session.queue)
        const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61])
        session.ws.send(key)
        await waitFor(() => Buffer.concat(env!.vnc.received).length >= key.length)
        expect(Buffer.concat(env.vnc.received)).toEqual(key)
        // "Zurückgeben" from Telegram ends the session and releases the pause.
        const release = session.press.link!.releaseKeyboard![0][0].callback_data
        expect(env.store.press(release, { userId: OWNER, ownerIds: [OWNER] }).code).toBe('released')
        await session.closed
        expect(agentDesktopInputPauseReason()).toBeNull()
    })

    it('wrong password: session ends with a generic error that does not contain either password', async () => {
        const wrong = 'falsch-attrappe'
        env = await startE2e(wrong, TEST_PASSWORD)
        const bodies: string[] = []
        const session = await openSession(env, 'Labor-VM – Ansehen', bodies)
        await session.closed
        expect(env.vnc.authOk).toEqual([false])
        await waitFor(() => env!.logs.length > 0)
        const everything = [...bodies, ...env.logs, readFileSync(join(dataDir, 'desktop-sessions.jsonl'), 'utf8'), Buffer.concat(session.browserReceived).toString('latin1')].join('\n')
        expect(everything).toContain('VNC-Anmeldung fehlgeschlagen')
        expect(everything).not.toContain(wrong)
        expect(everything).not.toContain(TEST_PASSWORD)
    })
})

describe('off = nothing registered', () => {
    it('does not start without enabled=true, on a worker, or with an incomplete config', async () => {
        expect(await startDesktopDirect({}, { dataDir })).toMatchObject({ started: false })
        expect(await startDesktopDirect(rawConfig(), { dataDir, nodeOnly: true })).toMatchObject({ started: false })
        expect(await startDesktopDirect(rawConfig({ publicBaseUrl: '' }), { dataDir, nodeOnly: false, listen: false })).toMatchObject({ started: false })
        expect(isDesktopDirectActive()).toBe(false)
        expect(desktopPicker(OWNER)).toBeNull()
        expect(pressDesktopButton('dk:0123456789abcdef', { userId: OWNER, ownerIds: [OWNER] }).code).toBe('aus')
        expect(existsSync(join(dataDir, 'desktop-sessions.jsonl'))).toBe(false)
    })

    it('starts on the Main when enabled', async () => {
        const result = await startDesktopDirect(rawConfig(), { dataDir, nodeOnly: false, listen: false })
        expect(result.started).toBe(true)
        expect(desktopPicker(OWNER)?.keyboard.length).toBe(3)
    })
})
