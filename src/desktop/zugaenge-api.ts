/**
 * 2.88 „Verbinden ohne Technik“: Verbindungen → „Proxmox“ und „Passwort-Tresor“
 * (owner only, behind the desktop token).
 *
 *   GET    /api/desktop/proxmox           view (address suggestion, fingerprint start/end, 3-step guide) — never the token
 *   POST   /api/desktop/proxmox           { adresse?, token? } → token 0600, fingerprint read, ONE confirm card
 *   POST   /api/desktop/proxmox/pruefen   read access + pool, one sentence
 *   DELETE /api/desktop/proxmox           forget address, fingerprint, token
 *   GET    /api/desktop/tresor            entries: id, name, source, released services — never a value
 *   POST   /api/desktop/tresor            add/update an entry (value only for source „datei“, stored 0600)
 *   DELETE /api/desktop/tresor/:id        remove the entry (the password manager itself is never touched)
 *
 * No answer contains a token, password or user name; error texts are never passed through.
 */
import type { Express, Request, Response } from 'express'
import { entferneEintrag, speichereEintrag, zugaengeSicht, type TresorDeps } from '../secrets/credential-broker.js'
import { proxmoxAnsicht, pruefeProxmox, speichereProxmoxZugang, type SetupDeps } from '../infra/proxmox-setup.js'
import { clearProxmoxApp } from '../infra/proxmox-app-store.js'

export interface ZugaengeApiOptions {
    ownerOnly: (req: Request, res: Response) => boolean
    proxmox?: SetupDeps
    tresor?: TresorDeps
}

export const TRESOR_HINWEISE: readonly string[] = Object.freeze([
    'Ich sehe nur den Kurznamen (z. B. github-main) — nie das Passwort. Eingesetzt wird es direkt beim Dienst.',
    'Bitwarden/Vaultwarden: einmal „bw login“ und „bw unlock“ auf diesem Rechner, BW_SESSION bleibt beim Dienst. 1Password: „op signin“ oder ein Service-Konto.',
    'Passwörter ändern machst du selbst im Passwortmanager; ich nutze danach automatisch den neuen Wert.',
])

export function registerZugaengeApi(app: Express, options: ZugaengeApiOptions): void {
    const route = (handler: (req: Request) => Promise<{ status?: number; body: unknown }>) => async (req: Request, res: Response) => {
        if (!options.ownerOnly(req, res)) return
        res.setHeader('Cache-Control', 'no-store')
        try {
            const result = await handler(req)
            res.status(result.status || 200).json(result.body)
        } catch {
            res.status(500).json({ error: 'Das hat nicht geklappt.' })
        }
    }
    const pve = options.proxmox || {}
    const tresor = options.tresor || {}
    const tresorView = () => ({ eintraege: zugaengeSicht(tresor), hinweise: TRESOR_HINWEISE })

    app.get('/api/desktop/proxmox', route(async () => ({ body: await proxmoxAnsicht(pve) })))
    app.post('/api/desktop/proxmox', route(async req => {
        const result = await speichereProxmoxZugang({ adresse: req.body?.adresse, token: req.body?.token }, pve)
        return { status: result.ok ? 200 : 400, body: { ...result, proxmox: await proxmoxAnsicht(pve) } }
    }))
    app.post('/api/desktop/proxmox/pruefen', route(async () => ({ body: await pruefeProxmox(pve) })))
    app.delete('/api/desktop/proxmox', route(async () => {
        clearProxmoxApp(pve)
        return { body: { ok: true, proxmox: await proxmoxAnsicht(pve) } }
    }))

    app.get('/api/desktop/tresor', route(async () => ({ body: tresorView() })))
    app.post('/api/desktop/tresor', route(async req => {
        const body = req.body && typeof req.body === 'object' ? req.body : {}
        const result = speichereEintrag({ id: body.id, label: body.label, quelle: body.quelle, ref: body.ref, refBenutzer: body.refBenutzer, dienste: body.dienste, benutzer: body.benutzer, geheim: body.geheim }, tresor)
        if (result.ok === false) return { status: 400, body: { ok: false, feld: result.feld, meldung: result.meldung } }
        return { body: { ok: true, ...tresorView() } }
    }))
    app.delete('/api/desktop/tresor/:id', route(async req => {
        const removed = entferneEintrag(String(req.params.id || ''), tresor)
        return { status: removed ? 200 : 404, body: { ok: removed, ...tresorView() } }
    }))
}
