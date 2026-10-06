/**
 * 2.88 „Sehen und lenken“ Teil 3: Regeln in Klartext.
 *
 * Der Owner schreibt oder sagt „Lichter darfst du ohne Frage schalten“, „bei
 * Mails immer fragen“, „nie etwas löschen“. Es gibt KEINEN zweiten
 * Regel-Speicher: jede Regel ist eine bindende Owner-Entscheidung im
 * kausalen Gedächtnis (core/decisions.ts) und wirkt über die eine
 * Aktions-Policy (L0–L3):
 *   fragen     → DecisionConstraint 'fragen' (mindestens L2, Karte)
 *   blockieren → DecisionConstraint 'nie'    (L3, nie)
 *   erlauben   → nur für Arten ohne feste Grenze (isStandingExcluded=false)
 *                über evaluateActionWithTrust, plus die eine physische
 *                Ausnahme „Lichter schalten“ (Vorschau-Karte entfällt,
 *                Rückgängig bleibt).
 * Feste Sicherheitsregeln (Geld, Zugangsdaten, Löschen, Nie-Liste,
 * Nachrichten nach außen, andere Geräte) lassen sich nicht lockern; die
 * Regel bleibt sichtbar und sagt freundlich, warum sie nicht greift.
 *
 * Im Gespräch entsteht eine Regel ohne Befehl (message-pipeline →
 * observeOwnerMessage); hier kommen Liste, Hinzufügen, Ändern, Entfernen
 * für App und Telegram dazu.
 */
import { AKTIONSARTEN, evaluateAction } from '../core/action-policy.js'
import {
    directiveMode, listDecisions, observeOwnerMessage, resolveConflict, revokeDecision,
    type Decision, type DecisionOptions,
} from '../core/decisions.js'

export type RegelWirkung = 'erlauben' | 'fragen' | 'blockieren'
export const REGEL_WIRKUNGEN: readonly RegelWirkung[] = Object.freeze(['erlauben', 'fragen', 'blockieren'])

export interface Regel {
    id: string
    satz: string
    wirkung: RegelWirkung
    /** Worauf sie wirkt, in Alltagssprache („Lichter schalten“, „E-Mails senden“). */
    bereich: string
    /** true = greift in der Policy; false = gespeichert, aber feste Grenze. */
    wirksam: boolean
    /** true = eine feste Sicherheitsregel verhindert das Lockern. */
    fest: boolean
    hinweis: string
    seit: string | null
    status: 'gilt' | 'rueckfrage'
    quelle: 'gespräch' | 'app' | 'knopf'
}

export interface RegelAntwort { ok: boolean; message: string; regel?: Regel }

const ID = /^d-[a-f0-9]{10}$/
const MAX_SATZ = 300
const LEAD = /^(ab (jetzt|sofort|heute)|von nun an|k(ü|ue)nftig|in zukunft)[,:]?\s+/i

const FEST_TEXT: Record<string, string> = {
    'Geld': 'Bei Geld frage ich immer.',
    'Zugang': 'Passwörter und Zugangsdaten fasse ich nie ohne dich an.',
    'Löschen': 'Löschen mache ich nie ohne dich.',
    'Nie-Liste': 'Das steht auf meiner festen Nie-Liste.',
    'physisch/extern': 'Nachrichten nach außen und Geräte (außer Lichtern) frage ich immer vorher.',
}
const FEST_SCHLUSS = 'Das ist eine feste Sicherheitsregel – die kann auch eine Regel nicht lockern. Fragen kostet dich nur einen Knopfdruck.'

const BEREICH: Record<string, string> = {
    'schalten': 'Geräte schalten', 'mail-senden': 'E-Mails senden', 'nachricht-senden': 'Nachrichten nach außen',
    'daten-loeschen': 'Löschen', 'drucken': 'Drucken', 'install-katalog': 'Programme installieren', 'dienst-neustart': 'Dienste neu starten',
    'modell-wechseln': 'KI-Modell wechseln', 'config-aendern': 'Einstellungen ändern', 'release-ausrollen': 'Updates ausrollen',
    'patch-anwenden': 'Code-Änderungen', 'geraet-einrichten': 'Geräte einrichten', 'log-rotation': 'Protokolle aufräumen',
    'cache-leeren': 'Zwischenspeicher leeren', 'self-heal-zyklus': 'Selbstheilung', 'endpoint-umschalten': 'Modell-Adresse umschalten',
}
function bereichVon(item: Decision): string {
    const rule = item.constraint
    if (rule?.nur === 'licht') return 'Lichter schalten'
    const arten = rule?.arten || []
    const vm = arten.filter(kind => /^(vm|pve)-/.test(kind))
    const names = [...new Set([...arten.filter(kind => !/^(vm|pve)-/.test(kind)).map(kind => BEREICH[kind] || AKTIONSARTEN[kind]?.text || kind), ...(vm.length ? ['virtuelle Maschinen'] : [])])]
    return names.length ? names.slice(0, 4).join(', ') : 'allgemein'
}

