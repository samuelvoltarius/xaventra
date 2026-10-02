/**
 * Capabilities Store - Negativ-Gedaechtnis dieser Maschine
 *
 * Merkt sich, welche Werkzeuge hier nicht funktionieren ("kein Browser
 * installiert"), damit Nova es nicht bei jeder Frage neu probiert.
 *
 * 2.84.0: Die Erfolgsliste ("DEINE GELERNTEN FAEHIGKEITEN") ist entfallen. Sie
 * lernte aus jedem nicht geworfenen Werkzeugaufruf VOR der Validierung und war
 * ein siebter Lernblock im Prompt neben den Prozeduren, die nur aus
 * verifizierten Laeufen lernen (learning/procedure-store.ts). Ihr Abgleich ueber
 * den Supabase-Learning-Hub ist ebenfalls weg; Wissen zwischen Knoten geht nur
 * ueber L22. Eine vorhandene `.nova-learning/capabilities.json` bleibt liegen,
 * wird aber weder gelesen noch geschrieben.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../security/secret-redaction.js'

const CAPABILITIES_DIR = '.nova-learning'

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
// Ohne das probiert Nova bei jeder Frage neu, ob ein Browser existiert,
// scheitert wieder und vergisst es wieder. Erfolge allein reichen nicht:
// erst das Wissen "hier fehlt X" macht aus einem Fehlversuch eine Lehre.

export interface UnavailableCapability {
    tool: string
    reason: string
    hint?: string          // Ersatzweg oder Nachruest-Befehl
    failCount: number
    firstFailed: number
    lastFailed: number
    resolved?: boolean     // nach erfolgreichem Nachruesten wieder frei
}

const UNAVAILABLE_FILE = 'unavailable.json'

function getUnavailablePath(): string {
    const dir = join(process.cwd(), CAPABILITIES_DIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, UNAVAILABLE_FILE)
}

export function loadUnavailable(): UnavailableCapability[] {
    const path = getUnavailablePath()
    if (!existsSync(path)) return []
    try {
        return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
        return []
    }
}

/** Merkt sich, dass ein Werkzeug auf dieser Maschine nicht funktioniert. */
export function recordUnavailable(tool: string, reason: string, hint?: string): void {
    try {
        const list = loadUnavailable()
        const now = Date.now()
        const found = list.find(u => u.tool === tool)
        if (found) {
            found.failCount++
            found.lastFailed = now
            found.reason = redactSecrets(reason).slice(0, 300)
            if (hint) found.hint = hint
            found.resolved = false
        } else {
            list.push({
                tool,
                reason: redactSecrets(reason).slice(0, 300),
                hint,
                failCount: 1,
                firstFailed: now,
                lastFailed: now,
            })
        }
        writeFileSync(getUnavailablePath(), JSON.stringify(list, null, 2))
    } catch { /* Lernen darf den Lauf nie zum Absturz bringen */ }
}

/** Nach erfolgreichem Nachruesten wieder freigeben. */
export function clearUnavailable(tool: string): void {
    try {
        const list = loadUnavailable()
        const found = list.find(u => u.tool === tool)
        if (!found) return
        found.resolved = true
        writeFileSync(getUnavailablePath(), JSON.stringify(list, null, 2))
    } catch { /* egal */ }
}

export function getUnavailablePrompt(options: CapabilityPromptOptions = {}): string {
    const isOwner = options.permission === 'owner'
    // Erst ab dem zweiten Fehlschlag als "geht hier nicht" melden — ein
    // einzelner Fehler kann ein Netzaussetzer oder ein Tippfehler sein.
    const list = loadUnavailable().filter(u => !u.resolved && u.failCount >= 2)
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
