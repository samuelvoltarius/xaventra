import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { anrufen, createTelefonCardExecutor, entscheideAnruf, TELEFON_CARD_KIND } from './telefon-ausgang.js'
import { readTelefonConfig, saveTelefonEingabe } from './telefon-config.js'
import { listApprovalCards } from '../core/approval-cards.js'

// 2.87 Paket P: ausgehend nur an Owner-Nummern direkt; alles andere ist extern
// (Guthaben = Geld) und geht nur per Karte. Kein Netz: fetch ist ein Fake.

const OWNER = '+43 1 2345678' // Beispielnummer
const FREMD = '+43 1 7654321' // Beispielnummer
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'telefon-raus-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const opts = () => ({ dataDir: dir })

function anlage(extra: Record<string, unknown> = {}) {
    saveTelefonEingabe({
        weg: 'asterisk', aktiv: true, ownerNummern: [OWNER],
        asterisk: { ariUrl: 'http://127.0.0.1:8088', ariBenutzer: 'xaventra', ariPasswort: 'Beispiel-ARI-Passwort', ausgang: 'SIP/{nummer}@beispielanbieter' },
        ...extra,
    } as any, opts())
}

describe('entscheideAnruf', () => {
    it('Owner-Nummer direkt, andere per Karte, Unsinn nein', () => {
        anlage()
        const config = readTelefonConfig(opts())
        expect(entscheideAnruf('+4312345678', config)).toEqual({ art: 'direkt', nummer: '+4312345678' })
        expect(entscheideAnruf(FREMD, config)).toEqual({ art: 'karte', nummer: '+4317654321' })
        expect(entscheideAnruf('12', config).art).toBe('nein')
        expect(entscheideAnruf(OWNER, { ...config, aktiv: false }).art).toBe('nein')
    })
})

describe('anrufen', () => {
    it('an die Owner-Nummer: wählt über ARI auf 127.0.0.1 (Basic-Auth, nie im Text)', async () => {
        anlage()
        const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
        const text = await anrufen(OWNER, { fetch: fetchMock as any, opts: opts() })
        expect(text).toBe('Ich rufe +4312345678 an.')
        const [url, init] = fetchMock.mock.calls[0] as any
        expect(url.startsWith('http://127.0.0.1:8088/ari/channels?')).toBe(true)
        expect(new URL(url).searchParams.get('endpoint')).toBe('SIP/+4312345678@beispielanbieter')
        expect(new URL(url).searchParams.get('context')).toBe('xaventra-raus')
        expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('xaventra:Beispiel-ARI-Passwort').toString('base64')}`)
        expect(text).not.toContain('Beispiel-ARI-Passwort')
    })

    it('an eine fremde Nummer: nur eine Karte (extern), nichts gewählt — erst das Ja wählt', async () => {
        anlage()
        const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
        expect(await anrufen(FREMD, { fetch: fetchMock as any, opts: opts() })).toContain('Bitte bestätige den Anruf auf der Karte')
        expect(fetchMock).not.toHaveBeenCalled()
        const card = listApprovalCards({ dataDir: dir, status: 'offen' }).find(item => item.aktion.kind === TELEFON_CARD_KIND)!
        expect(card.wirkung).toBe('extern')
        const executor = createTelefonCardExecutor({ fetch: fetchMock as any, opts: opts() })
        expect(executor.allowAlways?.(card)).toBe(false)
        expect((await executor.execute(card, 'ja', { decidedBy: 'test', userId: '1' })).message).toBe('Ich rufe +4317654321 an.')
        expect(fetchMock).toHaveBeenCalledOnce()
        // derselbe Plan kein zweites Mal
        expect((await executor.execute(card, 'ja', { decidedBy: 'test', userId: '1' })).ok).toBe(false)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('ohne Freischaltung in der Anlage: ehrlicher Satz, kein Aufruf', async () => {
        saveTelefonEingabe({ weg: 'asterisk', aktiv: true, ownerNummern: [OWNER] }, opts())
        const fetchMock = vi.fn()
        expect(await anrufen(OWNER, { fetch: fetchMock as any, opts: opts() })).toContain('muss die Telefonanlage das noch erlauben')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('direkter Weg: sagt ehrlich, dass der Telefon-Baustein fehlt', async () => {
        saveTelefonEingabe({ weg: 'direkt', aktiv: true, ownerNummern: [OWNER], server: 'sip.zadarma.com', login: '100100' }, opts())
        const fetchMock = vi.fn()
        expect(await anrufen(OWNER, { fetch: fetchMock as any, opts: opts() })).toContain('Telefon-Baustein')
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
