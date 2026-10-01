/**
 * /desktop – Direktverbindung: daemon wiring (Main only, off by default).
 *
 * startDesktopDirect() does nothing unless `desktop.direct.enabled=true`, a
 * https publicBaseUrl and at least one desktop are configured, and never on a
 * worker (NOVA_NODE_ONLY=true). Without a started runtime /desktop answers
 * "aus" and no button, link or listener exists.
 */
import type { Server } from 'node:http'
import { parseDesktopDirectConfig, type DesktopDirectConfig } from './config.js'
import { createDesktopGateway } from './gateway.js'
import { DesktopDirectStore, MODE_TEXT, type DesktopStoreOptions, type PressResult } from './store.js'

interface Runtime { config: DesktopDirectConfig; store: DesktopDirectStore; server: Server | null; sweep: NodeJS.Timeout | null }
let runtime: Runtime | null = null

export interface StartResult { started: boolean; reason: string; address?: string }

export interface StartOptions extends DesktopStoreOptions {
    nodeOnly?: boolean
    /** false = do not open the listener (tests of the Telegram path). */
    listen?: boolean
    novncDir?: string | null
    log?: (line: string) => void
}

export async function startDesktopDirect(rawConfig: any, opts: StartOptions = {}): Promise<StartResult> {
    const nodeOnly = opts.nodeOnly ?? process.env.NOVA_NODE_ONLY === 'true'
    if (nodeOnly) return { started: false, reason: 'Worker (NOVA_NODE_ONLY) — Desktop-Direkt nur auf dem Main' }
    if (rawConfig?.desktop?.direct?.enabled !== true) return { started: false, reason: 'desktop.direct.enabled=false' }
    const { config, problems } = parseDesktopDirectConfig(rawConfig)
    if (!config.enabled) return { started: false, reason: `Konfiguration unvollständig: ${problems.join('; ').slice(0, 300)}` }
    await stopDesktopDirect()
    const store = new DesktopDirectStore(config, opts)
    let server: Server | null = null
    let address: string | undefined
    if (opts.listen !== false) {
        server = createDesktopGateway(config, store, { ...(opts.novncDir !== undefined ? { novncDir: opts.novncDir } : {}), ...(opts.log ? { log: opts.log } : {}) })
        await new Promise<void>((resolve, reject) => {
            server!.once('error', reject)
            server!.listen(config.port, config.host, () => { server!.off('error', reject); resolve() })
        })
        const bound = server.address()
        address = bound && typeof bound === 'object' ? `http://${bound.address.includes(':') ? `[${bound.address}]` : bound.address}:${bound.port}` : undefined
    }
    const sweep = setInterval(() => store.sweep(), 5_000)
    sweep.unref?.()
    runtime = { config, store, server, sweep }
    return { started: true, reason: `${config.desktops.length} Desktop(s)${problems.length ? `; übersprungen: ${problems.join('; ').slice(0, 200)}` : ''}`, ...(address ? { address } : {}) }
}

export async function stopDesktopDirect(): Promise<void> {
    const current = runtime
    runtime = null
    if (!current) return
    if (current.sweep) clearInterval(current.sweep)
    current.store.shutdown()
    if (current.server) await new Promise<void>(resolve => { current.server!.closeAllConnections?.(); current.server!.close(() => resolve()) })
}

export function isDesktopDirectActive(): boolean { return runtime !== null }
export function getDesktopDirectStore(): DesktopDirectStore | null { return runtime?.store ?? null }

export const DESKTOP_DIRECT_OFF_TEXT = '🖥 /desktop ist aus. Einschalten: desktop.direct.enabled=true mit publicBaseUrl und desktops (docs/DESKTOP_DIRECT.md).'

/** Picker for the slash command. null = runtime off. */
export function desktopPicker(ownerId: string): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } | null {
    return runtime ? runtime.store.createPicker(ownerId) : null
}

/** Text-only overview for channels without buttons (no links there). */
export function desktopOverviewText(): string {
    if (!runtime) return DESKTOP_DIRECT_OFF_TEXT
    const lines = ['🖥 Desktops (Direktverbindung):']
    for (const desktop of runtime.config.desktops) lines.push(`• ${desktop.label} (${desktop.id})${desktop.allowControl ? '' : ' — nur Ansehen'}`)
    const active = runtime.store.activeSessions()
    if (active.length) lines.push('', `Aktiv: ${active.map(session => `${session.desktop.id} (${MODE_TEXT[session.mode]})`).join(', ')}`)
    lines.push('', 'Einmal-Links gibt es nur über Telegram (/desktop).')
    return lines.join('\n')
}

export function pressDesktopButton(callbackData: string, presser: { userId: string; ownerIds: readonly string[] }): PressResult {
    if (!runtime) return { ok: false, code: 'aus', message: 'Desktop-Direktverbindung ist aus.' }
    return runtime.store.press(callbackData, presser)
}

/** Plain text for the link message. The URL is the only secret in it; never logged. */
export function formatLinkMessage(link: NonNullable<PressResult['link']>): string {
    const until = new Date(link.expiresAt).toISOString().slice(11, 16)
    const lines = [
        `🖥 ${link.desktop.label} — ${MODE_TEXT[link.mode]}`,
        link.url,
        `Einmal-Link, gültig bis ${until} UTC, nur im Tailnet. Kein Passwort nötig.`,
    ]
    if (link.mode === 'control') lines.push(link.desktop.agentInput
        ? 'Während du übernimmst, sind Xaventras eigene Desktop-Eingaben pausiert — bis „Zurückgeben“ oder Sitzungsende.'
        : 'Eingaben sind erlaubt. „Zurückgeben“ beendet die Sitzung.')
    else lines.push('Nur ansehen: Tastatur und Maus werden verworfen.')
    return lines.join('\n')
}
