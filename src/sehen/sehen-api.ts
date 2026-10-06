/**
 * 2.88 „Sehen und lenken“: Owner-API für Ihr Computer, Aktivität und Regeln.
 * Hängt an der bestehenden, authentifizierten Desktop-API (/api/desktop/*,
 * derselbe Bearer/Owner-Check, kein neuer Port). Jede Route ist ownerOnly.
 */
import type { Express, Request, Response } from 'express'
import type { AktivitaetQuellen } from './aktivitaet.js'
import type { BildschirmDeps } from './bildschirm.js'
import type { DecisionOptions } from '../core/decisions.js'

export interface SehenApiOptions {
    ownerOnly: (req: Request, res: Response) => boolean
    /** Owner-Kennung für Prüfspuren (nie aus einem Client-Header, wenn Token-Owner). */
    principal: (req: Request) => string
    aktivitaet?: AktivitaetQuellen
    bildschirm?: BildschirmDeps
    regeln?: DecisionOptions
    /** false = kein Hintergrund-Takt für „Später“ (Tests). */
    takt?: boolean
}

let taktGestartet = false

export function registerSehenApi(app: Express, options: SehenApiOptions): void {
    const route = (handler: (req: Request) => Promise<{ status?: number; body: unknown }>) => async (req: Request, res: Response) => {
        if (!options.ownerOnly(req, res)) return
        res.setHeader('Cache-Control', 'no-store')
        try {
            const result = await handler(req)
            res.status(result.status || 200).json(result.body)
        } catch {
            res.status(500).json({ error: 'Das hat gerade nicht geklappt.' })
        }
    }
    const by = (req: Request) => `desktop:${String(options.principal(req) || 'owner').slice(0, 80)}`
    const antwort = (result: { ok: boolean }) => ({ status: result.ok ? 200 : 409, body: result })

    // Aktivität
    app.get('/api/desktop/aktivitaet', route(async () => ({ body: await (await import('./aktivitaet.js')).sammleAktivitaet(options.aktivitaet) })))
    app.post('/api/desktop/aktivitaet/:id', route(async req => {
        const { steuereAktivitaet } = await import('./aktivitaet.js')
        return antwort(await steuereAktivitaet(req.params.id, req.body?.aktion, { by: by(req), text: req.body?.text, minuten: req.body?.minuten }, options.aktivitaet))
    }))

    // Ihr Computer
    app.get('/api/desktop/bildschirme', route(async () => ({ body: await (await import('./bildschirm.js')).listeBildschirme(options.bildschirm) })))
    app.get('/api/desktop/bildschirme/:id/bild', route(async req => {
        const result = await (await import('./bildschirm.js')).bildschirmBild(req.params.id, String(options.principal(req) || 'owner'), options.bildschirm)
        return { status: result.ok ? 200 : 409, body: result }
    }))
    app.post('/api/desktop/bildschirme/:id', route(async req => {
        const { steuereBildschirm } = await import('./bildschirm.js')
        return antwort(await steuereBildschirm(req.params.id, req.body?.aktion, { by: by(req), text: req.body?.text }, options.bildschirm))
    }))
    app.post('/api/desktop/bildschirme/:id/eingabe', route(async req => {
        const { bildschirmEingabe } = await import('./bildschirm.js')
        return antwort(await bildschirmEingabe(req.params.id, req.body?.action, options.bildschirm))
    }))

    // Regeln in Klartext
    app.get('/api/desktop/regeln', route(async () => {
        const { listeRegeln } = await import('./regeln.js')
        return { body: { regeln: listeRegeln(options.regeln), beispiele: ['Lichter darfst du ohne Frage schalten', 'Bei Mails immer fragen', 'Nie etwas löschen'],
            fest: 'Geld, Passwörter und Zugangsdaten, Löschen und die Nie-Liste bleiben immer fest.' } }
    }))
    app.post('/api/desktop/regeln', route(async req => {
        const { neueRegel } = await import('./regeln.js')
        return antwort(neueRegel(req.body?.text, { principalId: String(options.principal(req) || 'owner'), kanal: 'desktop-regeln' }, options.regeln))
    }))
    app.post('/api/desktop/regeln/:id', route(async req => {
        const { aendereRegel } = await import('./regeln.js')
        return antwort(aendereRegel(req.params.id, req.body?.wirkung, { principalId: String(options.principal(req) || 'owner') }, options.regeln))
    }))
    app.delete('/api/desktop/regeln/:id', route(async req => {
        const { entferneRegel } = await import('./regeln.js')
        return antwort(entferneRegel(req.params.id, { principalId: String(options.principal(req) || 'owner') }, options.regeln))
    }))

    // „Später“ läuft auch weiter, wenn niemand die Seite offen hat.
    if (options.takt !== false && !taktGestartet) {
        taktGestartet = true
        const timer = setInterval(() => {
            void import('./aktivitaet.js').then(({ setzeFaelligeFort }) => setzeFaelligeFort(options.aktivitaet)).catch(() => undefined)
        }, 60_000)
        timer.unref?.()
    }
}
