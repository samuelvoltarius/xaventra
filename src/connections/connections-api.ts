/**
 * 2.85 Paket A — `/api/desktop/verbindungen` (owner only, behind the desktop
 * token like every other owner view). The buttons only start the existing
 * paths: „Verbinden“ creates the card (answered through
 * `/api/desktop/karten/:id/antwort`), „Anmelden“ returns the login address,
 * „Trennen“ disconnects. No route writes configuration without the card's Ja.
 */
import type { Express, Request, Response } from 'express'
import { findDirectoryEntry } from './registry-directory.js'
import { fetchCommunityIcon } from './icon-cache.js'
import { collectConnections, searchCommunity, type ViewDeps } from './connections-view.js'
import {
    allowConnectionTool, beginLogin, completeLoginAndConnect, defaultDeps, disconnectConnection, requestConnect, submitAccess, type ConnectDeps,
} from './connect-flow.js'
import { isConnectionId } from './connection-store.js'

export interface ConnectionsApiOptions {
    ownerOnly: (req: Request, res: Response) => boolean
    deps?: () => ConnectDeps & ViewDeps
    iconDir?: string
}

const safe = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/(bearer|token|code|secret)\s*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 200)

export function registerConnectionsApi(app: Express, options: ConnectionsApiOptions): void {
    const deps = options.deps || (() => defaultDeps())
    const route = (handler: (req: Request) => Promise<{ status?: number; body: unknown }>) => async (req: Request, res: Response) => {
        if (!options.ownerOnly(req, res)) return
        try {
            res.setHeader('Cache-Control', 'no-store')
            const result = await handler(req)
            res.status(result.status || 200).json(result.body)
        } catch (error) { res.status(500).json({ error: safe(error) }) }
    }
    const done = (result: { ok: boolean; message: string; [key: string]: unknown }) => ({ status: result.ok ? 200 : 409, body: result })

    app.get('/api/desktop/verbindungen', route(async () => ({ body: await collectConnections(deps()) })))
    app.get('/api/desktop/verbindungen/verzeichnis', route(async req => ({ body: { eintraege: searchCommunity(String(req.query.q || '').slice(0, 80), { directoryCachePath: deps().directoryCachePath, iconDir: options.iconDir }) } })))
    // Community icon: fetched by the Main on first display, checked and cached (never by the viewer's browser).
    app.get('/api/desktop/verbindungen/icon', route(async req => {
        const entry = findDirectoryEntry(String(req.query.name || ''), deps().directoryCachePath)
        if (!entry?.icon) return { status: 404, body: { error: 'kein Icon' } }
        const icon = await fetchCommunityIcon(entry.icon.src, { cacheDir: options.iconDir })
        return icon.ok === true ? { body: { dataUri: icon.dataUri } } : { status: 404, body: { error: (icon as { reason: string }).reason } }
    }))
    app.post('/api/desktop/verbindungen/verbinden', route(async req => {
        const result = await requestConnect({ connectorId: String(req.body?.connectorId || ''), basis: req.body?.basis, ordner: req.body?.ordner, quelle: 'desktop' }, deps())
        return result.ok ? { body: { ok: true, message: result.message, cardId: result.card.id } } : { status: 409, body: result }
    }))
    app.post('/api/desktop/verbindungen/rueckkehr', route(async req => done(await completeLoginAndConnect({ address: req.body?.adresse }, deps()))))
    app.post('/api/desktop/verbindungen/:id/anmelden', route(async req => {
        if (!isConnectionId(req.params.id)) return { status: 404, body: { error: 'Unbekannte Verbindung' } }
        return done(await beginLogin(req.params.id, deps()))
    }))
    app.post('/api/desktop/verbindungen/:id/zugang', route(async req => {
        if (!isConnectionId(req.params.id)) return { status: 404, body: { error: 'Unbekannte Verbindung' } }
        return done(await submitAccess(req.params.id, req.body?.werte || {}, deps()))
    }))
    app.post('/api/desktop/verbindungen/:id/trennen', route(async req => {
        if (!isConnectionId(req.params.id)) return { status: 404, body: { error: 'Unbekannte Verbindung' } }
        return done(await disconnectConnection(req.params.id, deps()))
    }))
    app.post('/api/desktop/verbindungen/:id/werkzeug', route(async req => {
        if (!isConnectionId(req.params.id)) return { status: 404, body: { error: 'Unbekannte Verbindung' } }
        return done(await allowConnectionTool(req.params.id, String(req.body?.werkzeug || ''), deps()))
    }))
}
