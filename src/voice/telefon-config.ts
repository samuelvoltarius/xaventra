/**
 * 2.87 Paket P: „Telefon“ — SIP-Zugang und Anbindung an eine Telefonanlage.
 *
 * Ohne Eingabe des Owners ist alles aus: nichts lauscht, nichts ruft an.
 *
 * - `<data>/telefon/telefon.json`: Server, Login, Transport, Owner-Nummern …
 *   NIE ein Passwort.
 * - Passwörter (SIP, optional ARI) liegen in der Secrets-Ablage
 *   (`<data>/secrets/connections/c-telefon.json`, Datei 0600, Ordner 0700),
 *   werden nie angezeigt, geloggt oder in Karten/Memos geschrieben.
 *
 * Zwei Wege:
 * - `direkt` (Standard für die meisten): Xaventra meldet sich selbst beim
 *   SIP-Anbieter an. Den Login prüft sie schon heute (sip-login-check.ts);
 *   Gespräche brauchen noch den Telefon-Baustein (siehe docs/VOICE.md).
 * - `asterisk`: eine vorhandene Telefonanlage reicht Anrufe lokal per
 *   AudioSocket an 127.0.0.1 weiter (telefon-bridge.ts). Der Owner schaltet das
 *   in seiner Anlage frei; Xaventra liest oder ändert deren Dateien nie.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getNovaDataDir } from '../core/data-root.js'
import { readConnectionSecrets, updateConnectionSecrets } from '../connections/connection-store.js'

export type TelefonWeg = 'direkt' | 'asterisk'
export type SipTransport = 'tls' | 'tcp' | 'udp'

export interface TelefonConfig {
    version: 1
    aktiv: boolean
    weg: TelefonWeg
    sip: { server: string; port: number; transport: SipTransport; login: string; anzeigename?: string; rufnummer?: string }
    /** Nur diese Nummern dürfen anrufen und angerufen werden (ohne Karte). */
    ownerNummern: string[]
    asterisk: { audioSocketPort: number; anmeldePort: number; ariUrl?: string; ariBenutzer?: string; ariApp: string
        /** Ausgangsleitung der Anlage, z. B. „SIP/{nummer}@meinanbieter“ (nur für ausgehende Anrufe). */
        ausgang?: string }
    /** Letzte Login-Prüfung (nur Ergebnis, nie Zugangsdaten). */
    pruefung?: { at: string; ok: boolean; text: string }
    updatedAt?: string
}

export interface TelefonStoreOptions { dataDir?: string; now?: () => number }

export const TELEFON_SECRET_ID = 'c-telefon'
export const AUDIOSOCKET_PORT = 18796
export const ANMELDE_PORT = 18797

const DEFAULTS: TelefonConfig = Object.freeze({
    version: 1, aktiv: false, weg: 'direkt',
    sip: { server: '', port: 5060, transport: 'udp', login: '' },
    ownerNummern: [],
    asterisk: { audioSocketPort: AUDIOSOCKET_PORT, anmeldePort: ANMELDE_PORT, ariApp: 'xaventra' },
}) as TelefonConfig

const dataDirOf = (opts: TelefonStoreOptions) => opts.dataDir || getNovaDataDir()
const configFile = (opts: TelefonStoreOptions) => join(dataDirOf(opts), 'telefon', 'telefon.json')

/**
 * Anbieter-Standards. Zadarma (Doku „FreePBX PJSIP setup“): sip.zadarma.com,
 * 5060 Standard bzw. 5061 mit Verschlüsselung (TLS + SRTP). Wir nehmen die
 * verschlüsselte Variante — das Passwort-Digest geht so nie offen übers Netz.
 */
export function anbieterStandard(server: string): { transport: SipTransport; port: number; anbieter?: string } {
    if (/(^|\.)zadarma\.com$/i.test(server)) return { transport: 'tls', port: 5061, anbieter: 'Zadarma' }
    return { transport: 'udp', port: 5060 }
}

