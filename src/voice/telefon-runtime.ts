/**
 * 2.87 Paket P: Telefon im laufenden Main — starten, neu laden, stoppen.
 *
 * Wird beim Start des Dashboards und nach jeder Owner-Änderung aufgerufen.
 * Ohne fertige Owner-Konfiguration lauscht nichts (telefonBereit).
 */
import type { TelefonBridge } from './telefon-bridge.js'

type MessageHandler = (message: string, channel: string) => Promise<string>

let running: TelefonBridge | null = null
let resolver: (() => MessageHandler | null) | null = null
let chain: Promise<unknown> = Promise.resolve()

const ownerPrincipal = () => String(process.env.NOVA_DESKTOP_OWNER_ID || 'desktop-owner').trim().slice(0, 200)

/** Status für App/Telegram: lauscht die Brücke gerade? */
export function telefonLauscht(): boolean { return Boolean(running) }

async function apply(resolveHandler?: () => MessageHandler | null): Promise<boolean> {
    if (resolveHandler) resolver = resolveHandler
    if (running) { const old = running; running = null; await old.stop().catch(() => undefined) }
    const { readTelefonConfig, telefonBereit } = await import('./telefon-config.js')
    const config = readTelefonConfig()
    if (!telefonBereit(config)) return false
    const [{ startTelefonIfReady }, { discoverVoiceService }, { readVoicePrefs }, { createVoiceAnswerer }, { productionQuickDeps }, { pipelineAnswer }, { WebSocket }] = await Promise.all([
        import('./telefon-bridge.js'), import('./voice-mesh.js'), import('./voice-prefs.js'), import('./voice-quick.js'),
        import('./voice-quick-runtime.js'), import('../desktop/voice-api.js'), import('ws'),
    ])
    const quick = await productionQuickDeps()
    running = await startTelefonIfReady(config, {
        discover: discoverVoiceService,
        openUpstream: url => new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 }) as any,
        voice: readVoicePrefs().voice,
        log: line => console.log(line),
        answerFor: caller => createVoiceAnswerer({
            // Rufnummern lassen sich fälschen: Nutzerrechte, ein gesprochenes „ja“ gilt nicht.
            pipeline: pipelineAnswer({ principalId: ownerPrincipal(), clientId: 'telefon' }, () => resolver?.() || null, {
                authorizationUserId: `telefon:${caller}`, permission: 'user', roomTitle: 'Telefon', roomTopic: 'Anrufe über die Telefonanlage',
            }),
            quick,
            ownerAuthenticated: false,
        }),
    }).catch(error => {
        console.warn(`[Telefon] Start nicht möglich: ${String((error as Error)?.message || error).slice(0, 160)}`)
        return null
    })
    return Boolean(running)
}

/** Nacheinander, nie zwei Brücken gleichzeitig. */
export function applyTelefonConfig(resolveHandler?: () => MessageHandler | null): Promise<boolean> {
    const next = chain.then(() => apply(resolveHandler), () => apply(resolveHandler))
    chain = next.catch(() => undefined)
    return next
}

export async function stopTelefon(): Promise<void> {
    await chain.catch(() => undefined)
    if (running) { const old = running; running = null; await old.stop().catch(() => undefined) }
}
