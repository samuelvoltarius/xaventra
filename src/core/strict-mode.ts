/**
 * Strict Implementation Mode
 * 
 * Toggle-able mode that forces Nova to write complete, production-ready code
 * without placeholders, TODOs, or shortcuts.
 * 
 * Activated via /strict slash command.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data')
const STRICT_FILE = join(DATA_DIR, 'strict-mode.json')

interface StrictState {
    enabled: boolean
    enabledAt?: string
    enabledBy?: string
}

let state: StrictState = { enabled: false }

// Load on module init
try {
    if (existsSync(STRICT_FILE)) {
        state = JSON.parse(readFileSync(STRICT_FILE, 'utf-8'))
    }
} catch { /* fresh start */ }

function save(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(STRICT_FILE, JSON.stringify(state, null, 2))
    } catch { /* non-critical */ }
}

/** Check if strict mode is active */
export function isStrictMode(): boolean {
    return state.enabled
}

/** Toggle strict mode on/off */
export function toggleStrictMode(user?: string): { enabled: boolean; message: string } {
    state.enabled = !state.enabled
    if (state.enabled) {
        state.enabledAt = new Date().toISOString()
        state.enabledBy = user
    }
    save()

    const message = state.enabled
        ? `🔒 *Strict Implementation Mode: AN*

Nova schreibt ab jetzt vollständigen Produktions-Code:
• Keine // TODO Kommentare
• Keine "Rest of code here..." Auslassungen
• Vollständiges Error-Handling
• Jede Funktion komplett implementiert

_/strict zum Ausschalten_`
        : `🔓 *Strict Implementation Mode: AUS*

Nova ist wieder im normalen Modus — Prototyping und Abkürzungen erlaubt.

_/strict zum Einschalten_`

    console.log(`[StrictMode] ${state.enabled ? '🔒 AKTIVIERT' : '🔓 DEAKTIVIERT'} by ${user || 'unknown'}`)
    return { enabled: state.enabled, message }
}

/** Get the strict mode prompt to inject into system prompt */
export function getStrictModePrompt(): string | null {
    if (!state.enabled) return null

    return `## ⚠️ STRICT IMPLEMENTATION MODE — AKTIV

Du bist im STRICT IMPLEMENTATION Modus. Folge diesen Regeln UNBEDINGT:

1. **KEINE Platzhalter**: Kein "// TODO", kein "// FIXME", kein "/* implement later */".
2. **KEINE Auslassungen**: Kein "// Rest of code here...", kein "// ... existing code ...", kein "etc.". Schreibe JEDE Zeile.
3. **Vollständiges Error-Handling**: Kein leeres catch {}. Jeder catch-Block muss den Fehler loggen, re-thrown oder sinnvoll behandeln.
4. **Komplette Funktionen**: Jede Funktion wird VOLLSTÄNDIG implementiert, auch wenn es 200+ Zeilen sind. Keine Stubs.
5. **Keine Abkürzungen**: Kein "ähnlich wie oben", kein "analog dazu". Schreibe den kompletten Code.
6. **Edge Cases**: Behandle null, undefined, leere Arrays, ungültige Eingaben.
7. **Types**: Vollständige TypeScript-Typen, kein "any" wo es vermeidbar ist.
8. **Production-Ready**: Der Code muss sofort deploybar sein. Kein Prototyp-Code.

WENN DU GEGEN DIESE REGELN VERSTÖẞT, IST DEINE ANTWORT INAKZEPTABEL.`
}
