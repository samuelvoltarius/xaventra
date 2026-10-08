/**
 * 2.89.3 (Gespraechstest): for small talk ("was machst du den ganzen Tag?", "Satz mit Sonne") and for questions about
 * what was said in this conversation ("wie hieß mein Hund?") the model used kg_search / nova_introspect first and
 * answered from an empty hit list. Those lookups are not part of the first offer for such turns.
 */
import { detectActionIntent } from './action-intent.js'

const LOOKUPS: ReadonlySet<string> = new Set(['kg_search', 'kg_remember', 'recall', 'nova_introspect', 'nova_capabilities'])
/** Asks about the system, its abilities or long-term memory - the lookups stay. */
const NEEDS_LOOKUP = /(?<![\p{L}])(?:kannst\s+du|k[öo]nntest\s+du|f[äa]hig|werkzeug\w*|tools?|status|l[äa]uft|knoten|nodes?|system|speicher|ged[äa]chtnis|merk\s+dir|vergiss|installier\w*|verbunden|version)(?![\p{L}])/iu
/** Words of real work (files, mail, calendar, search, devices ...): not small talk. */
const WORKISH = /(?<![\p{L}])(?:datei\w*|ordner|mail\w*|termin\w*|kalender|wetter|uhr|zeit|such\w*|recherch\w*|screenshot\w*|bild\w*|foto\w*|install\w*|server|node\w*|lampe\w*|licht|heiz\w*|paket\w*|erinner\w*|notiz\w*|aufgabe\w*|projekt\w*|mission\w*|musik|video\w*|schick\w*|send\w*|zeig\w*|öffne\w*|oeffne\w*|lies|schreib\w*|rechne\w*|berechne\w*|übersetz\w*)(?![\p{L}])/iu
/** About the running conversation: "wie hieß mein Hund", "was habe ich vorhin gesagt", "wie alt ist er". */
const RECALL = /(?<![\p{L}])(?:wie\s+hie(?:ß|ss)t\w*|wie\s+hie(?:ß|ss)\s+\w+|wie\s+alt\s+(?:ist|war)|was\s+hab(?:e)?\s+ich\b.{0,30}\b(?:gesagt|erz[äa]hlt|geschrieben)|vorhin|eben\s+(?:gesagt|erw[äa]hnt)|wie\s+war\s+(?:noch\s+)?(?:mein|dein|der|die|das)|wei(?:ß|ss)t\s+du\s+noch)(?![\p{L}])/iu

export function isSmallTalkTurn(text: string): boolean {
    const value = String(text ?? '').trim()
    if (!value || value.length > 90 || value.startsWith('/')) return false
    return !detectActionIntent(value).requiresTool && !WORKISH.test(value) && !NEEDS_LOOKUP.test(value) && !RECALL.test(value) && !/[\d/\@]|https?:/i.test(value)
}

export function isConversationRecall(text: string): boolean {
    const value = String(text ?? '').trim()
    return Boolean(value) && value.length <= 160 && RECALL.test(value) && !detectActionIntent(value).requiresTool
}

export function withoutFirstChoiceLookups<T extends { name: string }>(text: string, tools: readonly T[]): T[] {
    return isSmallTalkTurn(text) || isConversationRecall(text) ? tools.filter(tool => !LOOKUPS.has(tool.name)) : [...tools]
}

/** Prompt hint for questions about the running conversation. */
export function conversationRecallGuidance(text: string): string {
    return isConversationRecall(text)
        ? '\n\n## Frage zum Gespräch\nDie Frage betrifft etwas, das in diesem Gespräch gesagt wurde. Schau zuerst im Gesprächsverlauf nach und antworte direkt daraus. Nur wenn es dort nicht steht, sag ehrlich, dass du es nicht weißt. Gib nie eine rohe Werkzeug-Ausgabe als Antwort.'
        : ''
}
