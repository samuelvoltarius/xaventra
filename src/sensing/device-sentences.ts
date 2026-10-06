/**
 * 2.86 Paket N — Sätze verstehen (rein, ohne Geräte- oder Netzzugriff).
 *
 * Feste Muster, kein Modell: „Licht im Wohnzimmer aus“, „Jeden Abend um 23 Uhr
 * alles aus“. Eigenes Modul, damit die deterministische Erkennung im Chat
 * (core/deterministic-query.ts) leicht bleibt; das Auflösen auf Geräte liegt
 * in rooms.ts, die Routinen-Ablage in device-routines.ts.
 */

/** Bekannte Räume (Anzeigeform). Längere zuerst, damit „Badezimmer“ vor „Bad“ trifft. */
export const RAEUME: readonly string[] = Object.freeze([
    'Hauswirtschaftsraum', 'Arbeitszimmer', 'Schlafzimmer', 'Kinderzimmer', 'Wohnzimmer', 'Gästezimmer', 'Badezimmer', 'Esszimmer',
    'Wintergarten', 'Treppenhaus', 'Speisekammer', 'Waschküche', 'Dachboden', 'Werkstatt', 'Toilette', 'Terrasse', 'Eingang',
    'Keller', 'Garage', 'Garten', 'Balkon', 'Küche', 'Diele', 'Flur', 'Büro', 'Gang', 'Bad', 'WC',
])

