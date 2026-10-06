/**
 * 2.88 Passwort-Tresor: the owner's release per entry AND service is a card.
 *
 * A tool/the model can only ASK („GitHub-Zugang auch für gitlab.example.com
 * nutzen?“). The Ja adds exactly this service to exactly this entry; the value
 * itself never appears on the card. Impact `extern` (a secret goes to a
 * service), never „Immer erlauben“. Changing a password has no card at all
 * (Nie-Liste „Zugangsdaten ändern“).
 */
import {
    createApprovalCard, getCardExecutor, registerCardExecutor, type CardExecutor, type CardStoreOptions,
} from '../core/approval-cards.js'
import { dienstPasst, dienstVon, gibFrei, listeEintraege, type TresorDeps } from './credential-broker.js'

export const FREIGABE_KIND = 'tresor-freigabe'
const REF = /^([a-z0-9][a-z0-9-]{1,39})@([a-z0-9.-]{1,200}(?::\d{1,5})?)$/

export interface TresorCardDeps extends TresorDeps { cardOpts?: CardStoreOptions }

export function createFreigabeExecutor(deps: TresorCardDeps = {}): CardExecutor {
    return {
        kind: FREIGABE_KIND,
        impact: 'extern',
        allowAlways: () => false,
        async execute(card) {
            const match = REF.exec(String(card.aktion.ref || ''))
            if (card.aktion.kind !== FREIGABE_KIND || !match) return { ok: false, message: 'Ungültige Karten-Referenz — nichts freigegeben.' }
            const eintrag = listeEintraege(deps).find(item => item.id === match[1])
            if (!eintrag) return { ok: false, message: 'Diesen Zugang gibt es nicht mehr — nichts freigegeben.' }
            return gibFrei(match[1], match[2], deps)
                ? { ok: true, message: `„${eintrag.label}“ darf jetzt bei ${match[2]} eingesetzt werden. Das Passwort selbst sehe ich nicht.` }
                : { ok: false, message: 'Freigabe nicht gespeichert.' }
        },
        async reject() { return { ok: true, message: 'Nicht freigegeben; der Zugang bleibt nur für die bisherigen Dienste.' } },
    }
}

export function registerFreigabeExecutor(deps: TresorCardDeps = {}, options: { force?: boolean } = {}): void {
    if (!options.force && getCardExecutor(FREIGABE_KIND) && !deps.cardOpts) return
    registerCardExecutor(createFreigabeExecutor(deps))
}

/** Ask the owner to release entry `id` for the service of `ziel`. One card, nothing changes before the Ja. */
export async function freigabeAnfragen(id: string, ziel: string, deps: TresorCardDeps = {}): Promise<{ ok: boolean; message: string; cardId?: string }> {
    const eintrag = listeEintraege(deps).find(item => item.id === id)
    if (!eintrag) return { ok: false, message: `Den Zugang „${String(id).slice(0, 40)}“ gibt es im Tresor nicht.` }
    const dienst = dienstVon(ziel)
    if (!dienst) return { ok: false, message: 'Ungültiger Dienst (Adresse wie https://example.com).' }
    if (dienstPasst(eintrag.dienste, dienst)) return { ok: true, message: `„${eintrag.label}“ ist für ${dienst} schon freigegeben.` }
    registerFreigabeExecutor(deps)
    const card = createApprovalCard({
        art: 'tresor', titel: `„${eintrag.label}“ auch für ${dienst} nutzen?`,
        beleg: `Zugang „${eintrag.label}“ (${eintrag.quelle === 'datei' ? 'gespeichert hier' : eintrag.quelle === 'bitwarden' ? 'aus Bitwarden' : 'aus 1Password'}) ist bisher nur für ${eintrag.dienste.join(', ')} freigegeben. Ich setze ihn dann direkt bei ${dienst} ein; das Passwort sehe ich nie.`,
        vorschlag: `Ja = „${eintrag.label}“ darf bei ${dienst} eingesetzt werden. Nein = nichts.`,
        aktion: { kind: FREIGABE_KIND, ref: `${eintrag.id}@${dienst}` }, wirkung: 'extern', ablaufMs: 24 * 60 * 60_000,
        dedupeKey: `tresor:${eintrag.id}@${dienst}`, quelle: 'tresor',
    }, deps.cardOpts)
    if (card.ok === false) return { ok: false, message: `Keine Karte: ${card.reason}` }
    return { ok: true, cardId: card.card.id, message: card.created ? `Karte „${eintrag.label} für ${dienst}?“ erstellt — eingesetzt wird erst nach deinem Ja.` : 'Die Karte liegt schon offen.' }
}
