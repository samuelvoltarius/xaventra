/**
 * 2.85 Paket D — Werkzeugkasten for Xaventra Desktop (owner only, see desktop-api.ts).
 *
 * Read: the toolbox read model (src/install/toolbox.ts), every free-form field
 * shortened and redacted like the other Desktop views. Write: only the two
 * toolbox actions, which create a proposal and offer a card; the decision is the
 * card answer (answerCardFromDesktop / Telegram), never this module.
 */
import { clean, publicCard, type DesktopCard } from './desktop-views.js'
import type { Toolbox } from '../install/toolbox.js'

export async function collectWerkzeugkasten(): Promise<Toolbox & { probleme: string[] }> {
    const { collectToolbox } = await import('../install/toolbox.js')
    const toolbox = await collectToolbox()
    return {
        generatedAt: toolbox.generatedAt,
        knoten: toolbox.knoten.map(node => ({ id: clean(node.id, 80), bewertet: node.bewertet })),
        hinweis: clean(toolbox.hinweis, 300),
        gruppen: toolbox.gruppen.map(group => ({
            faehigkeit: group.faehigkeit, titel: clean(group.titel, 80),
            eintraege: group.eintraege.map(item => ({
                ...item, name: clean(item.name, 120), nutzen: clean(item.nutzen, 160), detail: clean(item.detail, 300),
                statusText: clean(item.statusText, 240), knoten: item.knoten ? clean(item.knoten, 80) : null,
                bedarf: item.bedarf.slice(0, 4).map(text => clean(text, 160)), hinweis: clean(item.hinweis, 240),
                aktualitaet: { ...item.aktualitaet, text: clean(item.aktualitaet.text, 240) },
            })),
        })),
        probleme: [],
    }
}

export interface WerkzeugkastenAntwort { ok: boolean; message: string; karte: DesktopCard | null }

export async function werkzeugkastenInstallieren(katalogId: string): Promise<WerkzeugkastenAntwort> {
    const { defaultToolboxActionDeps, requestToolboxInstall } = await import('../install/toolbox-actions.js')
    const result = await requestToolboxInstall(katalogId, await defaultToolboxActionDeps())
    return { ok: result.ok, message: clean(result.message, 400), karte: result.card ? publicCard(result.card) : null }
}

export async function werkzeugkastenEntfernen(queueId: string): Promise<WerkzeugkastenAntwort> {
    const { defaultToolboxActionDeps, requestToolboxRemoval } = await import('../install/toolbox-actions.js')
    const result = await requestToolboxRemoval(queueId, await defaultToolboxActionDeps())
    return { ok: result.ok, message: clean(result.message, 400), karte: result.card ? publicCard(result.card) : null }
}
