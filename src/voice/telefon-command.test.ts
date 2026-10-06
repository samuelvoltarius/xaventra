import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleTelefonCommand, isSensitiveTelefonCommand } from './telefon-command.js'
import { readTelefonPasswort } from './telefon-config.js'

// 2.87 Paket P: /telefon als Telegram-Dialog. Beispielwerte, kein Netz.

const PASSWORT = 'Beispiel-Passwort-123'
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'telefon-cmd-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function run(args: string, extra: Record<string, unknown> = {}) {
    return handleTelefonCommand(args, { store: { dataDir: dir }, apply: async () => false, ...extra })
}

describe('/telefon', () => {
    it('ohne Einrichtung: sagt in drei Schritten, was es braucht', async () => {
        const text = await run('')
        expect(text).toContain('noch nicht eingerichtet')
        expect(text).toContain('/telefon server sip.zadarma.com')
    })

    it('Zadarma per Dialog: Server, Login, Passwort — Passwort nie in einer Antwort', async () => {
        expect(await run('server sip.zadarma.com')).toBe('Gespeichert: Server sip.zadarma.com.')
        expect(await run('login 100100')).toBe('Gespeichert: Login.')
        const answer = await run(`passwort ${PASSWORT}`)
        expect(answer).not.toContain(PASSWORT)
        expect(answer).toContain('lösch deine Nachricht')
        expect(readTelefonPasswort({ dataDir: dir })).toBe(PASSWORT)
        const stand = await run('')
        expect(stand).toContain('Zadarma (TLS 5061), Login 100100, Passwort gespeichert')
        expect(stand).toContain('Für Anrufe von außen fehlt noch eine Telefonnummer im Zadarma-Konto')
        expect(stand).not.toContain(PASSWORT)
    })

    it('Owner-Nummern hinzufügen und entfernen', async () => {
        expect(await run('owner +43 1 2345678')).toBe('Gespeichert: +4312345678 darf mich anrufen.')
        expect(await run('owner weg +43 1 2345678')).toBe('Entfernt: +4312345678.')
        expect(await run('owner 12')).toContain('Ländervorwahl')
    })

    it('prüfen und anrufen gehen über die vorhandenen Wege', async () => {
        const pruefen = vi.fn(async () => ({ ok: false, text: 'Anmeldung bei Zadarma hat nicht geklappt — Passwort prüfen.' }))
        const anrufen = vi.fn(async (nummer: string) => `Karte für ${nummer}`)
        expect(await run('pruefen', { pruefen })).toBe('Anmeldung bei Zadarma hat nicht geklappt — Passwort prüfen.')
        expect(await run('anrufen +43 1 7654321', { anrufen })).toBe('Karte für +43 1 7654321')
    })

    it('Passwort-Befehle sind vertraulich (Pipeline protokolliert sie nicht)', () => {
        expect(isSensitiveTelefonCommand(`/telefon passwort ${PASSWORT}`)).toBe(true)
        expect(isSensitiveTelefonCommand('/telefon server sip.zadarma.com')).toBe(false)
        // Dieselbe Regel steht in der Pipeline vor jedem Log.
        const pipeline = readFileSync(join(__dirname, '..', 'core', 'message-pipeline.ts'), 'utf8')
        expect(pipeline).toMatch(/isSensitiveAuthCommand = .*telefon\\s\+\(\?:passwort\|ari-passwort\)/)
        expect(pipeline).toContain("isSensitiveAuthCommand ? '[vertraulicher Befehl]'")
    })

    it('aus = nichts lauscht mehr, löschen entfernt auch das Passwort', async () => {
        await run(`passwort ${PASSWORT}`)
        expect(await run('aus')).toContain('ausgeschaltet')
        expect(await run('loeschen')).toContain('gelöscht')
        expect(readTelefonPasswort({ dataDir: dir })).toBe('')
    })
})
