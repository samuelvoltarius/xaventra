/**
 * 2.86 Paket M „Geführt“ — `/api/desktop/gefuehrt` (owner only, behind the
 * desktop token like every owner view):
 * - GET: Einrichtungs-Checkliste, Beispielsätze neuer Verbindungen, Tipp des Tages.
 * - POST /aktion: „Verbinden“ (opens the existing question), „Nicht nötig“,
 *   Tipp „Nein danke“, Beispiele ausblenden. Never switches or connects itself.
 * - POST /hilfe: „Ich komm nicht weiter“ — one sentence + at most one button.
 * Example sentences and tip buttons are sent by the app as ordinary messages
 * into the conversation (the normal request path).
 */
import type { Express, Request, Response } from 'express'
import { collectChecklist } from './setup-checklist.js'
import { connectedEntries, hideBeispiele, noteConnected, offeneBeispiele } from './example-prompts.js'
import { currentTip, runGuidedAction, type GuidedDeps } from './guided-runtime.js'
import { ichKommNichtWeiter } from './stuck-helper.js'

export interface GuidedApiOptions {
    ownerOnly: (req: Request, res: Response) => boolean
    deps?: () => GuidedDeps
    /** Who presses (for the decision memory), e.g. the desktop owner id. */
    owner?: (req: Request) => Promise<string> | string
}

const safe = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/(bearer|token|code|secret)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 200)
const KEY = /^(?:ki|telegram|geraet:[\w:.-]{1,120}|dienst:[\w:.@-]{1,120})$/
const TIPP_ID = /^[a-z][a-z0-9-]{1,40}$/
const BEISPIEL_KEY = /^[ci]:[\w:.@-]{1,160}$/

export function registerGuidedApi(app: Express, options: GuidedApiOptions): void {
    const deps: () => GuidedDeps = options.deps || (() => ({}))
    const route = (handler: (req: Request) => Promise<{ status?: number; body: unknown }>) => async (req: Request, res: Response) => {
        if (!options.ownerOnly(req, res)) return
        try {
            res.setHeader('Cache-Control', 'no-store')
            const result = await handler(req)
            res.status(result.status || 200).json(result.body)
        } catch (error) { res.status(500).json({ error: safe(error) }) }
    }

    app.get('/api/desktop/gefuehrt', route(async () => {
        const d = deps()
        const entries = await (d.verbunden ? d.verbunden() : connectedEntries(d)).catch(() => [])
        noteConnected(entries, d)
        const [einrichtung, tipp] = await Promise.all([collectChecklist({ dataDir: d.dataDir, now: d.now, ...(d.checklist || {}) }), currentTip(d, entries).catch(() => null)])
        return { body: { einrichtung, beispiele: offeneBeispiele(d), tipp } }
    }))

    app.post('/api/desktop/gefuehrt/aktion', route(async req => {
        const d = deps()
        const art = String(req.body?.art || '')
        const by = options.owner ? String(await options.owner(req)) : 'desktop'
        if (art === 'einrichten' || art === 'ueberspringen') {
            const key = String(req.body?.key || '')
            if (!KEY.test(key)) return { status: 400, body: { ok: false, message: 'Unbekannter Punkt.' } }
            const result = await runGuidedAction({ art, key }, { chatId: 'desktop', by }, d)
            return { status: result.ok ? 200 : 409, body: { ok: result.ok, message: result.hinweis || '' } }
        }
        if (art === 'tipp-nein') {
            const id = String(req.body?.id || '')
            if (!TIPP_ID.test(id)) return { status: 400, body: { ok: false, message: 'Unbekannter Tipp.' } }
            const result = await runGuidedAction({ art, id }, { chatId: 'desktop', by }, d)
            return { status: result.ok ? 200 : 409, body: { ok: result.ok, message: result.ansicht?.text.replace(/^👍\s*/, '') || result.hinweis || '' } }
        }
        if (art === 'beispiele-weg') {
            const key = String(req.body?.key || '')
            if (!BEISPIEL_KEY.test(key)) return { status: 400, body: { ok: false, message: 'Unbekannt.' } }
            hideBeispiele(key, d)
            return { body: { ok: true, message: 'Ausgeblendet.' } }
        }
        return { status: 400, body: { ok: false, message: 'Unbekannte Aktion.' } }
    }))

    app.post('/api/desktop/gefuehrt/hilfe', route(async () => {
        const d = deps()
        return { body: await ichKommNichtWeiter({ dataDir: d.dataDir, now: d.now, ...(d.hilfe || {}) }) }
    }))
}
