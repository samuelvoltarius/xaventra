/**
 * 2.86 Paket M „Geführt“ — Telegram-Seite der geführten Wege.
 *
 * Buttons carry `gf:<16 hex>` (19 bytes) and no parameters; the server
 * resolves what a token means (like `ac:` cards and `nv:` navigation):
 * - only the owner (numeric id in allowFrom) may press, bound to its chat,
 *   valid 7 days, bounded store (`guided/knoepfe.json`);
 * - a guided button never switches or changes anything by itself. It may
 *   (a) send a fixed sentence as a normal owner request (example sentences,
 *   tips) — the request then goes the usual way (switching → card),
 *   (b) open an EXISTING question (connect card) or redeliver an open one,
 *   (c) show a read-only view (checklist, „Ich komm nicht weiter“),
 *   (d) store the owner's „Nein danke“ / „Nicht nötig“.
 *
 * The guided tick (card loop on the Main, every minute) keeps the pinned
 * status message current (edited, not resent), sends the three example
 * sentences after a new connection and at most one tip per day.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { isCardOwner } from '../core/approval-cards.js'
import { dataDirOf, loadGuidedState, nowOf, updateGuidedState, type GuidedOptions } from './guided-store.js'
import type { Checklist } from './setup-checklist.js'
import type { HilfeAntwort } from './stuck-helper.js'
import { ampelIcon } from './ampel.js'
import { zonedDay, zonedParts } from '../planner/time.js'

export const GUIDED_PREFIX = 'gf:'
const TOKEN = /^[a-f0-9]{16}$/
const TTL_MS = 7 * 24 * 60 * 60_000
const MAX_TOKENS = 800

export type Keyboard = Array<Array<{ text: string; callback_data: string }>>
export type GuidedAktion =
    | { art: 'satz'; text: string }
    | { art: 'einrichten'; key: string }
    | { art: 'ueberspringen'; key: string }
    | { art: 'einrichtung' }
    | { art: 'hilfe' }
    | { art: 'tipp-nein'; id: string }
    | { art: 'tipp-alle-aus' }
    | { art: 'frage-zeigen'; cardId: string }
    | { art: 'app'; bereich: string }

interface TokenEntry { token: string; chatId: string; createdAt: number; aktion: GuidedAktion }
const file = (opts: GuidedOptions) => join(dataDirOf(opts), 'guided', 'knoepfe.json')

function loadTokens(opts: GuidedOptions): TokenEntry[] {
    try { const raw = JSON.parse(readFileSync(file(opts), 'utf8')); return Array.isArray(raw?.tokens) ? raw.tokens : [] } catch { return [] }
}
function saveTokens(tokens: TokenEntry[], opts: GuidedOptions): void {
    const now = nowOf(opts)
    mkdirSync(join(dataDirOf(opts), 'guided'), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(file(opts), { version: 1, tokens: tokens.filter(item => now - item.createdAt <= TTL_MS).slice(-MAX_TOKENS) })
}

/** One guided button (owner only, bound to `chatId`). */
export function guidedButton(chatId: string, text: string, aktion: GuidedAktion, opts: GuidedOptions = {}): { text: string; callback_data: string } {
    const tokens = loadTokens(opts)
    const token = randomBytes(8).toString('hex')
    tokens.push({ token, chatId: String(chatId), createdAt: nowOf(opts), aktion })
    saveTokens(tokens, opts)
    return { text: String(text).slice(0, 60), callback_data: `${GUIDED_PREFIX}${token}` }
}

export interface GuidedPress { ok: boolean; message?: string; aktion?: GuidedAktion }

