/**
 * 2.86 Paket M „Geführt“, Punkt 3 — nach jedem neuen Gerät/Dienst drei
 * Beispielsätze als antippbare Knöpfe.
 *
 * - The sentences come from FIXED templates per type (never invented by a
 *   model) and are plain owner requests in everyday language.
 * - Tapping one sends it as a normal request (Telegram: as if typed; app:
 *   into the conversation). Reading answers come at once; anything that
 *   switches goes through the usual card — the sentence carries no rights.
 * - „Neu“ is derived from state: entries that are connected now and were not
 *   connected at the last look. The very first look only remembers (an
 *   existing installation is not flooded with examples).
 */
import { loadGuidedState, nowOf, updateGuidedState, type GuidedOptions, type OffeneBeispiele } from './guided-store.js'

export type BeispielTyp = 'homeassistant' | 'hue' | 'steckdose' | 'matter' | 'drucker' | 'kalender' | 'mail' | 'dokumente' | 'fotos' | 'ablaeufe' | 'ki' | 'suche' | 'tv' | 'allgemein'

export const BEISPIELSAETZE: Readonly<Record<Exclude<BeispielTyp, 'allgemein'>, readonly [string, string, string]>> = Object.freeze({
    homeassistant: ['Welche Lichter sind gerade an?', 'Mach das Wohnzimmerlicht aus', 'Wie warm ist es drinnen?'],
    hue: ['Welche Lampen sind gerade an?', 'Mach alle Lampen aus', 'Dimm das Licht im Wohnzimmer auf die Hälfte'],
    steckdose: ['Welche Steckdosen sind an?', 'Schalte die Steckdose aus', 'Wie viel Strom braucht die Steckdose gerade?'],
    matter: ['Welche Geräte kann ich schalten?', 'Ist die Steckdose an?', 'Schalte das Gerät im Flur aus'],
    drucker: ['Wie weit ist der Druck?', 'Wann ist der Drucker fertig?', 'Ist der Drucker gerade frei?'],
    kalender: ['Was steht heute an?', 'Habe ich morgen Termine?', 'Wann ist mein nächster Termin?'],
    mail: ['Habe ich neue wichtige Mails?', 'Fass meine Mails von heute zusammen', 'Wann kommt mein Paket?'],
    dokumente: ['Such meine letzte Stromrechnung', 'Welche Dokumente kamen diese Woche?', 'Finde den Mietvertrag'],
    fotos: ['Zeig mir Fotos vom letzten Urlaub', 'Wie viele Fotos habe ich diesen Monat gemacht?', 'Such Fotos mit dem Hund'],
    ablaeufe: ['Welche Abläufe gibt es?', 'Welcher Ablauf ist zuletzt gelaufen?', 'Starte den Ablauf für die Sicherung'],
    ki: ['Was kannst du alles?', 'Fass mir einen langen Text zusammen', 'Hilf mir, eine Mail zu schreiben'],
    suche: ['Wie wird das Wetter morgen?', 'Such mir ein Rezept für Gulasch', 'Was gibt es Neues heute?'],
    tv: ['Ist der Fernseher an?', 'Was läuft gerade im Fernsehen?', 'Mach den Fernseher leiser'],
})

/** Which template fits an entry of the „Verbindungen“ list. */
export function beispielTyp(entry: { id?: string; connectorId?: string; title?: string; kategorie?: string }): BeispielTyp {
    const text = `${entry.id || ''} ${entry.connectorId || ''} ${entry.title || ''}`.toLowerCase()
    if (/home[- ]?assistant|homeassistant/.test(text)) return 'homeassistant'
    if (/\bhue\b/.test(text)) return 'hue'
    if (/tuya|steckdose|shelly|plug/.test(text)) return 'steckdose'
    if (/matter/.test(text)) return 'matter'
    if (/moonraker|octoprint|prusalink|bambu|klipper|drucker|printer/.test(text)) return 'drucker'
    if (/calendar|kalender/.test(text)) return 'kalender'
    if (/gmail|imap|mail/.test(text)) return 'mail'
    if (/paperless|dokument/.test(text)) return 'dokumente'
    if (/immich|foto|photo/.test(text)) return 'fotos'
    if (/n8n|automation|ablauf/.test(text)) return 'ablaeufe'
    if (/searx|suche|search/.test(text)) return 'suche'
    if (/\btv\b|fernseh|jellyfin/.test(text)) return 'tv'
    if (entry.kategorie === 'ki-modelle' || /^llm:|ki-modelle:/.test(`${entry.connectorId || ''} ${entry.id || ''}`)) return 'ki'
    return 'allgemein'
}

