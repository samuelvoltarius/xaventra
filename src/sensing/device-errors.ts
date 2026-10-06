/**
 * 2.86 Paket N, Punkt 5 — Fehler als nächster Schritt statt Fehlermeldung.
 *
 * Bekannte Ursachen werden in EINEN Alltagssatz plus EIN Angebot übersetzt:
 *  - Gerät aus / nicht erreichbar → „… ist aus. Nochmal versuchen, wenn es wieder an ist? [Ja]“
 *    (Ja = ein Planer-Wächter wartet auf „wieder erreichbar“ und versucht es GENAU einmal)
 *  - Zeitüberschreitung → „… hat zu lange nicht geantwortet. Nochmal versuchen, sobald es antwortet? [Ja]“
 *  - Anmeldung abgelaufen/fehlt → „… lässt mich nicht mehr hinein. Einmal neu verbinden? [Ja]“
 * Unbekannte Ursachen werden ehrlich gesagt und NICHT wiederholt.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type FehlerUrsache = 'aus' | 'zeit' | 'anmeldung' | 'unbekannt'
export type FehlerAngebot = 'wenn-erreichbar' | 'neu-verbinden' | null

const AUS = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|fetch failed|not currently reachable|nicht erreichbar|unreachable|offline|Identity not verified|Outside own LAN/i
const ZEIT = /ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|timeout|zeitüberschreitung|zeitlimit|aborted|AbortError|TimeoutError/i
const ANMELDUNG = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|Missing private|Invalid Hue function\/access|access[- ]required|anmeldung|login|expired token|token expired|link button not pressed/i

function texte(error: unknown, tiefe = 0): string {
    if (error == null || tiefe > 3) return ''
    if (typeof error === 'string') return error
    const e = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; status?: unknown }
    return [e.name, e.code, e.status, e.message, texte(e.cause, tiefe + 1)].filter(item => item !== undefined && item !== null && item !== '').map(String).join(' ')
}

/** Ursache aus einem Fehler (auch verschachtelt in `cause`). */
export function fehlerUrsache(error: unknown): FehlerUrsache {
    const text = texte(error)
    if (!text) return 'unbekannt'
    if (ANMELDUNG.test(text)) return 'anmeldung'
    if (ZEIT.test(text)) return 'zeit'
    if (AUS.test(text)) return 'aus'
    return 'unbekannt'
}

/**
 * Ursache aus dem gespeicherten Gerätebestand, wenn der Schaltweg gar nicht
 * erst vorbereitet werden konnte (Gerät meldet sich nicht / Zugang fehlt /
 * diese Lampe ist am Schalter aus).
 */
export function bestandsUrsache(dataDir: string, deviceId: string, functionId: string): FehlerUrsache {
    try {
        const rows = JSON.parse(readFileSync(join(dataDir, 'sensing', 'direct-inventory.json'), 'utf8'))?.devices
        const row = Array.isArray(rows) ? rows.find((r: any) => r?.deviceId === deviceId) : null
        if (!row) return 'unbekannt'
        if (row.status === 'unavailable') return 'aus'
        if (row.status === 'access-required' || row.status === 'pairing') return 'anmeldung'
        const f = Array.isArray(row.functions) ? row.functions.find((item: any) => item?.id === functionId) : null
        if (f && f.available === false) return 'aus'
    } catch { /* kein Bestand */ }
    return 'unbekannt'
}

/** Ein Satz + ein Angebot. `name` ist die Alltagsanzeige („Stehlampe im Wohnzimmer“). */
export function naechsterSchritt(ursache: FehlerUrsache, name: string): { satz: string; angebot: FehlerAngebot; knopf?: string } {
    const n = String(name || 'das Gerät').trim()
    if (ursache === 'aus') return { satz: `Hat nicht geklappt, ${n} ist aus oder gerade nicht erreichbar. Nochmal versuchen, wenn es wieder an ist?`, angebot: 'wenn-erreichbar', knopf: 'Ja, wenn es an ist' }
    if (ursache === 'zeit') return { satz: `Hat nicht geklappt, ${n} hat zu lange nicht geantwortet. Nochmal versuchen, sobald es antwortet?`, angebot: 'wenn-erreichbar', knopf: 'Ja, nochmal' }
    if (ursache === 'anmeldung') return { satz: `Hat nicht geklappt, ${n} lässt mich nicht mehr hinein. Einmal neu verbinden?`, angebot: 'neu-verbinden', knopf: 'Neu verbinden' }
    return { satz: `Hat nicht geklappt bei ${n}. Den Grund kenne ich nicht; ich versuche es nicht von selbst nochmal. Schau bitte kurz, ob es an ist.`, angebot: null }
}
