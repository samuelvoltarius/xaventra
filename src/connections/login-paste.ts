/**
 * 2.86 Paket N (Live-Befund 06.10. 16:31): der Owner schickt die
 * Rückkehr-Adresse der Anmeldung (`…/verbindungen/rueckkehr?state=…&code=…`)
 * in den Chat — z. B. weil sein Browser die Rückkehr-Seite nicht erreicht.
 *
 * Die Nachricht wird VOR jedem Protokoll, jeder Sitzung und jedem Modell
 * erkannt und schließt die Anmeldung über den bestehenden Weg ab
 * (`completeLoginAndConnect`: `state` einmalig, an die Anmeldung gebunden,
 * 15 Minuten gültig). Der Code erscheint nirgends: nicht im Modell, nicht im
 * Sitzungsprotokoll, nicht im Ledger, nicht im Log, nicht in der Antwort.
 */
import { RETURN_PATH } from './connector-login.js'

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g

/** Die Rückkehr-Adresse in einer Nachricht (nur mit gültig geformtem `state` und `code`/`error`), sonst null. */
export function loginReturnInMessage(text: unknown): string | null {
    const value = String(text ?? '')
    if (!value.includes(RETURN_PATH) || value.length > 4000) return null
    for (const match of value.match(URL_IN_TEXT) || []) {
        try {
            const url = new URL(match.replace(/[).,;!?]+$/, ''))
            if (url.pathname !== RETURN_PATH) continue
            if (!/^[a-f0-9]{48}$/.test(url.searchParams.get('state') || '')) continue
            if (!url.searchParams.get('code') && !url.searchParams.get('error')) continue
            return url.toString()
        } catch { /* not a URL */ }
    }
    return null
}

/** Schließt die Anmeldung ab und antwortet in einem Alltagssatz (ohne Code, ohne Adresse). */
export async function handlePastedLoginReturn(address: string, deps: { complete?: (address: string) => Promise<{ ok: boolean; message: string }> } = {}): Promise<string> {
    const complete = deps.complete || (async (value: string) => {
        const { completeLoginAndConnect } = await import('./connect-flow.js')
        return completeLoginAndConnect({ address: value })
    })
    let result: { ok: boolean; message: string }
    try { result = await complete(address) } catch { result = { ok: false, message: '' } }
    const { ownerText } = await import('../core/owner-text.js')
    const text = ownerText(String(result.message || '').replace(URL_IN_TEXT, '')).slice(0, 400)
    return result.ok
        ? `✅ Angemeldet. ${text}`.trim()
        : `Diese Anmeldung konnte ich nicht abschließen${text ? `: ${text}` : '.'} Wenn sie älter als eine Viertelstunde ist, bitte einfach nochmal auf „Bei Home Assistant anmelden“ drücken.`
}