function wirkungVon(item: Decision): RegelWirkung {
    if (item.wirkung === 'lockernd' || item.constraint?.mode === 'erlauben') return 'erlauben'
    const mode = item.constraint?.mode || directiveMode(item.text, Date.parse(item.at) || Date.now())
    return mode === 'nie' ? 'blockieren' : 'fragen'
}

function hinweisVon(item: Decision, wirkung: RegelWirkung): { hinweis: string; fest: boolean } {
    if (!item.wirksam) {
        const limit = /\(([^)]+)\)/.exec(item.nichtWirksamGrund || '')?.[1] || ''
        return { hinweis: `${FEST_TEXT[limit] || 'Das gehört zu meinen festen Grenzen.'} ${FEST_SCHLUSS}`, fest: true }
    }
    if (item.status === 'rueckfrage') return { hinweis: 'Widerspricht einer älteren Regel – bis du entscheidest, gilt die alte.', fest: false }
    if (wirkung === 'erlauben') {
        if (item.constraint?.nur === 'licht') return { hinweis: 'Lichter schalte ich ohne Vorschau-Karte. Rückgängig geht danach 5 Minuten lang.', fest: false }
        if (item.constraint?.mode === 'erlauben') return { hinweis: 'Mache ich ab jetzt ohne zu fragen – nur auf dem eigenen Rechner, nie mit Wirkung nach außen.', fest: false }
        return { hinweis: 'Merke ich mir als Hinweis; eine feste Freigabe gibt es dafür nicht.', fest: false }
    }
    if (wirkung === 'blockieren') {
        const schonNie = (item.constraint?.arten || []).some(kind => evaluateAction({ kind, origin: 'code' }, { constraints: [] }).level === 'L3')
        return {
            hinweis: schonNie ? 'Mache ich nie (das war ohnehin eine feste Grenze).'
                : item.constraint ? 'Mache ich nie – auch keine Karte dafür.' : 'Merke ich mir und halte mich daran.',
            fest: false,
        }
    }
    return { hinweis: item.constraint ? 'Ich frage dich jedes Mal vorher – mit einem Knopf.' : 'Merke ich mir und frage vorher.', fest: false }
}

/** Decision → Regel; null = kein Regelsatz (Befund, neutraler Hinweis, beendet). */
export function alsRegel(item: Decision): Regel | null {
    if (!item.bindend || (item.status !== 'aktiv' && item.status !== 'rueckfrage')) return null
    if (item.wirkung !== 'strenger' && item.wirkung !== 'lockernd') return null
    const wirkung = wirkungVon(item)
    const { hinweis, fest } = hinweisVon(item, wirkung)
    return {
        id: item.id, satz: item.text, wirkung, bereich: bereichVon(item), wirksam: item.wirksam !== false && item.status === 'aktiv', fest, hinweis,
        seit: item.at || null, status: item.status === 'rueckfrage' ? 'rueckfrage' : 'gilt',
        quelle: item.quelle.art === 'knopf' ? 'knopf' : item.quelle.kanal === 'desktop-regeln' ? 'app' : 'gespräch',
    }
}

/** Alle Regeln, neueste zuerst. */
export function listeRegeln(opts: DecisionOptions = {}): Regel[] {
    return listDecisions(opts).map(alsRegel).filter((item): item is Regel => Boolean(item))
        .sort((a, b) => String(b.seit).localeCompare(String(a.seit)))
}