export function beispielSaetze(entry: { id?: string; connectorId?: string; title?: string; kategorie?: string }): string[] {
    const typ = beispielTyp(entry)
    if (typ !== 'allgemein') return [...BEISPIELSAETZE[typ]]
    const name = String(entry.title || 'das Gerät').replace(/\s+/g, ' ').trim().slice(0, 40)
    return [`Was kannst du mit ${name} machen?`, `Was meldet ${name} gerade?`, `Ist bei ${name} alles in Ordnung?`]
}

/** Header line above the three buttons. */
export function beispielKopf(titel: string): string {
    return `✅ ${String(titel).slice(0, 60)} ist verbunden. Probier mal:`
}

export interface VerbundenerEintrag { id: string; title: string; connectorId?: string; kategorie?: string }
const keyOf = (entry: VerbundenerEintrag) => entry.connectorId ? `c:${entry.connectorId}` : `i:${entry.id}`

/**
 * Remembers what is connected and returns the entries that are NEW since the
 * last look, each with its three sentences. First look = remember only.
 */
export function noteConnected(entries: readonly VerbundenerEintrag[], opts: GuidedOptions = {}): OffeneBeispiele[] {
    const fresh: OffeneBeispiele[] = []
    const at = new Date(nowOf(opts)).toISOString()
    const state = loadGuidedState(opts)
    const keys = entries.map(keyOf)
    if (state.beispieleGesehen === null) {
        updateGuidedState(next => { next.beispieleGesehen = [...new Set(keys)] }, opts)
        return []
    }
    const seen = new Set(state.beispieleGesehen)
    for (const entry of entries) {
        const key = keyOf(entry)
        if (seen.has(key)) continue
        seen.add(key)
        fresh.push({ key, titel: String(entry.title).slice(0, 60), saetze: beispielSaetze(entry), at })
    }
    if (!fresh.length) return []
    updateGuidedState(next => {
        next.beispieleGesehen = [...seen].slice(-500)
        next.beispieleOffen = [...fresh, ...next.beispieleOffen.filter(item => !fresh.some(entry => entry.key === item.key))].slice(0, 10)
    }, opts)
    return fresh
}

/** Example sentences still offered (newest first, at most `limit`). */
export function offeneBeispiele(opts: GuidedOptions = {}, limit = 3): OffeneBeispiele[] {
    return loadGuidedState(opts).beispieleOffen.slice(0, limit)
}

export function markBeispieleGesendet(keys: readonly string[], opts: GuidedOptions = {}): void {
    updateGuidedState(state => { for (const item of state.beispieleOffen) if (keys.includes(item.key)) item.gesendet = true }, opts)
}

/** „Ausblenden“ in the app. */
export function hideBeispiele(key: string, opts: GuidedOptions = {}): void {
    updateGuidedState(state => { state.beispieleOffen = state.beispieleOffen.filter(item => item.key !== key) }, opts)
}

/** Connected entries from the „Verbindungen“ list (default source). */
export async function connectedEntries(opts: GuidedOptions = {}): Promise<VerbundenerEintrag[]> {
    const { listConnections } = await import('../connections/connections-view.js')
    return (await listConnections({ dataDir: opts.dataDir })).filter(entry => entry.status === 'verbunden')
        .map(entry => ({ id: entry.id, title: entry.title, ...(entry.connectorId ? { connectorId: entry.connectorId } : {}), kategorie: entry.kategorie }))
}
