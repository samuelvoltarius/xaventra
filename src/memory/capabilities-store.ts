/**
 * Capabilities Store - Negativ-Gedaechtnis dieser Maschine
 *
 * Merkt sich, welche Werkzeuge hier nicht funktionieren ("kein Browser
 * installiert"), damit Nova es nicht bei jeder Frage neu probiert.
 *
 * 2.84.0: Die Erfolgsliste ("DEINE GELERNTEN FAEHIGKEITEN") ist entfallen. Sie
 * lernte aus jedem nicht geworfenen Werkzeugaufruf VOR der Validierung und war
 * ein siebter Lernblock im Prompt neben den Prozeduren, die nur aus
 * verifizierten Laeufen lernen (learning/procedure-store.ts). Eine vorhandene
 * `.nova-learning/capabilities.json` bleibt liegen, wird aber weder gelesen
 * noch geschrieben.
 *
 * 2.89 (Paket C): kein eigener Speicher mehr. Dieses Modul ist nur noch die Sicht
 * "was geht hier nicht" auf den EINEN Werkzeug-Gesundheitsspeicher
 * (core/tool-health-store.ts, `<Datenordner>/tool-health.json`), den auch L15 und
 * das Faehigkeits-Inventar lesen. Frueher: `.nova-learning/unavailable.json` neben
 * `.nova-data/tool-health.json`, beide unter process.cwd(), ohne voneinander zu wissen.
 */

import { redactSecrets } from '../security/secret-redaction.js'
import {
    clearToolFailures, isToolUnavailable, loadToolHealth, noteToolFailure,
} from '../core/tool-health-store.js'

export interface CapabilityPromptOptions {
    /** Role of the prompt recipient. Failure texts only for 'owner'. */
    permission?: string
}

/** Redacted single-line text that cannot break out of the prompt list. */
function promptSafe(text: string, max: number): string {
    return redactSecrets(String(text || '')).replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Prompt-Abschnitt dieses Speichers: nur noch das Negativ-Gedaechtnis.
 * Bleibt unter diesem Namen, weil die Pipeline ihn so einhaengt.
 */
export function getCapabilitiesPrompt(options: CapabilityPromptOptions = {}): string {
    return getUnavailablePrompt(options)
}

// ============================================
// Negativ-Gedaechtnis — was auf DIESER Maschine nicht geht
// ============================================

export interface UnavailableCapability {
    tool: string
    reason: string
    hint?: string          // Ersatzweg oder Nachruest-Befehl
    failCount: number
    firstFailed: number
    lastFailed: number
    resolved?: boolean     // nach erfolgreichem Nachruesten wieder frei
}

/** Alle Werkzeuge, die hier nicht gehen (aus dem einen Gesundheitsspeicher). */
export function loadUnavailable(): UnavailableCapability[] {
    return loadToolHealth().filter(isToolUnavailable).map(entry => ({
        tool: entry.name,
        reason: entry.reason || entry.lastDiagnosis || 'Werkzeug meldete Fehlschlag',
        ...(entry.hint ? { hint: entry.hint } : {}),
        failCount: Math.max(entry.consecutiveFailures, entry.status === 'healthy' ? 0 : 1),
        firstFailed: entry.lastFailure,
        lastFailed: entry.lastFailure,
    }))
}

/** Merkt sich, dass ein Werkzeug auf dieser Maschine nicht funktioniert. */
export function recordUnavailable(tool: string, reason: string, hint?: string): void {
    try { noteToolFailure(tool, { reason, hint }) } catch { /* Lernen darf den Lauf nie zum Absturz bringen */ }
}

/** Nach erfolgreichem Nachruesten wieder freigeben. */
export function clearUnavailable(tool: string): void {
    try { clearToolFailures(tool) } catch { /* egal */ }
}

export function getUnavailablePrompt(options: CapabilityPromptOptions = {}): string {
    const isOwner = options.permission === 'owner'
    // Erst ab dem zweiten Fehlschlag in Folge als "geht hier nicht" melden — ein
    // einzelner Fehler kann ein Netzaussetzer oder ein Tippfehler sein.
    const list = loadUnavailable()
    if (list.length === 0) return ''

    let p = `
## 🚫 AUF DIESER MASCHINE NICHT VERFÜGBAR (selbst gelernt)
Das hast du hier schon erfolglos versucht — probiere es nicht blind erneut:

`
    for (const u of list.sort((a, b) => b.failCount - a.failCount).slice(0, 12)) {
        // Failure texts may carry user input or secrets: owner only, redacted.
        p += `- \`${promptSafe(u.tool, 60)}\` (${u.failCount}x fehlgeschlagen)`
        if (isOwner) p += `: ${promptSafe(u.reason, 200)}`
        if (u.hint) p += ` → ${promptSafe(u.hint, 120)}`
        p += '\n'
    }
    p += `
Du bist root: fehlt nur ein Paket, ruest es nach und trage die Faehigkeit danach
wieder als verfuegbar ein. Bleibt es unmoeglich, sag es klar und nenne den Ersatzweg.
`
    return p
}

/**
 * Learn from one tool outcome. Only the owner's runs teach this machine-wide
 * store: another role must neither mark a tool as unavailable for everyone
 * (including the owner) nor place its failure text into other prompts.
 */
export function learnToolOutcome(input: {
    tool: string
    args?: Record<string, unknown>
    result: unknown
    permission?: string
}): 'ignored' | 'failure' | 'success' {
    if (input.permission !== 'owner') return 'ignored'
    const r = input.result as any
    const fehlertext = String((r && typeof r === 'object' && (r.error || r.stderr)) || '')
    const gescheitert = Boolean(fehlertext)
        || (r && typeof r === 'object' && (r.success === false || r.blocked === true))
    if (gescheitert) {
        const hinweis = /browser|chromium|playwright/i.test(input.tool + fehlertext)
            ? 'stattdessen fetch_url oder web_search; nachruestbar mit apt install chromium-browser'
            : /display|desktop|screenshot/i.test(input.tool + fehlertext)
                ? 'keine grafische Oberflaeche vorhanden'
                : undefined
        recordUnavailable(input.tool, (fehlertext || 'Werkzeug meldete Fehlschlag').slice(0, 200), hinweis)
        return 'failure'
    }
    // Erfolg: falls frueher als unmoeglich gelernt, wieder freigeben
    clearUnavailable(input.tool)
    return 'success'
}

export default {
    getCapabilitiesPrompt,
    getUnavailablePrompt,
    loadUnavailable,
    recordUnavailable,
    clearUnavailable,
    learnToolOutcome,
}
