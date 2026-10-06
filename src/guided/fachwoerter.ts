/**
 * 2.86 Paket M „Geführt“ — Grundsatz (Alfred 06.10.): Nutzer sind DAUs, also
 * keine Fachwörter in Texten an den Owner.
 *
 * Diese Liste ist die EINE Stelle, gegen die Owner-Texte geprüft werden —
 * für die geführten Wege (M), die Geräte- und Verbindungswege (N, über
 * `sensing/device-words.ts`) und die Sprachwege (O). Der Test
 * `guided-fachwoerter.test.ts` prüft alle Owner-Texte aus N, M und O.
 * Neue Fachwörter hier ergänzen, nicht in einzelnen Modulen. Markennamen,
 * die auf dem Gerät stehen (Hue, Home Assistant, Tuya, Shelly), sind erlaubt.
 */

export interface Fachwort { wort: string; muster: RegExp; besser: string }

export const FACHWOERTER: readonly Fachwort[] = Object.freeze([
    { wort: 'Mesh', muster: /\bmesh\b/i, besser: 'deine Rechner' },
    { wort: 'Lease', muster: /\blease\b/i, besser: '(weglassen)' },
    { wort: 'Fabric', muster: /\bfabric\b/i, besser: '(weglassen)' },
    { wort: 'Matter-Pairing', muster: /\bmatter[- ]?pairing\b/i, besser: 'Gerät koppeln' },
    { wort: 'Pairing', muster: /\bpairing\b/i, besser: 'koppeln' },
    { wort: 'Local-Key', muster: /\blocal[- ]?key\b/i, besser: 'Code aus der App' },
    { wort: 'MCP', muster: /\bmcp\b/i, besser: 'Anschluss' },
    { wort: 'Endpoint', muster: /\bendpoints?\b/i, besser: 'Adresse' },
    { wort: 'Token', muster: /\btokens?\b/i, besser: 'Zugang' },
    { wort: 'Doctor-Fall', muster: /\bdoctor(?:-fall|-fälle)?\b/i, besser: 'Selbstprüfung' },
    { wort: 'Layer', muster: /\blayers?\b/i, besser: '(weglassen)' },
    { wort: 'Layer-Nummer', muster: /\bL\d{1,2}\b/, besser: '(weglassen)' },
    { wort: 'API', muster: /\bapi\b/i, besser: 'Anschluss' },
    { wort: 'Port', muster: /\bports?\b/i, besser: 'Adresse' },
    { wort: 'LLM', muster: /\bllms?\b/i, besser: 'KI-Modell' },
    { wort: 'Provider', muster: /\bprovider\b/i, besser: 'Anbieter' },
    { wort: 'Daemon', muster: /\bdaemon\b/i, besser: 'Xaventra' },
    { wort: 'Node', muster: /\bnodes?\b/i, besser: 'Rechner' },
    { wort: 'OAuth', muster: /\boauth\b/i, besser: 'anmelden' },
    { wort: 'Webhook', muster: /\bwebhooks?\b/i, besser: '(weglassen)' },
    { wort: 'JSON', muster: /\bjson\b/i, besser: '(weglassen)' },
    { wort: 'Config', muster: /\bconfig\b/i, besser: 'Einstellung' },
    { wort: 'Callback', muster: /\bcallbacks?\b/i, besser: '(weglassen)' },
    { wort: 'Hash', muster: /\bhash(?:es)?\b/i, besser: '(weglassen)' },
    { wort: 'UUID', muster: /\buuid\b/i, besser: '(weglassen)' },
    { wort: 'Subagent', muster: /\bsub-?agents?\b/i, besser: 'Helfer' },
    { wort: 'PATCH_GATE', muster: /\bpatch_gate\b/i, besser: 'Freigabe' },
    { wort: 'Ollama', muster: /\bollama\b/i, besser: 'KI-Programm' },
    { wort: 'Protokoll', muster: /\bprotokoll\b/i, besser: '(weglassen)' },
    { wort: 'Pipeline', muster: /\bpipeline\b/i, besser: '(weglassen)' },
    { wort: 'Slash-Befehl', muster: /(?:^|\s)\/[a-z]{3,}\b/i, besser: 'Knopf' },
    // 2.86 Paket N: Geräte- und Verbindungswege (vorher eigene Liste in sensing/device-words.ts).
    { wort: 'API-Schlüssel', muster: /api-?schl(?:ü|ue)ssel/i, besser: 'Zugang' },
    { wort: 'IP', muster: /\bIP(?:v4|v6)?\b/, besser: 'Adresse' },
    { wort: 'Entität', muster: /\bentit(?:ä|ae)t/i, besser: 'Gerät' },
    { wort: 'Instanz', muster: /\binstanz/i, besser: '(weglassen)' },
    { wort: 'mDNS', muster: /\bmdns\b/i, besser: '(weglassen)' },
    { wort: 'Cloud', muster: /cloud/i, besser: 'über den Hersteller' },
    { wort: 'Endpunkt', muster: /\bendpunkt/i, besser: 'Adresse' },
    { wort: 'http(s)', muster: /\bhttps?\b/i, besser: 'sichere Adresse' },
    { wort: 'Zigbee', muster: /\bzigbee\b/i, besser: '(weglassen)' },
    { wort: 'Thread', muster: /\bthread\b/i, besser: '(weglassen)' },
    { wort: 'Firmware', muster: /\bfirmware\b/i, besser: 'Gerätesoftware' },
    { wort: 'Matter', muster: /\bmatter\b/i, besser: 'Gerät' },
    { wort: 'Fingerabdruck', muster: /\bfingerabdruck|\bfingerprint/i, besser: '(weglassen)' },
    { wort: 'Connector', muster: /\bconnector\b/i, besser: 'Anschluss' },
    { wort: 'Kopplungscode', muster: /kopplungscode/i, besser: 'Code vom Aufkleber' },
    { wort: 'Funktions-Id', muster: /\bfunktions-?id\b/i, besser: '(weglassen)' },
    { wort: 'Geräte-Id', muster: /\bdev-[a-f0-9]{10}\b/i, besser: 'Gerätename' },
    { wort: 'Geräteschlüssel', muster: /ger(?:ä|ae)teschl(?:ü|ue)ssel/i, besser: 'Code aus der App' },
    { wort: 'Schlüssel', muster: /\bschl(?:ü|ue)ssel\b/i, besser: 'Code' },
])

/** All technical words found in `text` (empty = fine for the owner). */
export function findeFachwoerter(text: unknown): string[] {
    const value = String(text ?? '')
    return FACHWOERTER.filter(entry => entry.muster.test(value)).map(entry => entry.wort)
}
