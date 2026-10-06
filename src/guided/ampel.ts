/**
 * 2.86 Paket M „Geführt“ — Übersichtlichkeit:
 * - „Heute“ als Cockpit mit 4 Ampel-Kacheln (Läuft alles? · Braucht dich ·
 *   Was sie heute getan hat · Was sie gelernt hat); alles andere per Klick.
 * - Kopf jeder Systemnachricht: Ampel + ein Satz.
 * Pure functions; the data comes from the existing views (desktop-views
 * `collectHeute`, planner report preview, question-queue).
 */

export type Ampel = 'gruen' | 'gelb' | 'rot'
export interface Kachel {
    id: 'laeuft' | 'braucht' | 'getan' | 'gelernt'
    titel: string
    ampel: Ampel
    /** One sentence. */
    satz: string
    /** At most three short lines behind the sentence. */
    zeilen: string[]
    /** Open question shown in „Braucht dich“ (card id for the app's answer buttons). */
    karteId?: string
}

export interface CockpitEingang {
    /** Open urgent things (urgent thoughts). */
    kritisch: number
    /** Connections whose login expired or failed. */
    verbindungFehler: number
    /** Sources of the view that could not be read. */
    probleme: number
    /** The one visible/next question (queue order). */
    frage: { id: string; titel: string } | null
    /** Questions waiting behind it. */
    wartend: number
    getan: string[]
    gelernt: string[]
}

const plural = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`

export function buildCockpit(input: CockpitEingang): Kachel[] {
    const kritisch = Math.max(0, Math.floor(Number(input.kritisch) || 0))
    const fehler = Math.max(0, Math.floor(Number(input.verbindungFehler) || 0))
    const wartend = Math.max(0, Math.floor(Number(input.wartend) || 0))
    const laeuft: Kachel = kritisch
        ? { id: 'laeuft', titel: 'Läuft alles?', ampel: 'rot', satz: `${plural(kritisch, 'Problem braucht', 'Probleme brauchen')} dich.`, zeilen: [] }
        : fehler || input.probleme
            ? { id: 'laeuft', titel: 'Läuft alles?', ampel: 'gelb', satz: fehler ? `Fast alles läuft; ${plural(fehler, 'Verbindung braucht', 'Verbindungen brauchen')} einen Blick.` : 'Fast alles läuft; ein Teil dieser Ansicht fehlt gerade.', zeilen: [] }
            : { id: 'laeuft', titel: 'Läuft alles?', ampel: 'gruen', satz: 'Alles läuft.', zeilen: [] }
    const braucht: Kachel = input.frage
        ? { id: 'braucht', titel: 'Braucht dich', ampel: 'gelb', satz: `„${String(input.frage.titel).slice(0, 90)}“`, zeilen: wartend ? [`Danach ${wartend === 1 ? 'wartet noch 1 Frage' : `warten noch ${wartend} Fragen`} – sie kommen einzeln.`] : [], karteId: input.frage.id }
        : { id: 'braucht', titel: 'Braucht dich', ampel: 'gruen', satz: 'Gerade nichts – ich melde mich, wenn ich dich brauche.', zeilen: [] }
    const getan: Kachel = { id: 'getan', titel: 'Was sie heute getan hat', ampel: 'gruen', satz: input.getan.length ? `${plural(input.getan.length, 'Sache', 'Sachen')} erledigt.` : 'Heute noch nichts Größeres.', zeilen: input.getan.slice(0, 3) }
    const gelernt: Kachel = { id: 'gelernt', titel: 'Was sie gelernt hat', ampel: 'gruen', satz: input.gelernt.length ? `${plural(input.gelernt.length, 'neue Sache', 'neue Sachen')} gemerkt.` : 'Heute nichts Neues gemerkt.', zeilen: input.gelernt.slice(0, 3) }
    return [laeuft, braucht, getan, gelernt]
}

const GETAN = ['Erledigt', 'Selbst repariert', 'Installiert']
const GELERNT = ['Neu gemerkt', 'Selbst übernommen']

/** Lines for „getan“ / „gelernt“ from the report sections (Paket L `Briefing.sections`). */
export function cockpitZeilen(sections: ReadonlyArray<{ titel: string; zeilen: string[] }> | undefined): { getan: string[]; gelernt: string[] } {
    const pick = (titles: string[]) => (sections || []).filter(section => titles.includes(section.titel)).flatMap(section => section.zeilen).filter(Boolean)
    return { getan: pick(GETAN), gelernt: pick(GELERNT) }
}

const ICON: Record<Ampel, string> = { gruen: '🟢', gelb: '🟡', rot: '🔴' }
export const ampelIcon = (ampel: Ampel) => ICON[ampel]

/**
 * Head of the menu/status in Telegram: ONE question is for the owner now, the
 * rest comes after it (question-queue) — never „6 Fragen warten“.
 */
export function fragenKopf(input: { kritisch?: number; offen: number }): string {
    const kritisch = Math.max(0, Math.floor(Number(input.kritisch) || 0))
    const offen = Math.max(0, Math.floor(Number(input.offen) || 0))
    const frage = offen === 0 ? 'keine Frage offen' : offen === 1 ? '1 Frage für dich' : `1 Frage für dich, ${offen - 1} danach`
    if (kritisch > 0) return `🔴 ${kritisch === 1 ? '1 Problem braucht' : `${kritisch} Probleme brauchen`} dich — ${frage}`
    return `${offen ? '🟡' : '🟢'} Alles läuft — ${frage}`
}

/** Head of a system message (not reminders: they are the owner's own words). */
export function systemKopf(msg: { kind: string; urgency?: string }): string {
    if (msg.urgency === 'dringend') return '🔴 Das braucht dich jetzt.'
    if (msg.kind === 'job') return '🟢 Erledigt.'
    return '🟡 Zur Info – nichts eilt.'
}
