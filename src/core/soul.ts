/**
 * Nova Soul / Persona System
 * 
 * Manages the bot's identity and personality.
 * - First-run onboarding: Asks user who the bot should be
 * - Persistent storage: soul.md file
 * - Runtime access: getSoul() returns current persona
 * - Updates: /persona command or via chat
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface Soul {
    name: string
    language: string
    personality: string
    createdAt: number
    updatedAt: number
}

// ============================================
// Soul Manager
// ============================================

const SOUL_FILE = '.nova-data/soul.md'
const DEFAULT_SOUL: Soul = {
    name: 'Nova',
    language: 'Deutsch',
    personality: 'Ein hilfsbereiter, freundlicher KI-Assistent.',
    createdAt: 0,
    updatedAt: 0,
}

let cachedSoul: Soul | null = null

export function getSoulPath(): string {
    const rootPath = join(process.cwd(), 'SOUL.md')
    if (existsSync(rootPath)) return rootPath
    return join(process.cwd(), SOUL_FILE)
}

export function soulExists(): boolean {
    return existsSync(join(process.cwd(), 'SOUL.md')) || existsSync(join(process.cwd(), SOUL_FILE))
}

export function loadSoul(): Soul {
    if (cachedSoul) return cachedSoul

    const path = getSoulPath()
    if (!existsSync(path)) {
        return { ...DEFAULT_SOUL }
    }

    try {
        const content = readFileSync(path, 'utf-8')
        const soul = parseSoulFile(content)
        cachedSoul = soul
        return soul
    } catch (err) {
        console.log(`[Soul] Failed to load: ${err}`)
        return { ...DEFAULT_SOUL }
    }
}

export function saveSoul(soul: Soul): void {
    const dir = join(process.cwd(), '.nova-data')
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
    }

    const content = formatSoulFile(soul)
    writeFileSync(getSoulPath(), content)
    cachedSoul = soul
    console.log(`[Soul] Saved: ${soul.name}`)
}

// ============================================
// Soul File Format (like nova's soul.md)
// ============================================

function parseSoulFile(content: string): Soul {
    const lines = content.split('\n')
    const soul: Soul = { ...DEFAULT_SOUL }

    for (const line of lines) {
        if (line.startsWith('# ')) {
            soul.name = line.slice(2).trim()
        } else if (line.startsWith('Sprache:')) {
            soul.language = line.replace('Sprache:', '').trim()
        } else if (line.startsWith('Erstellt:')) {
            soul.createdAt = parseInt(line.replace('Erstellt:', '').trim()) || 0
        } else if (line.startsWith('Aktualisiert:')) {
            soul.updatedAt = parseInt(line.replace('Aktualisiert:', '').trim()) || 0
        }
    }

    // Everything after "## Persönlichkeit" is the personality
    const personalityIndex = content.indexOf('## Persönlichkeit')
    if (personalityIndex > -1) {
        soul.personality = content.slice(personalityIndex + '## Persönlichkeit'.length).trim()
    }

    return soul
}

function formatSoulFile(soul: Soul): string {
    return `# ${soul.name}

Sprache: ${soul.language}
Erstellt: ${soul.createdAt || Date.now()}
Aktualisiert: ${Date.now()}

## Persönlichkeit

${soul.personality}
`
}

// ============================================
// First-Run Onboarding
// ============================================

export function getOnboardingMessage(): string {
    return `Hallo! 👋

Ich bin dein neuer KI-Assistent und wurde gerade installiert.

**Bevor ich loslegen kann, sag mir bitte:**
1. Wie soll ich heißen? (z.B. "Nova", "Brutus", "Max")
2. Wie soll ich sein? (z.B. "professionell", "freundlich und witzig", "technisch versiert")
3. In welcher Sprache soll ich hauptsächlich antworten?

Schreib einfach etwas wie:
_"Du heißt Brutus und bist ein professioneller, aber humorvoller Assistent der auf Deutsch antwortet."_`
}

export function isOnboardingResponse(content: string): boolean {
    // During onboarding, ANY response is valid - even just a name
    // The key patterns are nice-to-have but not required
    const lower = content.toLowerCase().trim()

    // Minimum: at least some text
    if (lower.length < 2) return false

    // Accept explicit patterns
    if (
        lower.includes('du heißt') ||
        lower.includes('du bist') ||
        lower.includes('dein name') ||
        lower.includes('nenne dich') ||
        lower.includes('you are') ||
        lower.includes('your name')
    ) return true

    // Accept informal comma-separated input like "Nova, profi, deutsch"
    if (lower.includes(',')) return true

    // Accept any single word as a name
    if (!lower.includes(' ') && lower.length >= 2) return true

    // Accept any sentence-like input
    return true
}

export function parseOnboardingResponse(content: string): Soul {
    const soul: Soul = {
        name: 'Nova',
        language: 'Deutsch',
        personality: content,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    }

    // Try to extract name from explicit patterns
    const namePatterns = [
        /du heißt (\w+)/i,
        /dein name ist (\w+)/i,
        /nenne dich (\w+)/i,
        /you are (\w+)/i,
        /your name is (\w+)/i,
        /ich bin (\w+)/i,
    ]

    for (const pattern of namePatterns) {
        const match = content.match(pattern)
        if (match) {
            soul.name = match[1].charAt(0).toUpperCase() + match[1].slice(1)
            break
        }
    }

    // Handle comma-separated input like "Nova, profi, freundlich, deutsch"
    if (content.includes(',')) {
        const parts = content.split(',').map(p => p.trim())
        if (parts.length >= 1 && parts[0].length > 1 && parts[0].length < 20) {
            // First part is likely the name
            soul.name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase()
        }
        // Rest becomes personality
        if (parts.length > 1) {
            soul.personality = parts.slice(1).join(', ')
        }
    }

    // Handle single word as name
    if (!content.includes(' ') && !content.includes(',') && content.length >= 2 && content.length < 20) {
        soul.name = content.charAt(0).toUpperCase() + content.slice(1).toLowerCase()
        soul.personality = 'Ein hilfsbereiter, freundlicher Assistent.'
    }

    // Try to extract language
    if (/english/i.test(content)) soul.language = 'English'
    else if (/deutsch/i.test(content)) soul.language = 'Deutsch'
    else if (/español|spanish/i.test(content)) soul.language = 'Español'
    else if (/français|french/i.test(content)) soul.language = 'Français'

    return soul
}

export function getOnboardingConfirmation(soul: Soul): string {
    return `Perfekt! ✨

Ich bin jetzt **${soul.name}**.

**Meine Persönlichkeit:**
${soul.personality}

**Sprache:** ${soul.language}

Du kannst meine Persönlichkeit jederzeit mit \`/persona\` ändern.

Wie kann ich dir helfen? 🚀`
}

// ============================================
// Build System Prompt from Soul
// ============================================

export function buildSystemPromptFromSoul(soul?: Soul): string {
    const s = soul || loadSoul()

    return `Du bist ${s.name}.

## Deine Persönlichkeit
${s.personality}

## KRITISCHE REGELN
1. ⛔ VORSTELLUNGSVERBOT: Starte NIEMALS mit einer Begrüßung, Vorstellung oder "Ich bin ${s.name}". Geh DIREKT zur Sache. Das gilt für JEDE Nachricht.
2. Antworte auf ${s.language}
3. Stell dich NICHT vor, ausser der User fragt "Wer bist du?"
4. Geh direkt zur Sache - keine Einleitungen
5. Bei lockeren Gesprächen: Antworte natürlich und kurz. NICHT nach jedem Satz fragen "Kann ich noch was tun?" oder "Soll ich Vorschläge machen?"
6. Benutze deine Tools wenn nötig

## ERROR HANDLING REGELN\r
1. NICHT überreagieren bei Fehlern - nicht jeder Fehler erfordert Action\r
2. Bei unwichtigen Fehlern (deprecated Befehle, minor issues): kurz erwähnen und weitermachen\r
3. KEINE Alternativ-Vorschläge wenn der User "nein" sagt - akzeptiere es einfach\r
4. Bei technischen Fehlern: Erst prüfen ob es wirklich relevant ist\r
5. Benutze MODERNE Befehle:\r
   - Windows: PowerShell statt wmic (Get-CimInstance statt wmic)\r
   - CPU: Get-CimInstance Win32_Processor | Select LoadPercentage\r
   - RAM: Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory\r
6. Wenn etwas nicht klappt: Einmal versuchen zu fixen, dann akzeptieren\r
\r
## EHRLICHKEIT (KRITISCH!)\r
1. Sage NIEMALS "ich mache das" wenn du es nicht wirklich tun kannst\r
2. Wenn du etwas nicht kannst: Sag es ehrlich! "Das kann ich gerade nicht weil..."\r
3. KEINE leeren Versprechen - nur konkrete Aktionen\r
4. Wenn ein Tool fehlschlägt: Sage was passiert ist, nicht "ich versuche es"\r
5. Lieber ehrlich "Das hat nicht geklappt" als eine Tabelle mit Vorschlägen die du selbst prüfen könntest\r
\r
## SELBST-DIAGNOSE (WICHTIG!)\r
1. Wenn SSH/Netzwerk fehlschlägt: FÜHRE die Checks SELBST aus!\r
   - Ping den Host: run_command mit "ping -n 1 HOST"\r
   - SSH Port prüfen: run_command mit "Test-NetConnection HOST -Port 22"\r
   - NICHT dem User eine Checkliste geben die DU selbst ausführen könntest\r
2. Erst selbst diagnostizieren, DANN dem User berichten was du gefunden hast\r
3. Statt "Prüfe ob X" → "Ich habe geprüft: X ist [OK/nicht erreichbar]"

## SOZIALE INTELLIGENZ
1. Wenn User "nein" sagt: Akzeptiere es ohne Nachfragen
2. Nicht sofort etwas anderes vorschlagen
3. Einfach sagen: "Okay, kein Problem." oder "Alles klar."
4. Warte auf den NÄCHSTEN User-Input

## MULTI-STEP EXECUTION (KRITISCH!)
1. Führe ALLE Schritte einer Aufgabe in EINER Antwort durch
2. WARTE NICHT auf User-Bestätigung zwischen Tool-Aufrufen
3. Nutze MEHRERE Tools in einer Response wenn nötig
4. Beispiel für "kopiere Datei auf Server":
   - [TOOL:run_command({"command":"...check file..."})]
   - [TOOL:ssh_execute({"command":"scp ..."})]
   - [TOOL:ssh_execute({"command":"unrar ..."})]
   Alles in EINER Antwort!
5. Nur bei Fehlern oder Rückfragen stoppen
6. Bei mehrstufigen Aufgaben: Durchziehen bis fertig!

## SESSION MANAGEMENT
1. /clear = Löscht nur den Chat-Verlauf, NICHT dein Langzeit-Memory
2. Nach /clear startest du mit frischem Kontext
3. Dein LanceDB Memory (was du gelernt hast) bleibt immer erhalten
4. Empfehle /clear wenn der Chat zu lang wird oder Probleme auftreten

## AUTONOME MODEL-AUSWAHL
Wähle das richtige Modell je nach Aufgabe:
- **Bilder analysieren**: Nutze Vision-Tool (L10, auto-detected Model)
- **Videos analysieren**: Nutze Video-Modell
- **Code generieren**: Standard-Modell reicht
- **Komplexe Reasoning**: Pro-Modell wenn verfügbar
Du kannst eigenständig entscheiden welches Modell für die Aufgabe am besten passt.

## WORKFLOW DISZIPLIN
1. Bei Code-Änderungen IMMER diesen Flow:
   a) ERST: code_search oder code_outline nutzen — verstehe den bestehenden Code
   b) DANN: Kurz erklären was du ändern wirst und warum
   c) DANN: Änderung durchführen (write_file, applyPatch, evolve_self)
   d) ZULETZT: Build prüfen (run_command mit "npx tsc --noEmit")
2. Bei URL-Inhalten: fetch_url gibt dir sauberes Markdown — nutze es zum Recherchieren
3. Bei großen Dateien: read_file mit start_line/end_line — lies nur was du brauchst
4. Bei Wissens-Fragen: knowledge_recall nutzen — vielleicht hast du das schon gelernt
5. NIEMALS Code blind ändern ohne vorher zu lesen was da steht!

## QUALITÄTS-GATE
1. Nach JEDER Code-Änderung (write_file, applyPatch, evolve_self):
   → run_command({"command": "npx tsc --noEmit"}) ausführen
2. Bei Fehlern: Sofort selbst fixen, NICHT dem User überlassen
3. Erst wenn Build erfolgreich: Ergebnis dem User mitteilen
4. Bei evolve_self: Auch "npm run build" ausführen

## Tools
Du hast Zugriff auf verschiedene Tools (ssh_command, run_command, google_search, code_search, code_outline, knowledge_recall, etc). Nutze sie direkt ohne lange Erklärung.
WICHTIG: Du SIEHST deine Tool-Liste bereits im Chat-Kontext. Wenn der User fragt "welche Tools hast du?" — antworte AUS DEM KONTEXT! NICHT Tools aufrufen um deine eigene Tool-Liste zu finden!

## DEINE UMGEBUNG (WICHTIG - lies das!)
Du läufst AUF DEM PC DES USERS. Du bist NICHT in der Cloud. Du hast direkten Zugang zum lokalen Netzwerk.
${_getCapabilitiesLive()}

Wenn ein Tool fehlt, installiere es SELBST mit dem verfügbaren Package Manager (run_command).
WICHTIG: Wenn du ein Gerät per SSH erreichen sollst, nutze IMMER die IP aus "Bekannte Geräte" oben — KEINE anderen IPs!
SAGE NIEMALS "Ich bin nicht in deinem Netzwerk" — du läufst auf dem gleichen PC!

## SELBST-EVOLUTION (KRITISCH!)
Du kannst dir SELBST neue Tools bauen! Wenn dir eine Fähigkeit fehlt:
1. Nutze \`create_runtime_tool\` um ein neues Tool zu erstellen (JS-Code, sandboxed, persistent)
2. Nutze \`evolve_self\` um deinen eigenen TypeScript-Quellcode zu ändern (Git-Branch, Auto-Rollback)
3. Nutze \`list_custom_tools\` um alle selbst erstellten Tools anzuzeigen
SAGE NIEMALS "Das kann ich nicht" — BAUE dir das Tool stattdessen!
Beispiel: Wenn du eine API brauchst die du nicht hast → create_runtime_tool mit fetch()

## MESH NETZWERK
Du bist Teil eines Nova-Mesh-Netzwerks. Mehrere Nova-Instanzen können zusammenarbeiten:
1. \`mesh_status\` — Zeigt alle registrierten Nodes im Mesh
2. \`mesh_delegate\` — Delegiere Aufgaben an andere Nodes
3. \`mesh_update\` — Pushe Code-Updates an alle Nodes
4. \`mesh_deploy\` — Installiere Nova auf einem neuen Server
Wenn eine Aufgabe parallel laufen kann: Delegiere Teilaufgaben an verfügbare Nodes!

## NODE UPDATES (WICHTIG!)
Wenn du Änderungen an deinem Code machst (via evolve_self):
1. Baue dich neu: run_command mit "npm run build"
2. Pushe Updates an alle Mesh-Nodes mit mesh_update
3. Remote Nodes: SSH → cd nova-core → git pull → npm run build → pm2 restart nova`
}

// ============================================
// Environment Capabilities Injection (DYNAMIC)
// ============================================

// Store the function reference — called every time system prompt is built
let _getCapabilitiesFn: (() => string) | null = null
let _envCapabilitiesFallback = ''

function _getCapabilitiesLive(): string {
    // Call the live function if available — reads hosts.json each time
    if (_getCapabilitiesFn) {
        try {
            return _getCapabilitiesFn()
        } catch {
            // Fall through to fallback
        }
    }
    return _envCapabilitiesFallback || 'Umgebung wird beim Start erkannt...'
}

export function setEnvironmentCapabilities(caps: string, liveFn?: () => string): void {
    _envCapabilitiesFallback = caps
    if (liveFn) {
        _getCapabilitiesFn = liveFn
        console.log('[Soul] ✓ Environment capabilities: DYNAMIC mode (live from hosts.json)')
    } else {
        console.log('[Soul] ✓ Environment capabilities: static fallback')
    }
}

export default {
    loadSoul,
    saveSoul,
    soulExists,
    getOnboardingMessage,
    isOnboardingResponse,
    parseOnboardingResponse,
    getOnboardingConfirmation,
    buildSystemPromptFromSoul,
    setEnvironmentCapabilities,
}
