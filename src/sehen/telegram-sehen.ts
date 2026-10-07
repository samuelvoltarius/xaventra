/**
 * 2.88 „Sehen und lenken“ kurz in Telegram: „Was ich gerade tue“ mit
 * Knöpfen Stopp / Später (`ak:`), dazu Regeln und Ihr Computer als Text.
 * Die Knöpfe tragen nur ein kurzes Einmal-Token (30 Minuten, an den Chat
 * gebunden); gedrückt werden darf nur vom Owner im Privatchat. Dahinter
 * läuft exakt steuereAktivitaet — derselbe Weg wie in der App.
 */
import { randomBytes } from 'node:crypto'
import type { AktivitaetQuellen, AktivitaetView } from './aktivitaet.js'

export const AK_PREFIX = 'ak:'
const TTL_MS = 30 * 60_000
const MAX_TOKENS = 200
const tokens = new Map<string, { id: string; aktion: 'stopp' | 'spaeter'; chatId: string; at: number }>()

const kurz = (text: string, max = 22) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Knöpfe für die ersten Einträge mit Stopp/Später (höchstens 5 Zeilen). */
export function aktivitaetKnoepfe(view: AktivitaetView, chatId: string, now = Date.now()): Array<Array<{ text: string; callback_data: string }>> {
    for (const [key, entry] of tokens) if (now - entry.at > TTL_MS) tokens.delete(key)
    const rows: Array<Array<{ text: string; callback_data: string }>> = []
    for (const item of view.eintraege.filter(entry => entry.aktionen.includes('stopp') || entry.aktionen.includes('spaeter')).slice(0, 5)) {
        const row: Array<{ text: string; callback_data: string }> = []
        for (const aktion of ['stopp', 'spaeter'] as const) {
            if (!item.aktionen.includes(aktion)) continue
            const token = randomBytes(6).toString('hex')
            tokens.set(token, { id: item.id, aktion, chatId: String(chatId), at: now })
            row.push({ text: aktion === 'stopp' ? `⏹ ${kurz(item.titel)}` : '⏰ Später', callback_data: `${AK_PREFIX}${token}` })
        }
        rows.push(row)
    }
    while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value as string)
    return rows
}

export interface AkPresser { userId: string; ownerIds: readonly string[]; chatId: string; privateChat: boolean }

/** Ein Druck auf `ak:<token>`. Nur Owner im eigenen Privatchat; jedes Token genau einmal. */
export async function drueckeAktivitaet(data: string, presser: AkPresser, quellen?: AktivitaetQuellen, now = Date.now()): Promise<{ ok: boolean; message: string }> {
    const token = String(data || '').startsWith(AK_PREFIX) ? String(data).slice(AK_PREFIX.length) : ''
    if (!/^[a-f0-9]{12}$/.test(token)) return { ok: false, message: 'Unbekannter Knopf.' }
    if (!presser.privateChat || presser.chatId !== presser.userId || !presser.ownerIds.includes(presser.userId)) return { ok: false, message: '🔒 Nur für den Owner im Privatchat.' }
    const entry = tokens.get(token)
    if (!entry || now - entry.at > TTL_MS || entry.chatId !== presser.chatId) return { ok: false, message: 'Knopf abgelaufen – schick /aktivitaet nochmal.' }
    tokens.delete(token)
    const { steuereAktivitaet } = await import('./aktivitaet.js')
    return steuereAktivitaet(entry.id, entry.aktion, { by: `telegram:${presser.userId}` }, quellen)
}

/** Test helper. */
export function _resetAkTokens(): void { tokens.clear() }
