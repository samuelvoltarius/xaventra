import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    asteriskVorlage, isOwnerNumber, normalizeNumber, readTelefonConfig, saveTelefonEingabe, telefonBereit, telefonHinweise,
    telefonOeffentlich, readTelefonPasswort,
} from './telefon-config.js'

// 2.87 Paket P: Telefon-Zugang. Nur Beispielwerte (example.com, Doku-Nummern).
// Das Passwort liegt nur in der Secrets-Ablage und taucht nirgends sonst auf.

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'telefon-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const opts = () => ({ dataDir: dir })
const PASSWORT = 'Beispiel-Passwort-123' // offensichtlich ein Testwert

describe('Telefon-Eingabe', () => {
    it('ohne Eingabe: nichts aktiv, nichts bereit', () => {
        const config = readTelefonConfig(opts())
        expect(config.aktiv).toBe(false)
        expect(telefonBereit(config)).toBe(false)
        expect(telefonOeffentlich(opts()).eingerichtet).toBe(false)
    })

    it('Zadarma: drei Felder reichen (Server, Login, Passwort) — Standard TLS 5061', () => {
        const result = saveTelefonEingabe({ server: 'sip.zadarma.com', login: '100100', passwort: PASSWORT }, opts())
        expect(result.ok).toBe(true)
        const config = readTelefonConfig(opts())
        expect(config.sip).toMatchObject({ server: 'sip.zadarma.com', login: '100100', transport: 'tls', port: 5061 })
        expect(config.weg).toBe('direkt')
        expect(readTelefonPasswort(opts())).toBe(PASSWORT)
    })

    it('anderer Anbieter: Standard UDP 5060, Felder frei änderbar', () => {
        saveTelefonEingabe({ server: 'sip.example.com', login: 'alfred', passwort: PASSWORT, transport: 'tcp', port: 5080 }, opts())
        expect(readTelefonConfig(opts()).sip).toMatchObject({ server: 'sip.example.com', transport: 'tcp', port: 5080 })
        saveTelefonEingabe({ server: 'sip.example.org', login: 'alfred' }, opts())
        expect(readTelefonConfig(opts()).sip).toMatchObject({ transport: 'udp', port: 5060 })
        // Passwort bleibt, wenn es nicht neu eingegeben wird.
        expect(readTelefonPasswort(opts())).toBe(PASSWORT)
    })

    it('Passwort nie in der Konfiguration, nie in der Anzeige', () => {
        saveTelefonEingabe({ server: 'sip.zadarma.com', login: '100100', passwort: PASSWORT, ownerNummern: ['+43 1 2345678'] }, opts())
        const files = readdirSync(join(dir, 'telefon')).map(name => readFileSync(join(dir, 'telefon', name), 'utf8')).join('\n')
        expect(files).not.toContain(PASSWORT)
        const view = JSON.stringify(telefonOeffentlich(opts()))
        expect(view).not.toContain(PASSWORT)
        expect(telefonOeffentlich(opts()).passwortGespeichert).toBe(true)
    })

    it('lehnt kaputte Eingaben ab und sagt, welches Feld', () => {
        expect(saveTelefonEingabe({ server: 'http://sip.example.com', login: 'x' }, opts())).toMatchObject({ ok: false, feld: 'server' })
        expect(saveTelefonEingabe({ server: 'sip.example.com', login: 'a b' }, opts())).toMatchObject({ ok: false, feld: 'login' })
        expect(saveTelefonEingabe({ server: 'sip.example.com', login: 'a', passwort: 'x\r\ny' }, opts())).toMatchObject({ ok: false, feld: 'passwort' })
        expect(saveTelefonEingabe({ server: 'sip.example.com', login: 'a', port: 70000 }, opts())).toMatchObject({ ok: false, feld: 'port' })
        expect(saveTelefonEingabe({ server: 'sip.example.com', login: 'a', ownerNummern: ['12'] }, opts())).toMatchObject({ ok: false, feld: 'ownerNummern' })
        expect(saveTelefonEingabe({ weg: 'asterisk', asterisk: { ariUrl: 'http://203.0.113.5:8088' } }, opts())).toMatchObject({ ok: false, feld: 'ariUrl' })
    })
})