export function pressGuided(data: string, presser: { userId: string; ownerIds: readonly string[]; chatId: string }, opts: GuidedOptions = {}): GuidedPress {
    const raw = String(data ?? '')
    const token = raw.startsWith(GUIDED_PREFIX) ? raw.slice(GUIDED_PREFIX.length) : ''
    if (!TOKEN.test(token)) return { ok: false, message: 'Unbekannter Knopf.' }
    if (!isCardOwner(presser?.userId, presser?.ownerIds || [])) return { ok: false, message: '🔒 Nur der Owner.' }
    const entry = loadTokens(opts).find(item => item.token === token)
    if (!entry || nowOf(opts) - entry.createdAt > TTL_MS) return { ok: false, message: 'Knopf abgelaufen – bitte Menü neu öffnen.' }
    if (String(presser.chatId) !== entry.chatId) return { ok: false, message: '🔒 Dieser Knopf gehört zu einem anderen Chat.' }
    return { ok: true, aktion: entry.aktion }
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

/** Checklist as one short message, one button per open item (+ „✖“ = nicht nötig). */
export function checklistView(chatId: string, list: Checklist, opts: GuidedOptions = {}): { text: string; keyboard: Keyboard } {
    if (list.fertig) return { text: `✅ Alles eingerichtet (${list.kopf}).`, keyboard: [] }
    const lines = [`🧭 Einrichtung: ${list.kopf}`]
    for (const item of list.punkte.slice(0, 12)) lines.push(`${item.erledigt ? '✓' : '▢'} ${item.titel}`)
    if (list.punkte.length > 12) lines.push(`… und ${list.punkte.length - 12} weitere`)
    lines.push('', list.offen[0].satz)
    const keyboard: Keyboard = list.offen.slice(0, 5).map(item => {
        const knopf = item.knopf!
        const aktion: GuidedAktion = knopf.aktion.art === 'verbinden' ? { art: 'einrichten', key: knopf.aktion.key } : { art: 'app', bereich: knopf.aktion.bereich }
        return [guidedButton(chatId, `${knopf.label}: ${item.titel.replace(/ verbinden$/, '')}`.slice(0, 40), aktion, opts), guidedButton(chatId, '✖', { art: 'ueberspringen', key: item.key }, opts)]
    })
    return { text: lines.join('\n').slice(0, 600), keyboard }
}

/** „Ich komm nicht weiter“ as one message: one sentence + at most one button. */
export function hilfeView(chatId: string, antwort: HilfeAntwort, opts: GuidedOptions = {}): { text: string; keyboard: Keyboard } {
    const text = `💡 ${antwort.satz}`
    if (!antwort.knopf) return { text, keyboard: [] }
    const a = antwort.knopf.aktion
    const aktion: GuidedAktion = a.art === 'verbinden' ? { art: 'einrichten', key: a.key } : a.art === 'frage-zeigen' ? { art: 'frage-zeigen', cardId: a.cardId } : a.art === 'nochmal' ? { art: 'hilfe' } : { art: 'app', bereich: a.bereich }
    return { text, keyboard: [[guidedButton(chatId, antwort.knopf.label, aktion, opts)]] }
}

/** Three example sentences, one button each. */
export function beispielView(chatId: string, kopf: string, saetze: readonly string[], opts: GuidedOptions = {}): { text: string; keyboard: Keyboard } {
    return { text: kopf, keyboard: saetze.slice(0, 3).map(satz => [guidedButton(chatId, satz, { art: 'satz', text: satz }, opts)]) }
}

export function tippView(chatId: string, tipp: { id: string; text: string; knopf: { label: string; satz: string } }, opts: GuidedOptions = {}): { text: string; keyboard: Keyboard } {
    return {
        text: `💡 ${tipp.text}`,
        keyboard: [
            [guidedButton(chatId, tipp.knopf.label, { art: 'satz', text: tipp.knopf.satz }, opts), guidedButton(chatId, 'Nein danke', { art: 'tipp-nein', id: tipp.id }, opts)],
            // 2.89.4: global off switch.
            [guidedButton(chatId, 'Tipps aus', { art: 'tipp-alle-aus' }, opts)],
        ],
    }
}

/** Extra row under the fixed main menu (Paket L): „Einrichtung“ · „Ich komm nicht weiter“. */
export function guidedMenuRow(chatId: string, opts: GuidedOptions = {}): Keyboard {
    return [[guidedButton(chatId, '🧭 Einrichtung', { art: 'einrichtung' }, opts), guidedButton(chatId, '🆘 Ich komm nicht weiter', { art: 'hilfe' }, opts)]]
}

// ---------------------------------------------------------------------------
// pinned status message
// ---------------------------------------------------------------------------

export interface PinnedFacts { kritisch: number; einrichtung: Pick<Checklist, 'fertig' | 'kopf'> | null; frage: { titel: string } | null; wartend: number }

export function pinnedText(facts: PinnedFacts, now: number, timeZone = 'Europe/Vienna'): { text: string; signatur: string; einrichtungOffen: boolean } {
    const ampel = facts.kritisch > 0 ? 'rot' : facts.frage ? 'gelb' : 'gruen'
    const head = facts.kritisch > 0 ? `${ampelIcon('rot')} ${facts.kritisch === 1 ? 'Ein Problem braucht' : `${facts.kritisch} Probleme brauchen`} dich.` : `${ampelIcon(ampel)} Alles läuft.`
    const lines = [head]
    const offen = Boolean(facts.einrichtung && !facts.einrichtung.fertig)
    if (offen) lines.push(`🧭 Einrichtung: ${facts.einrichtung!.kopf}`)
    lines.push(facts.frage ? `Braucht dich: „${String(facts.frage.titel).slice(0, 80)}“${facts.wartend ? ` (danach ${facts.wartend} weitere)` : ''}` : 'Braucht dich: gerade nichts.')
    const day = zonedDay(now, timeZone)
    const parts = zonedParts(now, timeZone)
    const clock = `${String(parts.h).padStart(2, '0')}:${String(parts.mi).padStart(2, '0')}`
    const signatur = createHash('sha256').update(JSON.stringify([lines, day, offen])).digest('hex').slice(0, 24)
    return { text: [...lines, `Stand ${clock}`].join('\n'), signatur, einrichtungOffen: offen }
}

export interface GuidedTelegram {
    canSend(): Promise<boolean> | boolean
    ownerChatIds(): string[]
    send(chatId: string, text: string, keyboard: Keyboard): Promise<number | null>
    edit(chatId: string, messageId: number, text: string, keyboard: Keyboard): Promise<void>
    /** Pin a message silently (Telegram pinChatMessage). */
    pin?(chatId: string, messageId: number): Promise<void>
}

/** Sends/pins the status message once per chat, then only edits it when something changed. */
export async function updatePinnedStatus(tg: GuidedTelegram, facts: PinnedFacts, opts: GuidedOptions & { timeZone?: string } = {}): Promise<number> {
    const now = nowOf(opts)
    const composed = pinnedText(facts, now, opts.timeZone)
    const state = loadGuidedState(opts)
    let changed = 0
    for (const chatId of tg.ownerChatIds().filter(id => /^\d{1,20}$/.test(id)).slice(0, 3)) {
        const known = state.angeheftet.find(item => item.chatId === chatId)
        if (known && known.signatur === composed.signatur) continue
        const keyboard: Keyboard = [[...(composed.einrichtungOffen ? [guidedButton(chatId, '🧭 Weiter einrichten', { art: 'einrichtung' }, opts)] : []), guidedButton(chatId, '🆘 Ich komm nicht weiter', { art: 'hilfe' }, opts)]]
        let messageId = known?.messageId
        if (messageId !== undefined) {
            try { await tg.edit(chatId, messageId, composed.text, keyboard) } catch { messageId = undefined }
        }
        if (messageId === undefined) {
            const sent = await tg.send(chatId, composed.text, keyboard)
            if (typeof sent !== 'number') continue
            messageId = sent
            try { await tg.pin?.(chatId, sent) } catch { /* pinning is cosmetic */ }
        }
        updateGuidedState(next => {
            next.angeheftet = [...next.angeheftet.filter(item => item.chatId !== chatId), { chatId, messageId: messageId!, signatur: composed.signatur, at: new Date(now).toISOString() }].slice(-5)
        }, opts)
        changed++
    }
    return changed
}
