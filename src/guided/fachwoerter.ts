/**
 * 2.86 Paket M „Geführt“ — Grundsatz (Alfred 06.10.): Nutzer sind DAUs, also
 * keine Fachwörter in Texten an den Owner.
 *
 * Diese Liste ist die EINE Stelle, gegen die Owner-Texte geprüft werden
 * (Test `guided-fachwoerter.test.ts` prüft alle Owner-Texte von Paket M).
 * Neue Fachwörter hier ergänzen, nicht in einzelnen Modulen.
 */

export interface Fachwort { wort: string; muster: RegExp; besser: string }

export const FACHWOERTER: readonly Fachwort[] = Object.freeze([
    { wort: 'Mesh', muster: /\bmesh\b/i, besser: 'deine Rechner' },
    { wort: 'Lease', muster: /\blease\b/i, besser: '(weglassen)' },
    { wort: 'Fabric', muster: /\bfabric\b/i, besser: '(weglassen)' },
    { wort: 'Matter-Pairing', muster: /\bmatter[- ]?pairing\b/i, besser: 'Gerät koppeln' },
    { wort: 'Pairing', muster: /\bpairing\b/i, besser: 'koppeln' },
    { wort: 'Local-Key', muster: /\blocal[- ]?key\b/i, besser: 'Geräteschlüssel' },
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
])

/** All technical words found in `text` (empty = fine for the owner). */
export function findeFachwoerter(text: unknown): string[] {
    const value = String(text ?? '')
    return FACHWOERTER.filter(entry => entry.muster.test(value)).map(entry => entry.wort)
}
