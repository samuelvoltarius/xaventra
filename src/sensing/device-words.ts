/**
 * 2.86 Paket N „Geräte einfach und sicher“ — Alltagssprache für Geräte.
 *
 * Nutzer sind keine Techniker (Grundsatz Alfred 06.10.): Owner-Texte der
 * Geräte- und Verbindungswege sagen den Nutzen in einem Satz und enthalten
 * keine Fachwörter. Geprüft wird gegen die EINE Liste in
 * `guided/fachwoerter.ts` (Test gegen alle Owner-Texte aus N, M und O);
 * Markennamen, die auf dem Gerät stehen (Hue, Home Assistant, Tuya, Shelly),
 * sind erlaubt.
 */
import { findeFachwoerter } from '../guided/fachwoerter.js'

/**
 * Fachwörter-Prüfung: EINE Liste für alle Owner-Texte (guided/fachwoerter.ts),
 * hier nur unter dem bisherigen Namen der Geräte-Wege.
 */
export function fachwoerterIn(text: unknown): string[] {
    return findeFachwoerter(text)
}

export interface NutzenZaehlung { lampen?: number; schalter?: number; sensoren?: number; drucker?: number }

const anzahl = (n: number, eins: string, viele: string) => n === 1 ? eins : `${n} ${viele}`
const MIT_DEINE = /^\d/

/**
 * Das Ergebnis einer Verbindung als Nutzen in einem Satz:
 * „Ich kann jetzt deine 12 Lampen und 3 Schalter sehen.“
 */
export function nutzenSatz(z: NutzenZaehlung): string {
    const lampen = Math.max(0, Math.floor(z.lampen || 0)), schalter = Math.max(0, Math.floor(z.schalter || 0))
    const sensoren = Math.max(0, Math.floor(z.sensoren || 0)), drucker = Math.max(0, Math.floor(z.drucker || 0))
    if (drucker > 0 && !(lampen || schalter || sensoren)) {
        return drucker === 1 ? 'Ich sehe jetzt deinen 3D-Drucker und seinen Fortschritt.' : `Ich sehe jetzt deine ${drucker} 3D-Drucker und ihren Fortschritt.`
    }
    const teile: string[] = []
    if (lampen) teile.push(anzahl(lampen, 'eine Lampe', 'Lampen'))
    if (schalter) teile.push(anzahl(schalter, 'einen Schalter', 'Schalter'))
    if (sensoren) teile.push(anzahl(sensoren, 'einen Sensor', 'Sensoren'))
    if (drucker) teile.push(anzahl(drucker, 'einen 3D-Drucker', '3D-Drucker'))
    if (!teile.length) return 'Verbunden. Dort gibt es gerade noch nichts, das ich dir zeigen kann.'
    const liste = teile.length === 1 ? teile[0] : `${teile.slice(0, -1).join(', ')} und ${teile.at(-1)}`
    return `Ich kann jetzt ${MIT_DEINE.test(liste) ? 'deine ' : ''}${liste} sehen.`
}

/** Raum-Präposition für Alltagssätze („im Wohnzimmer“, „in der Küche“, „auf dem Balkon“). */
export function imRaum(raum: string): string {
    const r = raum.trim()
    if (/^(?:k(?:ü|ue)che|garage|diele|terrasse|toilette|werkstatt|waschk(?:ü|ue)che|speisekammer)$/i.test(r)) return `in der ${r}`
    if (/^(?:balkon|dachboden)$/i.test(r)) return `auf dem ${r}`
    return `im ${r}`
}

const enthaeltRaum = (name: string, raum: string) => name.toLocaleLowerCase('de-DE').includes(raum.toLocaleLowerCase('de-DE'))

/** Anzeige eines Geräts: „Stehlampe im Wohnzimmer“ (oder nur der Name, wenn der Raum schon darin steht). */
export function geraetAnzeige(name: string, raum?: string): string {
    const n = String(name || '').trim() || 'Gerät'
    return raum && !enthaeltRaum(n, raum) ? `${n} ${imRaum(raum)}` : n
}

export interface SatzZiel { name: string; raum?: string; art: 'licht' | 'schalter' | 'andere'; on: boolean }

function sammelname(ziele: readonly SatzZiel[]): string {
    const n = ziele.length
    if (ziele.every(z => z.art === 'licht')) return `${n} Lampen`
    if (ziele.every(z => z.art === 'schalter')) return `${n} Schalter`
    return `${n} Geräte`
}

/** Liste der Ziele für einen Satz, kurz (höchstens fünf Namen). */
function namensliste(ziele: readonly SatzZiel[], mitRaum: boolean): string {
    const namen = ziele.slice(0, 5).map(z => mitRaum ? geraetAnzeige(z.name, z.raum) : z.name)
    return `${namen.join(', ')}${ziele.length > 5 ? ` und ${ziele.length - 5} weitere` : ''}`
}

/** Was mit den Zielen passiert, in einem Satzteil: „Stehlampe im Wohnzimmer aus“. */
export function schaltTeil(ziele: readonly SatzZiel[]): string {
    if (!ziele.length) return 'nichts'
    const teil = (gruppe: SatzZiel[], wort: string) => {
        if (gruppe.length === 1) return `${geraetAnzeige(gruppe[0].name, gruppe[0].raum)} ${wort}`
        const raeume = [...new Set(gruppe.map(z => z.raum || ''))]
        if (raeume.length === 1 && raeume[0]) return `${sammelname(gruppe)} ${imRaum(raeume[0])} ${wort} (${namensliste(gruppe, false)})`
        return `${sammelname(gruppe)} ${wort} (${namensliste(gruppe, true)})`
    }
    const an = ziele.filter(z => z.on), aus = ziele.filter(z => !z.on)
    return [an.length ? teil(an, 'an') : '', aus.length ? teil(aus, 'aus') : ''].filter(Boolean).join(' und ')
}

/** Vorschau in einem Satz: „Ich schalte jetzt Stehlampe im Wohnzimmer aus.“ */
export function vorschauSatz(ziele: readonly SatzZiel[]): string {
    return `Ich schalte jetzt ${schaltTeil(ziele)}.`.slice(0, 360)
}
