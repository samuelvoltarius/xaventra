/**
 * 2.87 Paket P: Antwort wortweise sprechen.
 *
 * Ein Sprach-Zug (Anruf in der App oder am Telefon) legt hier einen „Hörer“
 * ab. Die normale Pipeline läuft unverändert (Gedächtnis, Werkzeuge, Regeln);
 * nur die Modellrunden, die der Agenten-Runner ausdrücklich als „sprechbar“
 * markiert (erste Runde und Folgerunden nach Werkzeugen — NICHT Prüf-,
 * Reparatur- oder Zusammenfassungsaufrufe), melden ihre Textstücke.
 *
 * Request-lokal über AsyncLocalStorage: keine globale Einstellung, kein
 * anderer Kanal sieht etwas davon. Ohne Hörer ändert sich nichts.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface VoiceTurnSink {
    /** Sichtbarer Text der laufenden Modellrunde (ohne Denkspur). */
    onTextDelta(text: string): void
    /** Die Runde will Werkzeuge nutzen (Name, sobald er im Strom steht). */
    onToolRound(names: string[]): void
    /** Ein Werkzeug ist gelaufen — die Wirkung bleibt, auch bei Abbruch. */
    onToolDone?(name: string, ok: boolean): void
}

interface TurnState { sink: VoiceTurnSink; speakable: boolean }
const storage = new AsyncLocalStorage<TurnState>()

/** Den ganzen Pipeline-Lauf eines Sprach-Zugs mit Hörer ausführen. */
export function runWithVoiceTurn<T>(sink: VoiceTurnSink, operation: () => T): T {
    return storage.run({ sink, speakable: false }, operation)
}

/** Nur innerhalb dieses Aufrufs dürfen Modell-Textstücke an den Hörer. */
export function runSpeakable<T>(operation: () => T): T {
    const current = storage.getStore()
    if (!current) return operation()
    return storage.run({ sink: current.sink, speakable: true }, operation)
}

/** Hörer der aktuell sprechbaren Modellrunde, sonst null. */
export function speakableSink(): VoiceTurnSink | null {
    const current = storage.getStore()
    return current?.speakable ? current.sink : null
}

/** Läuft gerade ein Sprach-Zug (egal welche Runde)? */
export function voiceTurnActive(): boolean { return Boolean(storage.getStore()) }

/** Werkzeug-Ergebnis an den Hörer melden (auch außerhalb sprechbarer Runden). */
export function noteVoiceToolDone(name: string, ok: boolean): void {
    try { storage.getStore()?.sink.onToolDone?.(name, ok) } catch { /* Anzeige darf nie stören */ }
}

/**
 * Hüllt einen Modell-Client so, dass nur `complete` sprechbar läuft. Alle
 * anderen Eigenschaften (modelId, providerId, …) bleiben unverändert.
 */
export function speakableClient<T>(client: T): T {
    const target = client as any
    if (!target || typeof target.complete !== 'function') return client
    return new Proxy(target, {
        get(object, property) {
            if (property === 'complete') return (...args: any[]) => runSpeakable(() => object.complete(...args))
            const value = Reflect.get(object, property, object)
            return typeof value === 'function' ? value.bind(object) : value
        },
    }) as T
}