export function readTelefonConfig(opts: TelefonStoreOptions = {}): TelefonConfig {
    try {
        const raw = JSON.parse(readFileSync(configFile(opts), 'utf8'))
        if (raw?.version !== 1) return structuredClone(DEFAULTS)
        return {
            ...structuredClone(DEFAULTS), ...raw,
            sip: { ...DEFAULTS.sip, ...(raw.sip || {}) },
            asterisk: { ...DEFAULTS.asterisk, ...(raw.asterisk || {}) },
            ownerNummern: Array.isArray(raw.ownerNummern) ? raw.ownerNummern.filter((item: unknown) => typeof item === 'string') : [],
            aktiv: raw.aktiv === true,
            weg: raw.weg === 'asterisk' ? 'asterisk' : 'direkt',
        }
    } catch { return structuredClone(DEFAULTS) }
}

function writeConfig(config: TelefonConfig, opts: TelefonStoreOptions): void {
    const path = configFile(opts)
    mkdirSync(join(dataDirOf(opts), 'telefon'), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
}

const secretOpts = (opts: TelefonStoreOptions) => ({ dataDir: dataDirOf(opts) })

/** Nur für den Login und die Anmeldung beim Anbieter — nie anzeigen, nie loggen. */
export function readTelefonPasswort(opts: TelefonStoreOptions = {}): string {
    return String(readConnectionSecrets(TELEFON_SECRET_ID, secretOpts(opts)).zugang?.SIP_PASSWORT || '')
}
export function readAriPasswort(opts: TelefonStoreOptions = {}): string {
    return String(readConnectionSecrets(TELEFON_SECRET_ID, secretOpts(opts)).zugang?.ARI_PASSWORT || '')
}

/** „+43 (1) 234-5678“ / „0043 1 2345678“ → „+4312345678“; national „01…“ bleibt „01…“. */
export function normalizeNumber(value: unknown): string {
    const raw = String(value ?? '').trim()
    if (!raw) return ''
    const digits = raw.replace(/[^\d+]/g, '')
    if (digits.startsWith('+')) return `+${digits.slice(1).replace(/\D/g, '')}`
    if (digits.startsWith('00')) return `+${digits.slice(2)}`
    return digits.replace(/\D/g, '')
}

const E164 = /^\+[1-9]\d{6,14}$/

/** Gehört die (vom Anbieter gemeldete) Nummer zu den Owner-Nummern? Leer/anonym nie. */
export function isOwnerNumber(caller: unknown, ownerNummern: readonly string[]): boolean {
    const number = normalizeNumber(caller)
    if (!/^\+?\d{6,15}$/.test(number)) return false
    return ownerNummern.map(normalizeNumber).filter(item => E164.test(item)).some(owner => {
        if (number === owner) return true
        // Nationale Schreibweise des Anbieters („0…“ ohne Ländervorwahl).
        if (/^0[1-9]/.test(number)) return owner.endsWith(number.slice(1)) && number.length >= 7
        return false
    })
}

export interface TelefonEingabe {
    aktiv?: boolean
    weg?: TelefonWeg
    server?: string
    port?: number
    transport?: SipTransport
    login?: string
    passwort?: string
    anzeigename?: string
    rufnummer?: string
    ownerNummern?: string[]
    asterisk?: { ariUrl?: string; ariBenutzer?: string; ariPasswort?: string; ausgang?: string }
}

export type TelefonSaveResult = { ok: true; config: TelefonConfig } | { ok: false; feld: string; meldung: string }

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^(?:\d{1,3}\.){3}\d{1,3}$/i
const LOGIN = /^[A-Za-z0-9._@+-]{1,64}$/
const SECRET = /^[^\r\n\0]{1,128}$/

/** Eingabe aus App oder Telegram prüfen und speichern (Passwort in die Secrets-Ablage). */
export function saveTelefonEingabe(input: TelefonEingabe, opts: TelefonStoreOptions = {}): TelefonSaveResult {
    const current = readTelefonConfig(opts)
    const next: TelefonConfig = structuredClone(current)
    const fail = (feld: string, meldung: string): TelefonSaveResult => ({ ok: false, feld, meldung })

    if (input.server !== undefined) {
        const server = String(input.server).trim().toLowerCase()
        if (!HOST.test(server)) return fail('server', 'Der Server sieht nicht wie ein Rechnername aus (z. B. sip.zadarma.com, ohne http://).')
        const changed = server !== current.sip.server
        next.sip.server = server
        if (changed && input.transport === undefined && input.port === undefined) {
            const standard = anbieterStandard(server)
            next.sip.transport = standard.transport
            next.sip.port = standard.port
        }
    }
    if (input.transport !== undefined) {
        if (!['tls', 'tcp', 'udp'].includes(String(input.transport))) return fail('transport', 'Transport ist tls, tcp oder udp.')
        next.sip.transport = input.transport
    }
    if (input.port !== undefined) {
        const port = Number(input.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('port', 'Der Port ist eine Zahl von 1 bis 65535.')
        next.sip.port = port
    }
    if (input.login !== undefined) {
        const login = String(input.login).trim()
        if (!LOGIN.test(login)) return fail('login', 'Der Login besteht aus Buchstaben, Ziffern oder . _ @ + - (ohne Leerzeichen).')
        next.sip.login = login
    }
    if (input.anzeigename !== undefined) {
        const name = String(input.anzeigename).replace(/[\r\n"<>]/g, '').trim().slice(0, 60)
        next.sip.anzeigename = name || undefined
    }
    if (input.rufnummer !== undefined) {
        const number = normalizeNumber(input.rufnummer)
        if (number && !E164.test(number)) return fail('rufnummer', 'Die Rufnummer bitte mit Ländervorwahl, z. B. +43 …')
        next.sip.rufnummer = number || undefined
    }
    if (input.ownerNummern !== undefined) {
        const list = (Array.isArray(input.ownerNummern) ? input.ownerNummern : []).map(normalizeNumber).filter(Boolean)
        if (list.some(item => !E164.test(item))) return fail('ownerNummern', 'Owner-Nummern bitte mit Ländervorwahl, z. B. +43 …')
        next.ownerNummern = [...new Set(list)].slice(0, 10)
    }
    if (input.weg !== undefined) next.weg = input.weg === 'asterisk' ? 'asterisk' : 'direkt'
    if (input.aktiv !== undefined) next.aktiv = input.aktiv === true
    if (input.asterisk?.ariUrl !== undefined) {
        const url = String(input.asterisk.ariUrl).trim()
        if (url && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/?$/.test(url)) return fail('ariUrl', 'Die Telefonanlage wird nur auf diesem Rechner angesprochen (http://127.0.0.1:Port).')
        next.asterisk.ariUrl = url ? url.replace(/\/$/, '') : undefined
    }
    if (input.asterisk?.ariBenutzer !== undefined) {
        const user = String(input.asterisk.ariBenutzer).trim()
        if (user && !LOGIN.test(user)) return fail('ariBenutzer', 'Der Benutzer besteht aus Buchstaben, Ziffern oder . _ @ + -')
        next.asterisk.ariBenutzer = user || undefined
    }
    if (input.asterisk?.ausgang !== undefined) {
        const ausgang = String(input.asterisk.ausgang).trim()
        if (ausgang && !/^(?:SIP|PJSIP|IAX2)\/[A-Za-z0-9_.@{}\/-]{1,80}$/.test(ausgang) || ausgang && !ausgang.includes('{nummer}')) return fail('ausgang', 'Die Ausgangsleitung sieht so aus: SIP/{nummer}@meinanbieter')
        next.asterisk.ausgang = ausgang || undefined
    }
    const passwort = input.passwort === undefined ? undefined : String(input.passwort)
    if (passwort !== undefined && passwort !== '' && !SECRET.test(passwort)) return fail('passwort', 'Das Passwort darf keine Zeilenumbrüche enthalten und höchstens 128 Zeichen lang sein.')
    const ariPasswort = input.asterisk?.ariPasswort === undefined ? undefined : String(input.asterisk.ariPasswort)
    if (ariPasswort !== undefined && ariPasswort !== '' && !SECRET.test(ariPasswort)) return fail('ariPasswort', 'Das Passwort darf keine Zeilenumbrüche enthalten.')

    if (passwort || ariPasswort) {
        updateConnectionSecrets(TELEFON_SECRET_ID, secrets => ({
            ...secrets,
            zugang: { ...(secrets.zugang || {}), ...(passwort ? { SIP_PASSWORT: passwort } : {}), ...(ariPasswort ? { ARI_PASSWORT: ariPasswort } : {}) },
        }), secretOpts(opts))
    }
    // Neue Zugangsdaten → alte Prüfung gilt nicht mehr.
    if (passwort || input.server !== undefined || input.login !== undefined || input.port !== undefined || input.transport !== undefined) delete next.pruefung
    next.updatedAt = new Date((opts.now || Date.now)()).toISOString()
    writeConfig(next, opts)
    return { ok: true, config: next }
}

export function saveTelefonPruefung(result: { ok: boolean; text: string }, opts: TelefonStoreOptions = {}): void {
    const config = readTelefonConfig(opts)
    config.pruefung = { at: new Date((opts.now || Date.now)()).toISOString(), ok: result.ok, text: String(result.text).slice(0, 200) }
    writeConfig(config, opts)
}

/** Alles weg (Konfiguration + Passwörter). */
export function telefonZuruecksetzen(opts: TelefonStoreOptions = {}): void {
    writeConfig(structuredClone(DEFAULTS), opts)
    updateConnectionSecrets(TELEFON_SECRET_ID, secrets => ({ ...secrets, zugang: {} }), secretOpts(opts))
}

/**
 * Darf die Telefon-Brücke lauschen? Nur auf dem Asterisk-Weg, nur aktiv, nur mit
 * mindestens einer Owner-Nummer. Der direkte Weg braucht zusätzlich den
 * Telefon-Baustein — den gibt es noch nicht, also lauscht dort nichts.
 */
export function telefonBereit(config: TelefonConfig): boolean {
    return config.aktiv && config.weg === 'asterisk' && config.ownerNummern.some(item => E164.test(normalizeNumber(item)))
}

/** Was noch fehlt oder wichtig ist — in Alltagssprache. */
export function telefonHinweise(config: TelefonConfig, passwortGespeichert: boolean): string[] {
    const out: string[] = []
    const anbieter = anbieterStandard(config.sip.server).anbieter
    if (config.weg === 'direkt') {
        if (!config.sip.server || !config.sip.login) out.push('Trag Server und Login deines Telefonanbieters ein.')
        else if (!passwortGespeichert) out.push('Das Passwort fehlt noch.')
        if (config.sip.server && !config.sip.rufnummer) {
            out.push(anbieter
                ? `Für Anrufe von außen fehlt noch eine Telefonnummer im ${anbieter}-Konto. Mit dem Login allein bin ich nur innerhalb von ${anbieter} erreichbar.`
                : 'Für Anrufe von außen braucht der Zugang eine eigene Telefonnummer beim Anbieter. Trag sie hier ein, sobald du eine hast.')
        }
        if (config.sip.transport === 'udp') out.push('Die Login-Prüfung geht nur verschlüsselt (TLS) oder über TCP; mit UDP prüfe ich über TCP.')
        out.push('Gespräche direkt aus Xaventra brauchen noch den Telefon-Baustein. Bis dahin kann ich den Login prüfen; telefonieren geht über eine Telefonanlage (Asterisk).')
    } else {
        if (!config.aktiv) out.push('Das Telefon ist ausgeschaltet.')
        out.push('Deine Telefonanlage reicht Anrufe nur an 127.0.0.1 weiter. Die Änderung in der Anlage machst du selbst (Vorlage unten).')
    }
    if (!config.ownerNummern.length) out.push('Trag mindestens eine Owner-Nummer ein — nur diese Nummern dürfen mich anrufen.')
    return out
}

export interface TelefonView {
    eingerichtet: boolean
    aktiv: boolean
    weg: TelefonWeg
    bereit: boolean
    sip: TelefonConfig['sip'] & { anbieter?: string }
    ownerNummern: string[]
    passwortGespeichert: boolean
    ariPasswortGespeichert: boolean
    asterisk: { audioSocket: string; anmeldung: string; ariUrl?: string; ariBenutzer?: string; ausgang?: string }
    pruefung?: TelefonConfig['pruefung']
    hinweise: string[]
}

/** Für App und Telegram: alles außer den Passwörtern. */
export function telefonOeffentlich(opts: TelefonStoreOptions = {}): TelefonView {
    const config = readTelefonConfig(opts)
    const passwortGespeichert = Boolean(readTelefonPasswort(opts))
    return {
        eingerichtet: Boolean(config.sip.server || config.weg === 'asterisk' && config.updatedAt),
        aktiv: config.aktiv,
        weg: config.weg,
        bereit: telefonBereit(config),
        sip: { ...config.sip, ...(anbieterStandard(config.sip.server).anbieter ? { anbieter: anbieterStandard(config.sip.server).anbieter } : {}) },
        ownerNummern: config.ownerNummern,
        passwortGespeichert,
        ariPasswortGespeichert: Boolean(readAriPasswort(opts)),
        asterisk: { audioSocket: `127.0.0.1:${config.asterisk.audioSocketPort}`, anmeldung: `127.0.0.1:${config.asterisk.anmeldePort}`, ariUrl: config.asterisk.ariUrl, ariBenutzer: config.asterisk.ariBenutzer, ausgang: config.asterisk.ausgang },
        pruefung: config.pruefung,
        hinweise: telefonHinweise(config, passwortGespeichert),
    }
}

/**
 * Vorschlag für die Telefonanlage (der Owner trägt ihn selbst ein). Kein
 * Passwort — nur ein Platzhalter. Alles bleibt auf 127.0.0.1.
 */
export function asteriskVorlage(config: TelefonConfig): string {
    const audio = `127.0.0.1:${config.asterisk.audioSocketPort}`
    const anmelden = `http://127.0.0.1:${config.asterisk.anmeldePort}`
    const lines = [
        '; ===== extensions.conf — Xaventra nimmt Anrufe an (nur 127.0.0.1) =====',
        '; Voraussetzung: Module app_audiosocket und func_curl (asterisk -rx "module show like audiosocket").',
        '[xaventra]',
        'exten => s,1,NoOp(Anruf an Xaventra von ${CALLERID(num)})',
        ` same => n,Set(XAVENTRA_ID=\${CURL(${anmelden}/anruf?nummer=\${URIENCODE(\${CALLERID(num)})})})`,
        ' same => n,GotoIf($["${XAVENTRA_ID}" = ""]?ende)',
        ' same => n,Answer()',
        ` same => n,AudioSocket(\${XAVENTRA_ID},${audio})`,
        ' same => n(ende),Hangup()',
        '',
        '; Im Eingangs-Kontext (z. B. [incoming]) die bisherige Weiterleitung',
        '; (z. B. die Zeile mit Dial(SIP/livekit-sip/...)) ersetzen durch:',
        ';   same => n,Goto(xaventra,s,1)',
        '',
        '; Nur für ausgehende Anrufe (Xaventra wählt über ARI, Anleitung docs/VOICE.md):',
        '[xaventra-raus]',
        `exten => s,1,Set(XAVENTRA_ID=\${CURL(${anmelden}/anruf?richtung=raus&nummer=\${URIENCODE(\${XAVENTRA_NUMMER})})})`,
        ' same => n,GotoIf($["${XAVENTRA_ID}" = ""]?ende)',
        ` same => n,AudioSocket(\${XAVENTRA_ID},${audio})`,
        ' same => n(ende),Hangup()',
        '; Danach: asterisk -rx "dialplan reload"',
    ]
    if (config.sip.server && config.sip.login) {
        lines.push(
            '',
            '; ===== nur falls noch KEIN Anbieter-Zugang eingerichtet ist (chan_sip, sip.conf) =====',
            `register => ${config.sip.transport === 'tls' ? 'tls://' : config.sip.transport === 'tcp' ? 'tcp://' : ''}${config.sip.login}:<PASSWORT-HIER-EINTRAGEN>@${config.sip.server}:${config.sip.port}/${config.sip.login}`,
            '[xaventra-anbieter]',
            'type=friend',
            `host=${config.sip.server}`,
            `port=${config.sip.port}`,
            `defaultuser=${config.sip.login}`,
            'secret=<PASSWORT-HIER-EINTRAGEN>',
            `fromuser=${config.sip.login}`,
            `fromdomain=${config.sip.server}`,
            `transport=${config.sip.transport}`,
            'insecure=invite,port',
            'nat=force_rport,comedia',
            'directmedia=no',
            'disallow=all',
            'allow=alaw&ulaw',
            'context=incoming',
        )
    }
    return lines.join('\n')
}