describe('Nummern', () => {
    it('normalisiert und vergleicht Owner-Nummern (auch nationale Schreibweise)', () => {
        expect(normalizeNumber('+43 (1) 234-5678')).toBe('+4312345678')
        expect(normalizeNumber('0043 1 2345678')).toBe('+4312345678')
        expect(isOwnerNumber('+4312345678', ['+43 1 2345678'])).toBe(true)
        expect(isOwnerNumber('012345678', ['+43 1 2345678'])).toBe(true)
        expect(isOwnerNumber('+4312345679', ['+43 1 2345678'])).toBe(false)
        expect(isOwnerNumber('', ['+43 1 2345678'])).toBe(false)
        expect(isOwnerNumber('anonymous', ['+43 1 2345678'])).toBe(false)
    })
})

describe('Bereit nur mit Owner-Konfiguration', () => {
    it('Asterisk-Weg ist erst bereit mit aktiv + Owner-Nummer; direkt braucht den Telefon-Baustein', () => {
        saveTelefonEingabe({ weg: 'asterisk', aktiv: true }, opts())
        expect(telefonBereit(readTelefonConfig(opts()))).toBe(false)
        saveTelefonEingabe({ ownerNummern: ['+43 1 2345678'] }, opts())
        expect(telefonBereit(readTelefonConfig(opts()))).toBe(true)
        saveTelefonEingabe({ aktiv: false }, opts())
        expect(telefonBereit(readTelefonConfig(opts()))).toBe(false)
        saveTelefonEingabe({ weg: 'direkt', aktiv: true, server: 'sip.zadarma.com', login: '100100', passwort: PASSWORT }, opts())
        expect(telefonBereit(readTelefonConfig(opts()))).toBe(false)
    })
})

describe('Hinweise in Alltagssprache', () => {
    it('Zadarma ohne eigene Rufnummer: von außen nicht erreichbar', () => {
        saveTelefonEingabe({ server: 'sip.zadarma.com', login: '100100', passwort: PASSWORT }, opts())
        expect(telefonHinweise(readTelefonConfig(opts()), true).join(' ')).toContain('Für Anrufe von außen fehlt noch eine Telefonnummer im Zadarma-Konto')
        saveTelefonEingabe({ rufnummer: '+43 1 2345678' }, opts())
        expect(telefonHinweise(readTelefonConfig(opts()), true).join(' ')).not.toContain('fehlt noch eine Telefonnummer')
    })
    it('ohne Passwort und ohne Owner-Nummer sagt sie, was fehlt', () => {
        saveTelefonEingabe({ server: 'sip.zadarma.com', login: '100100' }, opts())
        const text = telefonHinweise(readTelefonConfig(opts()), false).join(' ')
        expect(text).toContain('Passwort fehlt')
        expect(text).toContain('Owner-Nummer')
    })
})

describe('Asterisk-Vorlage', () => {
    it('enthält AudioSocket auf 127.0.0.1 und nie ein Passwort', () => {
        saveTelefonEingabe({ weg: 'asterisk', server: 'sip.zadarma.com', login: '100100', passwort: PASSWORT }, opts())
        const text = asteriskVorlage(readTelefonConfig(opts()))
        expect(text).toContain('AudioSocket(${XAVENTRA_ID},127.0.0.1:18796)')
        expect(text).toContain('CURL(http://127.0.0.1:18797/anruf?nummer=${URIENCODE(${CALLERID(num)})})')
        expect(text).not.toContain(PASSWORT)
        expect(text).toContain('<PASSWORT-HIER-EINTRAGEN>')
    })
})
