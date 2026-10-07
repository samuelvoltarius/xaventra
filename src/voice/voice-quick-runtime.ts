/**
 * 2.87 Paket P: echte Quellen für die Kurzantworten (alles lesend, lazy).
 * Getrennt von voice-quick.ts, damit die Logik ohne Laufzeit testbar bleibt.
 */
import type { VoiceQuickDeps } from './voice-quick.js'
import { cleanForSpeech } from './voice-call.js'
import { listApprovalCards } from '../core/approval-cards.js'

async function ownerTimeZone(): Promise<string | undefined> {
    try {
        const [{ getNovaState }, { parsePlannerSettings }] = await Promise.all([import('../core/nova-state.js'), import('../planner/runtime.js')])
        return parsePlannerSettings((getNovaState() as any)?.config?.autonomy).briefing.timeZone
    } catch { return undefined }
}

/** „Läuft alles?“ in einem Satz: Rechner im Mesh + wartende Karten. */
export async function spokenSystemStatus(): Promise<string> {
    const parts: string[] = ['Ja, ich laufe.']
    try {
        const { discoverNodes } = await import('../mesh/mesh-registry.js')
        const nodes = await discoverNodes({ activeOnly: true })
        if (nodes.length) {
            const offline = nodes.filter(node => node.status === 'offline')
            parts.push(`${nodes.length - offline.length} von ${nodes.length} Rechnern sind erreichbar.`)
            if (offline.length) parts.push(`Nicht erreichbar: ${offline.slice(0, 4).map(node => node.hostname || node.node_id).join(', ')}.`)
        }
    } catch { parts.push('Die Rechnerliste konnte ich gerade nicht lesen.') }
    try {
        const open = listApprovalCards({ status: 'offen' }).length
        if (open) parts.push(open === 1 ? 'Eine Karte wartet auf dich.' : `${open} Karten warten auf dich.`)
    } catch { /* Karten optional */ }
    return parts.join(' ')
}

/** Dieselben Owner-IDs wie die App beim Beantworten von Karten (desktop-api). */
/** 2.89: Telegram owner ids plus every confirmed owner account (owner-accounts.ts) — no Telegram needed. */
async function cardOwnerIds(): Promise<string[]> {
    const [{ cardOwnerIdentities }, { getNovaState }] = await Promise.all([import('../users/owner-accounts.js'), import('../core/nova-state.js')])
    let telegram: string[] = []
    try {
        const { getTelegramAdapter } = await import('../channels/telegram.js')
        telegram = getTelegramAdapter()?.getOwnerChatIds?.() || []
    } catch { /* Konfiguration als Rückfall */ }
    return [...new Set([...telegram, ...cardOwnerIdentities(getNovaState().config)])]
}

export async function productionQuickDeps(): Promise<VoiceQuickDeps> {
    const timeZone = await ownerTimeZone()
    return {
        now: () => new Date(),
        timeZone,
        status: spokenSystemStatus,
        // Nur wenn das vorhandene Wetter-Werkzeug eingerichtet ist; sonst normale Pipeline.
        weather: process.env.OPENWEATHER_API_KEY ? async () => {
            const { runAutomationAction } = await import('../planner/routines.js')
            const text = await runAutomationAction('wetter')
            return /Fehler|Kein API-Key/i.test(text) ? null : cleanForSpeech(text.replace(/•/g, ',').replace(/:\s*,/g, ':'))
        } : undefined,
        // lokale Datei, nur lesen; abgelaufene/beantwortete fehlen hier absichtlich
        openCards: () => listApprovalCards({ status: 'offen' }),
        answerCard: async (cardId, answer) => {
            const [{ ensureBuiltinCardExecutors }, { answerCardFromDesktop }] = await Promise.all([import('../core/approval-card-sources.js'), import('../desktop/desktop-views.js')])
            await ensureBuiltinCardExecutors()
            const result = await answerCardFromDesktop(cardId, answer, { ownerIds: await cardOwnerIds() })
            const body: any = result.body || {}
            return { ok: Boolean(body.ok), message: String(body.message || body.error || 'Das hat nicht geklappt — nichts geschaltet.') }
        },
    }
}