function antwortFuer(regel: Regel, neu = true): string {
    if (regel.fest) return `Gemerkt, aber: ${regel.hinweis}`
    const was = regel.wirkung === 'erlauben' ? 'ohne zu fragen' : regel.wirkung === 'fragen' ? 'immer erst fragen' : 'nie'
    return `${neu ? 'Verstanden' : 'Geändert'}: ${regel.bereich} – ${was}. ${regel.hinweis}`
}

/**
 * Neue Regel aus einem Satz (App/Telegram). Derselbe Weg wie im Gespräch;
 * „Ab sofort:“ macht aus jedem Satz eine Anweisung, und eine neue Regel aus
 * der Regel-Seite ersetzt eine widersprechende ältere ausdrücklich.
 */
export function neueRegel(text: unknown, by: { principalId: string; kanal?: string }, opts: DecisionOptions = {}): RegelAntwort {
    const satz = String(text ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!satz) return { ok: false, message: 'Schreib einfach einen Satz, z. B. „Lichter darfst du ohne Frage schalten“.' }
    if (satz.length > MAX_SATZ) return { ok: false, message: 'Bitte kürzer – ein Satz reicht.' }
    if (satz.startsWith('/') || satz.includes('?')) return { ok: false, message: 'Das klingt nach einer Frage. Schreib die Regel als Satz, z. B. „Bei Mails immer fragen“.' }
    const result = observeOwnerMessage({
        text: `Ab sofort: ${satz.replace(LEAD, '').replace(/[.!]+(?=\s)/g, ',')}`,
        permission: 'owner', principalId: by.principalId, channel: by.kanal || 'desktop-regeln',
    }, opts)
    if (result.skipped === 'kein Main') return { ok: false, message: 'Regeln speichert nur der Hauptrechner – der ist gerade nicht erreichbar.' }
    let created = result.created[0]
    const conflict = result.conflicts[0]
    if (!created && conflict) {
        // Auf der Regel-Seite ist der neue Satz die ausdrückliche Entscheidung: er ersetzt die alte Regel.
        const settled = resolveConflict(conflict.neu.id, 'neu', `owner:${by.principalId}`, opts)
        if (settled.ok && settled.decision) created = settled.decision
    }
    if (!created && result.confirmed[0]) {
        const regel = alsRegel(result.confirmed[0])
        return { ok: true, message: 'Diese Regel gibt es schon – sie gilt weiter.', ...(regel ? { regel } : {}) }
    }
    if (created) ersetzeWiderspruch(created, satz, by.principalId, opts)
    const regel = created ? alsRegel(created) : null
    if (!regel) return { ok: false, message: 'Das habe ich nicht als Regel verstanden. Beispiele: „Lichter darfst du ohne Frage schalten“, „Bei Mails immer fragen“, „Nie etwas löschen“.' }
    return { ok: true, message: antwortFuer(regel), regel }
}

/**
 * Eine neue Regel aus der App ersetzt ältere, gültige Regeln mit anderer
 * Wirkung für dieselbe Aktionsart (das kausale Gedächtnis erkennt nur
 * gleiche Wörter, „Lichter“/„Lichtern“ nicht). Eine Licht-Regel fällt nur,
 * wenn der neue Satz selbst von Licht spricht.
 */
function ersetzeWiderspruch(neu: Decision, satz: string, principalId: string, opts: DecisionOptions): void {
    const arten = new Set(neu.constraint?.arten || [])
    if (!arten.size || !neu.wirksam) return
    const lichtImSatz = /licht|lampe|leucht/i.test(satz)
    for (const alt of listDecisions(opts)) {
        if (alt.id === neu.id || alt.status !== 'aktiv' || !alt.bindend || !alt.constraint) continue
        if (alt.constraint.mode === neu.constraint!.mode && Boolean(alt.constraint.nur) === Boolean(neu.constraint!.nur)) continue
        if (!alt.constraint.arten.some(kind => arten.has(kind))) continue
        if (alt.constraint.nur === 'licht' && !lichtImSatz) continue
        revokeDecision(alt.id, `owner:${principalId} (ersetzt durch ${neu.id})`, opts)
    }
}

