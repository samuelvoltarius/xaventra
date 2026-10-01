/**
 * Phase 3 — Prüfsatz für den Modell-Scout.
 *
 * Aus echten Fällen, ohne private Inhalte:
 * - Doctor-Fälle (Titel/Hypothese) mit maskierten Messwerten und IDs wie beim
 *   Stufe-1-Fingerabdruck; enthält ein Fall danach noch etwas Persönliches
 *   (E-Mail, Telefon, IBAN, IP, URL, Home-Pfad, Secret), wird er verworfen —
 *   nicht geschwärzt, damit nichts Halbes durchrutscht.
 * - Alltagsfragen: feste, anonyme Vorlagen im Code, gewichtet nach der echten
 *   Aufgabenverteilung aus den Traces (taskType-Zählung). Nachrichtentexte
 *   speichern die Traces ohnehin nicht (R2 L12).
 */
import { redactSecrets } from '../security/secret-redaction.js'
import type { FailureResearchCase } from '../doctor/failure-research-coordinator.js'

export interface ProbeExpectation { kind: 'contains-any' | 'nonempty'; values?: string[] }
export interface ProbeCase { id: string; origin: 'doctor' | 'alltag'; prompt: string; expect: ProbeExpectation }

const PRIVATE_PATTERNS: Array<[string, RegExp]> = [
    ['E-Mail', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
    ['IBAN', /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/],
    ['Telefon', /(?:\+|00)\d{1,3}[\s/-]?\(?\d{2,4}\)?(?:[\s/-]?\d{2,}){2,}|\b0\d{2,4}[\s/-]\d{3,}(?:[\s/-]?\d+)*/],
    ['IP-Adresse', /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i],
    ['URL', /\bhttps?:\/\/|\bwww\./i],
    ['Home-Pfad', /[A-Za-z]:\\Users\\|\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root\//i],
    ['SSH/Schlüssel', /\.ssh\b|id_(?:rsa|ed25519|ecdsa)|-----BEGIN/i],
    ['lange Ziffernfolge', /\d{6,}/],
]

/** Grund, warum ein Text privat wirkt, oder null. */
export function containsPrivateContent(text: string): string | null {
    const value = String(text || '')
    if (redactSecrets(value) !== value) return 'Secret'
    if (/\b(?:token|passw(?:or)?d|secret|api[_-]?key|bearer)\b\s*[:=]/i.test(value)) return 'Secret'
    for (const [label, pattern] of PRIVATE_PATTERNS) if (pattern.test(value)) return label
    return null
}

/** Messwerte und IDs sind Messung, kein Fallinhalt (wie observationFingerprint). */
export function maskMeasurements(text: string): string {
    return String(text || '')
        .replace(/[0-9a-f]{12,}/gi, '<id>')
        .replace(/\d+(?:[.,:]\d+)*\s*%?/g, 'N ')
        .replace(/\s+/g, ' ')
        .trim()
}

type Template = { prompt: string; expect: ProbeExpectation }
const EVERYDAY: Record<string, Template[]> = {
    chat: [
        { prompt: 'Wie viele Minuten hat ein Tag? Antworte nur mit der Zahl.', expect: { kind: 'contains-any', values: ['1440', '1.440'] } },
        { prompt: 'Nenne die Hauptstadt von Österreich mit einem Wort.', expect: { kind: 'contains-any', values: ['Wien'] } },
        { prompt: 'Formuliere eine höfliche Absage für einen Termin am Donnerstag in einem Satz.', expect: { kind: 'contains-any', values: ['Donnerstag'] } },
        { prompt: 'Welcher Wochentag folgt auf Freitag? Ein Wort.', expect: { kind: 'contains-any', values: ['Samstag', 'Sonnabend'] } },
    ],
    reasoning: [
        { prompt: 'Was ist 17 mal 23? Antworte nur mit der Zahl.', expect: { kind: 'contains-any', values: ['391'] } },
        { prompt: 'Ein Zug fährt 120 km in 1,5 Stunden. Wie schnell ist er im Schnitt in km/h? Nur die Zahl.', expect: { kind: 'contains-any', values: ['80'] } },
        { prompt: 'Rechne 3,5 Kilometer in Meter um. Nur die Zahl.', expect: { kind: 'contains-any', values: ['3500', '3.500'] } },
    ],
    code: [
        { prompt: 'Schreibe eine JavaScript-Funktion add(a, b), die die Summe zurückgibt. Nur Code.', expect: { kind: 'contains-any', values: ['return a + b', 'return a+b', '=> a + b', '=> a+b'] } },
        { prompt: 'Gib das JSON-Objekt mit dem Schlüssel "status" und dem Wert "ok" aus. Nur JSON.', expect: { kind: 'contains-any', values: ['"status": "ok"', '"status":"ok"'] } },
        { prompt: 'Welcher HTTP-Statuscode bedeutet "Not Found"? Nur die Zahl.', expect: { kind: 'contains-any', values: ['404'] } },
    ],
    search: [
        { prompt: 'Fasse in einem Satz zusammen: "Der Drucker meldet Filament leer. Der Auftrag ist bei 92 Prozent pausiert." Nenne den Prozentwert.', expect: { kind: 'contains-any', values: ['92'] } },
        { prompt: 'Aus dem Text "Termin verschoben auf 14:30 Uhr" — um wie viel Uhr ist der Termin? Nur die Uhrzeit.', expect: { kind: 'contains-any', values: ['14:30', '14.30'] } },
    ],
    system: [
        { prompt: 'Ein Dienst antwortet mit HTTP 503. Nenne in einem Satz einen sicheren, nur lesenden ersten Prüfschritt.', expect: { kind: 'contains-any', values: ['Log', 'log', 'Status', 'status', 'prüf', 'Prüf'] } },
        { prompt: 'Die Platte ist zu 95 Prozent voll. Was ist ein sicherer erster Schritt, ohne etwas zu löschen? Ein Satz.', expect: { kind: 'contains-any', values: ['prüf', 'Prüf', 'anzeig', 'größ', 'Größ', 'ermittel', 'du ', 'df'] } },
    ],
}

/**
 * Baut den Prüfsatz. Höchstens `maxDoctor` Doctor-Fälle, Alltagsfragen nach
 * Aufgabenverteilung (mindestens eine je Art, damit nichts unbewertet bleibt).
 */
export function buildProbeSet(input: { doctorCases: readonly FailureResearchCase[]; taskTypeCounts: Record<string, number>; maxDoctor?: number; maxEveryday?: number }): ProbeCase[] {
    const probes: ProbeCase[] = []
    const seen = new Set<string>()
    for (const item of input.doctorCases) {
        if (probes.length >= (input.maxDoctor ?? 8)) break
        const raw = `${item.title} ${item.hypothesis}`
        if (containsPrivateContent(raw)) continue
        const title = maskMeasurements(item.title).slice(0, 160)
        const detail = maskMeasurements(item.hypothesis).slice(0, 300)
        const prompt = `Ein Systembefund lautet: "${title}". Beobachtung: "${detail}". Nenne die wahrscheinlichste Ursache und einen sicheren, nur lesenden nächsten Prüfschritt in höchstens drei Sätzen.`
        if (containsPrivateContent(prompt) || seen.has(prompt)) continue
        seen.add(prompt)
        probes.push({ id: `doctor-${item.id.slice(0, 12)}`, origin: 'doctor', prompt, expect: { kind: 'nonempty' } })
    }
    const kinds = Object.keys(EVERYDAY)
    const total = kinds.reduce((sum, kind) => sum + Math.max(0, Number(input.taskTypeCounts[kind]) || 0), 0)
    const max = input.maxEveryday ?? 12
    for (const kind of kinds) {
        const share = total > 0 ? (Math.max(0, Number(input.taskTypeCounts[kind]) || 0) / total) : 1 / kinds.length
        const count = Math.max(1, Math.min(EVERYDAY[kind].length, Math.round(share * max)))
        EVERYDAY[kind].slice(0, count).forEach((template, index) => {
            probes.push({ id: `alltag-${kind}-${index + 1}`, origin: 'alltag', prompt: template.prompt, expect: template.expect })
        })
    }
    return probes.filter(probe => !containsPrivateContent(probe.prompt))
}

/** Bewertung einer Antwort für Runner, die keinen eigenen Prüfer haben. */
export function scoreAnswer(probe: ProbeCase, answer: string): boolean {
    const text = String(answer || '').trim()
    if (!text || text.length > 4_000) return false
    if (probe.expect.kind === 'nonempty') return text.length >= 20
    return (probe.expect.values || []).some(value => text.includes(value))
}