/** Kleinbuchstaben, Umlaute ausgeschrieben, nur Buchstaben/Ziffern/Leerzeichen. */
export function falte(value: unknown): string {
    return String(value ?? '').toLocaleLowerCase('de-DE').normalize('NFKC')
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

const RAUM_GEFALTET = RAEUME.map(raum => ({ raum, key: falte(raum) })).sort((a, b) => b.key.length - a.key.length)

/** Raum aus einem Namen: „Wohnzimmer Stehlampe“ → Wohnzimmer, „Küchenlicht“ → Küche. */
export function raumAusName(name: unknown): string | undefined {
    const text = falte(name)
    if (!text) return undefined
    for (const word of text.split(' ')) {
        for (const { raum, key } of RAUM_GEFALTET) {
            // ganzes Wort oder Wortanfang eines zusammengesetzten Worts („kuechenlicht“, „badlampe“)
            if (word === key) return raum
            if (key.length >= 4 && word.startsWith(key)) return raum
            if (key === 'kueche' && word.startsWith('kuechen')) return raum
        }
    }
    return undefined
}

/** Anzeigeform eines Raumnamens aus Hue/HA: bekannter Raum → Standardform, sonst bereinigt. */
export function raumName(raw: unknown): string | undefined {
    const text = String(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!text) return undefined
    const known = RAUM_GEFALTET.find(item => item.key === falte(text))
    return known ? known.raum : text
}

// ---------------------------------------------------------------------------
// Sätze verstehen (feste Muster, kein Modell)
// ---------------------------------------------------------------------------

export interface SchaltSatz {
    on: boolean
    was: 'licht' | 'schalter' | 'alles' | 'name'
    /** gefalteter Gerätename (nur bei was = 'name') */
    name?: string
    /** gefalteter Raumtext, wie gesagt */
    raum?: string
}

const AN_AUS = /^(.*?)\s+(an|ein|aus|einschalten|ausschalten|anschalten|anmachen|ausmachen|abschalten|ausknipsen)$/
const FRAGE_ANFANG = /^(?:ist|sind|war|waren|warum|wieso|weshalb|wer|wie|was|wann|wo|welche[rsn]?|ob|hast|hat|kannst du mir sagen)\b/
const FUELL = /\b(?:bitte|mal|doch|jetzt|sofort|gleich|du|kannst|koenntest|wuerdest|mach|mache|machst|schalt|schalte|schaltest|knips|das|die|den|der|dem|alle|saemtliche|ganze|ganzen|meine|meinen|mein)\b/g
const LICHT = /^(?:licht|lichter|lampe|lampen|beleuchtung|leuchte|leuchten)$/
const SCHALTER = /^(?:steckdose|steckdosen|schalter)$/
const ALLES = /^(?:alles|alle geraete|geraete|alles andere)$/
const RAUM_VOR = /\s*\b(?:im|in der|in dem|in|vom|von der|von dem|auf dem|auf der)\s+(.+)$/

/**
 * „Licht im Wohnzimmer aus“, „mach das Wohnzimmerlicht aus“, „alles aus“,
 * „schalte die Stehlampe ein“, „Steckdose Flur an“. Fragen und lange Sätze
 * werden nie als Schaltwunsch gelesen (null = kein fester Satz).
 */
export function parseSchaltSatz(input: unknown): SchaltSatz | null {
    const raw = String(input ?? '')
    if (!raw.trim() || raw.length > 120 || /\?/.test(raw)) return null
    const text = falte(raw)
    if (FRAGE_ANFANG.test(text)) return null
    const m = AN_AUS.exec(text)
    if (!m) return null
    const on = !/^(?:aus|ausschalten|ausmachen|abschalten|ausknipsen)$/.test(m[2])
    let body = m[1].replace(FUELL, ' ').replace(/\s+/g, ' ').trim()
    if (!body) return null
    let raum: string | undefined
    const r = RAUM_VOR.exec(body)
    if (r) { raum = r[1].trim(); body = body.slice(0, r.index).trim() }
    if (raum && raum.split(' ').length > 3) return null
    // „Wohnzimmerlicht“, „Kuechenlampe“: Raum vorne im Wort
    if (!raum) {
        const compound = /^([a-z]{2,30}?)(licht|lichter|lampe|lampen|beleuchtung)$/.exec(body)
        // nur ein bekannter Raum vorne zählt („Deckenlicht“ bleibt ein Gerätename)
        if (compound && raumAusName(compound[1])) { raum = compound[1]; body = compound[2] }
    }
    // „Licht Wohnzimmer aus“, „Steckdose Flur an“
    if (!raum) {
        const words = body.split(' ')
        if (words.length === 2 && (LICHT.test(words[0]) || SCHALTER.test(words[0]) || ALLES.test(words[0]))) { body = words[0]; raum = words[1] }
    }
    if (!body) body = 'alles'
    if (LICHT.test(body)) return { on, was: 'licht', ...(raum ? { raum } : {}) }
    if (SCHALTER.test(body)) return { on, was: 'schalter', ...(raum ? { raum } : {}) }
    if (ALLES.test(body)) return { on, was: 'alles', ...(raum ? { raum } : {}) }
    if (body.split(' ').length > 3 || body.length > 40) return null
    return { on, was: 'name', name: body, ...(raum ? { raum } : {}) }
}

export interface RoutineSatz { zeit: string; satz: SchaltSatz }

const ROUTINE = /^(?:bitte )?(?:(jeden|jede) (tag|abend|morgen|mittag|nachmittag|nacht)|(taeglich)|(immer)) um (\d{1,2})(?: (\d{2}))?(?: uhr)?(?: (\d{2}))? (.+)$/

/** „Jeden Abend um 23 Uhr alles aus“ → { zeit: '23:00', satz: { was: 'alles', on: false } }. */
export function parseRoutineSatz(input: unknown): RoutineSatz | null {
    const raw = String(input ?? '')
    if (!raw.trim() || raw.length > 160 || /\?/.test(raw)) return null
    const m = ROUTINE.exec(falte(raw))
    if (!m) return null
    const tageszeit = m[2] || ''
    let stunde = Number(m[5])
    const minute = Number(m[6] ?? m[7] ?? 0)
    if (!Number.isInteger(stunde) || !Number.isInteger(minute) || stunde > 23 || minute > 59) return null
    // „jeden Abend um 11“ = 23 Uhr, „jede Nacht um 11“ = 23 Uhr, „jeden Nachmittag um 3“ = 15 Uhr
    if ((tageszeit === 'abend' || tageszeit === 'nachmittag') && stunde >= 1 && stunde < 12) stunde += 12
    if (tageszeit === 'nacht' && stunde >= 6 && stunde < 12) stunde += 12
    const satz = parseSchaltSatz(m[8])
    if (!satz) return null
    return { zeit: `${String(stunde).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, satz }
}