/** Kern einer Regel ohne die Steuerwörter (für das Umschreiben beim Ändern). */
export function regelKern(satz: string): string {
    return String(satz || '')
        .replace(LEAD, '')
        .replace(/\b(du )?(darfst|kannst|sollst)( du)?\b/gi, ' ')
        .replace(/\bohne (vorher )?(zu )?(frage|fragen|r(ü|ue)ckfrage|nachfrage|knopf|karte|mich zu fragen)\b/gi, ' ')
        .replace(/\b(immer|vorher|zuerst) (nach)?fragen\b|\bfrag(e)? (mich )?(immer|vorher|zuerst)\b|\b(musst|brauchst) (mich )?nicht (mehr )?(zu )?(nach)?fragen\b/gi, ' ')
        .replace(/\b(nie|niemals|immer|einfach|selbst|selbstst(ä|ae)ndig)\b|auf keinen fall/gi, ' ')
        .replace(/^\s*(bei|beim)\s+/i, '')
        .replace(/[.!,:;]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Wirkung ändern: die alte Regel wird ersetzt, der Inhalt bleibt. */
export function aendereRegel(id: unknown, wirkung: unknown, by: { principalId: string }, opts: DecisionOptions = {}): RegelAntwort {
    if (!ID.test(String(id ?? ''))) return { ok: false, message: 'Unbekannte Regel.' }
    if (!REGEL_WIRKUNGEN.includes(wirkung as RegelWirkung)) return { ok: false, message: 'Wähle: erlauben, fragen oder blockieren.' }
    const alt = listDecisions(opts).find(item => item.id === id)
    const altRegel = alt ? alsRegel(alt) : null
    if (!alt || !altRegel) return { ok: false, message: 'Diese Regel gilt nicht mehr.' }
    if (altRegel.wirkung === wirkung && altRegel.status === 'gilt') return { ok: true, message: 'So gilt sie schon.', regel: altRegel }
    const kern = regelKern(alt.text) || alt.text
    const satz = wirkung === 'erlauben' ? `${kern} darfst du ohne zu fragen` : wirkung === 'fragen' ? `Immer fragen: ${kern}` : `Nie ${kern}`
    const result = neueRegel(satz, { principalId: by.principalId, kanal: 'desktop-regeln' }, opts)
    if (!result.ok || !result.regel) return result
    if (result.regel.id !== alt.id) {
        const still = listDecisions(opts).find(item => item.id === alt.id)
        if (still && (still.status === 'aktiv' || still.status === 'rueckfrage')) revokeDecision(alt.id, `owner:${by.principalId}`, opts)
    }
    return { ...result, message: antwortFuer(result.regel, false) }
}

/** Regel entfernen (Widerruf; bleibt im Gedächtnis nachvollziehbar). */
export function entferneRegel(id: unknown, by: { principalId: string }, opts: DecisionOptions = {}): RegelAntwort {
    if (!ID.test(String(id ?? ''))) return { ok: false, message: 'Unbekannte Regel.' }
    const item = listDecisions(opts).find(entry => entry.id === id)
    if (!item || !alsRegel(item)) return { ok: false, message: 'Diese Regel gilt schon nicht mehr.' }
    const result = revokeDecision(String(id), `owner:${by.principalId}`, opts)
    return { ok: result.ok, message: result.ok ? `Entfernt: „${item.text}“. Ab jetzt gilt wieder das Übliche.` : result.message }
}

const ZEICHEN: Record<RegelWirkung, string> = { erlauben: '✅ ohne Frage', fragen: '❓ erst fragen', blockieren: '⛔ nie' }

/** Kurzliste für Telegram (eine Seite). */
export function regelnText(opts: DecisionOptions = {}): string {
    const regeln = listeRegeln(opts)
    const lines = ['📜 Deine Regeln']
    if (!regeln.length) lines.push('', 'Noch keine. Sag mir einfach z. B. „Lichter darfst du ohne Frage schalten“ oder „Bei Mails immer fragen“.')
    for (const regel of regeln.slice(0, 12)) {
        lines.push('', `${ZEICHEN[regel.wirkung]} · ${regel.bereich}`, `„${regel.satz}“${regel.fest ? ` – ${regel.hinweis}` : ''}`)
    }
    if (regeln.length > 12) lines.push('', `… und ${regeln.length - 12} weitere in der App unter „Regeln“.`)
    lines.push('', 'Ändern: einfach sagen oder in der App unter „Regeln“. Geld, Zugangsdaten, Löschen und die Nie-Liste bleiben immer fest.')
    return lines.join('\n')
}
