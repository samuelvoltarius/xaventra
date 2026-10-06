/**
 * 2.87 Paket P: Verbindungen → „Telefon“ (nur Owner, hinter dem Desktop-Token).
 *
 *   GET    /api/desktop/telefon          Einstellungen ohne Passwörter, Hinweise, Anlagen-Vorlage
 *   PATCH  /api/desktop/telefon          Eingabe speichern (Passwort → Secrets-Ablage), Telefon neu laden
 *   POST   /api/desktop/telefon/pruefen  Login beim Anbieter prüfen (nur Abfrage, ändert nichts)
 *   POST   /api/desktop/telefon/anrufen  { nummer } Owner-Nummer direkt, sonst Karte
 *   DELETE /api/desktop/telefon          alles löschen (auch Passwörter), nichts lauscht mehr
 *
 * Keine Antwort enthält je ein Passwort.
 */
import type { Express, Request, Response } from 'express'
import { anbieterStandard, asteriskVorlage, readTelefonConfig, readTelefonPasswort, saveTelefonEingabe, saveTelefonPruefung, telefonOeffentlich, telefonZuruecksetzen, type TelefonEingabe, type TelefonStoreOptions } from '../voice/telefon-config.js'
import type { SipCheckResult } from '../voice/sip-login-check.js'

type MessageHandler = (message: string, channel: string) => Promise<string>

export interface TelefonApiOptions {
    ownerOnly: (req: Request, res: Response) => boolean
    resolveHandler?: () => MessageHandler | null
    store?: TelefonStoreOptions
    /** Tests: Login-Prüfung und Neustart ersetzen (kein Netz). */
    check?: (target: { server: string; port: number; transport: 'tls' | 'tcp' | 'udp'; login: string }, password: string, anbieter?: string) => Promise<SipCheckResult>
    apply?: () => Promise<boolean>
    anrufen?: (nummer: unknown) => Promise<string>
}

const FIELDS = ['aktiv', 'weg', 'server', 'port', 'transport', 'login', 'passwort', 'anzeigename', 'rufnummer', 'ownerNummern'] as const

export async function telefonAnsicht(store: TelefonStoreOptions = {}) {
    const view = telefonOeffentlich(store)
    const { telefonLauscht } = await import('../voice/telefon-runtime.js')
    return { ...view, lauscht: telefonLauscht(), vorlage: view.weg === 'asterisk' ? asteriskVorlage(readTelefonConfig(store)) : undefined }
}

export async function pruefeTelefon(store: TelefonStoreOptions = {}, check?: TelefonApiOptions['check']): Promise<SipCheckResult> {
    const config = readTelefonConfig(store)
    const anbieter = anbieterStandard(config.sip.server).anbieter
    const run = check || (async (target, password, name) => (await import('../voice/sip-login-check.js')).checkSipLogin(target, password, { anbieter: name }))
    const result = await run(config.sip, readTelefonPasswort(store), anbieter)
    saveTelefonPruefung(result, store)
    return result
}

export function registerTelefonApi(app: Express, options: TelefonApiOptions): void {
    const store = options.store || {}
    const apply = options.apply || (async () => (await import('../voice/telefon-runtime.js')).applyTelefonConfig(options.resolveHandler))
    const route = (handler: (req: Request) => Promise<{ status?: number; body: unknown }>) => async (req: Request, res: Response) => {
        if (!options.ownerOnly(req, res)) return
        res.setHeader('Cache-Control', 'no-store')
        try {
            const result = await handler(req)
            res.status(result.status || 200).json(result.body)
        } catch {
            // Nie Fehlertexte durchreichen (könnten Eingaben enthalten).
            res.status(500).json({ error: 'Das hat nicht geklappt.' })
        }
    }

    app.get('/api/desktop/telefon', route(async () => ({ body: await telefonAnsicht(store) })))
    app.patch('/api/desktop/telefon', route(async req => {
        const body = req.body && typeof req.body === 'object' ? req.body : {}
        const input: TelefonEingabe = {}
        for (const field of FIELDS) if (body[field] !== undefined) (input as any)[field] = body[field]
        if (body.asterisk && typeof body.asterisk === 'object') input.asterisk = {
            ...(body.asterisk.ariUrl !== undefined ? { ariUrl: body.asterisk.ariUrl } : {}),
            ...(body.asterisk.ariBenutzer !== undefined ? { ariBenutzer: body.asterisk.ariBenutzer } : {}),
            ...(body.asterisk.ariPasswort !== undefined ? { ariPasswort: body.asterisk.ariPasswort } : {}),
            ...(body.asterisk.ausgang !== undefined ? { ausgang: body.asterisk.ausgang } : {}),
        }
        const saved = saveTelefonEingabe(input, store)
        if (!saved.ok) { const fail = saved as { feld: string; meldung: string }; return { status: 400, body: { ok: false, feld: fail.feld, meldung: fail.meldung } } }
        await apply().catch(() => false)
        return { body: { ok: true, telefon: await telefonAnsicht(store) } }
    }))
    app.post('/api/desktop/telefon/pruefen', route(async () => ({ body: await pruefeTelefon(store, options.check) })))
    app.post('/api/desktop/telefon/anrufen', route(async req => {
        const run = options.anrufen || (async (nummer: unknown) => (await import('../voice/telefon-ausgang.js')).anrufen(nummer))
        return { body: { text: await run(req.body?.nummer) } }
    }))
    app.delete('/api/desktop/telefon', route(async () => {
        telefonZuruecksetzen(store)
        await apply().catch(() => false)
        return { body: { ok: true, telefon: await telefonAnsicht(store) } }
    }))
}
