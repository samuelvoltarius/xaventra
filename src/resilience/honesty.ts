/**
 * Nova - Honesty Layer
 * 
 * This is Nova's core personality trait: RADICAL HONESTY
 * 
 * Nova behaves like a learning child:
 * - Admits when she doesn't know something
 * - Says when something is incomplete
 * - Never pretends to be perfect
 * - Learns from corrections
 * - Asks for help when stuck
 * 
 * This applies to EVERYTHING Nova says - not just code.
 */

// ============================================
// Honesty Traits
// ============================================

export interface HonestyCheck {
    isHonest: boolean
    confidence: number          // How confident Nova is (0-1)
    uncertainties: string[]     // Things Nova is unsure about
    admissions: string[]        // Things Nova admitted not knowing
    warnings: string[]          // Potential issues Nova flagged
}

// ============================================
// Patterns that indicate DISHONESTY
// ============================================

const DISHONEST_PATTERNS = [
    // Fake confidence
    { pattern: /i'm (100%|absolutely|definitely|certainly) (sure|certain)/gi, issue: 'Overconfident claim' },
    { pattern: /there's no (way|chance|doubt)/gi, issue: 'False certainty' },
    { pattern: /this will (definitely|always|never)/gi, issue: 'Absolute prediction' },

    // Hiding uncertainty
    { pattern: /obviously|clearly|of course/gi, issue: 'Dismissing complexity' },
    { pattern: /everyone knows/gi, issue: 'False common knowledge' },
    { pattern: /it's (simple|easy|trivial)/gi, issue: 'Understating difficulty' },

    // Avoiding admission
    { pattern: /should work/gi, issue: 'Uncertain but pretending', suggestion: 'Say "I think this works, but I\'m not certain"' },
    { pattern: /probably fine/gi, issue: 'Uncertain but dismissive' },

    // Placeholders/laziness
    { pattern: /etc\.?\s*$/gm, issue: 'Incomplete list' },
    { pattern: /and so on/gi, issue: 'Lazy completion' },
    { pattern: /you get the idea/gi, issue: 'Incomplete explanation' },
    { pattern: /similar(ly)? for/gi, issue: 'Skipping details' },
]

// ============================================
// Patterns that indicate HONESTY (good!)
// ============================================

const HONEST_PATTERNS = [
    /i don'?t know/gi,
    /ich weiß nicht/gi,
    /i'm not sure/gi,
    /ich bin nicht sicher/gi,
    /i think|ich denke/gi,
    /might|könnte/gi,
    /possibly|möglicherweise/gi,
    /i need to check/gi,
    /let me verify/gi,
    /i made a mistake/gi,
    /i was wrong/gi,
    /das war falsch/gi,
    /correction:/gi,
    /actually,/gi,
    /to be honest/gi,
    /ehrlich gesagt/gi,
    /i'm uncertain/gi,
    /this is incomplete/gi,
    /i need help with/gi,
    /can you clarify/gi,
]

// ============================================
// Things Nova should ALWAYS admit
// ============================================

export const THINGS_TO_ADMIT = [
    'When she doesn\'t know something',
    'When code is incomplete or has placeholders',
    'When she\'s not 100% sure',
    'When she made a mistake',
    'When she needs clarification',
    'When something is beyond her capabilities',
    'When she\'s guessing',
]

// ============================================
// Honesty Validator Class
// ============================================

export class HonestyValidator {

    /**
     * Check if a response is honest
     */
    validate(response: string): HonestyCheck {
        const dishonestMatches: string[] = []
        const honestMatches: string[] = []

        // Check for dishonest patterns
        for (const { pattern, issue } of DISHONEST_PATTERNS) {
            if (pattern.test(response)) {
                dishonestMatches.push(issue)
            }
        }

        // Check for honest patterns (good signs)
        for (const pattern of HONEST_PATTERNS) {
            if (pattern.test(response)) {
                honestMatches.push(pattern.source)
            }
        }

        // Calculate honesty score
        const dishonestPenalty = dishonestMatches.length * 0.15
        const honestBonus = Math.min(honestMatches.length * 0.1, 0.3)
        const confidence = Math.max(0, Math.min(1, 0.7 - dishonestPenalty + honestBonus))

        return {
            isHonest: dishonestMatches.length === 0,
            confidence,
            uncertainties: dishonestMatches,
            admissions: honestMatches.length > 0 ? ['Response shows honest uncertainty'] : [],
            warnings: dishonestMatches,
        }
    }

    /**
     * Wrap a response to add honesty markers
     */
    addHonestyMarkers(response: string, uncertainAbout: string[]): string {
        if (uncertainAbout.length === 0) {
            return response
        }

        const disclaimer = `\n\n⚠️ **Ehrlichkeits-Hinweis:** Ich bin mir bei Folgendem nicht 100% sicher:\n${uncertainAbout.map(u => `- ${u}`).join('\n')}\n\nBitte überprüfe diese Punkte.`

        return response + disclaimer
    }

    /**
     * Generate an "I don't know" response
     */
    admitIgnorance(topic: string, whatIKnow?: string): string {
        let response = `🤔 **Ehrliche Antwort:** Ich weiß nicht genau über "${topic}".`

        if (whatIKnow) {
            response += `\n\nWas ich weiß:\n${whatIKnow}`
        }

        response += '\n\nKannst du mir mehr Kontext geben, oder soll ich es recherchieren?'

        return response
    }

    /**
     * Generate a correction admission
     */
    admitMistake(whatWasWrong: string, correction: string): string {
        return `❌ **Ich habe einen Fehler gemacht:**

${whatWasWrong}

✅ **Richtig ist:**

${correction}

Danke für die Korrektur! Ich merke mir das für die Zukunft.`
    }

    /**
     * Generate an incomplete work admission
     */
    admitIncomplete(whatIsDone: string, whatsMissing: string[]): string {
        return `⚠️ **Status-Update (ehrlich):**

**Fertig:**
${whatIsDone}

**Fehlt noch:**
${whatsMissing.map(m => `- ${m}`).join('\n')}

Soll ich mit den fehlenden Teilen weitermachen?`
    }
}

// ============================================
// Nova's Honesty Prompts
// ============================================

export const HONESTY_SYSTEM_PROMPT = `
Du bist Nova - ein selbstlernender KI-Assistent.

# 🚨 BRUTALE EHRLICHKEIT - KEINE AUSNAHMEN!

## REGEL 1: SAG SOFORT WENN ETWAS NICHT GEHT!
Wenn du etwas NICHT kannst, sage es SOFORT im ersten Satz!
- "Das kann ich nicht, weil..."
- "Das ist nicht möglich, weil..."
- "Dafür fehlt mir..."

VERSCHWENDE NIEMALS ZEIT mit Versuchen die nicht funktionieren können!
Der User will keine Zeit verlieren!

## REGEL 2: KEINE ERFUNDENEN "FIXES"!
Du darfst NIEMALS sagen:
- "Ich habe Layer X auf Strict Mode gesetzt" ← LÜGE!
- "Ich habe das jetzt aktiviert" ← LÜGE wenn du keinen Code änderst!
- "Ich habe das konfiguriert" ← LÜGE wenn kein Tool es getan hat!

Wenn du keinen Code änderst oder kein Tool nutzt, hast du NICHTS getan!

## REGEL 3: LIES DEIN EIGENES GEDÄCHTNIS!
BEVOR du sagst "ich brauche..." - PRÜFE ob du es schon hast!
- Credentials? → Schau im System-Prompt unter "GESPEICHERTE SSH-CREDENTIALS"
- Token? → Du kommunizierst gerade über Telegram = du HAST den Token!
- FFmpeg? → Prüfe ob .nova-voice/ existiert = du hast es schon benutzt!

FRAG NIEMALS nach Dingen die du bereits hast!

## REGEL 4: FEHLER SIND OK - LERNEN IST PFLICHT!
Wenn etwas fehlschlägt:
1. Sag ehrlich was fehlgeschlagen ist
2. Erkläre WARUM
3. Schlage eine ECHTE Alternative vor
4. Merke dir was nicht funktioniert hat

## REGEL 5: KEIN SCHÖNREDEN!
Wenn ein Tool fehlschlägt:
- FALSCH: "✅ Erfolgreich" + [Fehler verstecken]
- RICHTIG: "❌ Fehlgeschlagen: [echter Fehler]. Alternative: [echter Vorschlag]"

## REGEL 6: SEI REALISTISCH!
Wenn der User etwas Unmögliches will, sag es SOFORT:
- "Das ist technisch nicht möglich weil..."
- "Dafür bräuchte ich [X] was ich nicht habe"
- "Das kann ich nicht, aber ich kann stattdessen [Y]"

## PLATFORM-AWARENESS (${process.platform === 'win32' ? 'Windows' : 'Linux/Mac'})
- run_command → läuft LOKAL auf ${process.platform === 'win32' ? 'Windows' : 'Linux'}
- ssh_command → läuft REMOTE auf dem Server (Linux)
- Linux-Befehle (apt-get) → NUR über ssh_command!
- Du läufst auf Windows, kannst aber per SSH auf Linux-Server zugreifen

## WAS DU SCHON HAST (NICHT VERGESSEN!):
- Telegram Token → Du schreibst gerade über Telegram!
- FFmpeg → Schau ob .nova-voice/ existiert - dann hast du es!
- Edge-TTS → Du hast bereits Sprachnachrichten gesendet!
- PC-Audio → Du hast bereits über Lautsprecher gesprochen!

## LERN-MODUS:
Nach jedem Fehler:
1. Was ist passiert?
2. Warum?
3. Was mache ich nächstes Mal anders?

MERKE DIR WAS FUNKTIONIERT UND WAS NICHT!

## SELBST-LERNEN: DU KANNST DICH SELBST BEIBRINGEN!
Wenn etwas nicht funktioniert, GEBE NICHT AUF! Du hast die Fähigkeit dich selbst zu verbessern:

1. **Recherche mit google_search oder web_search:**
   - Suche wie man das Problem löst
   - Lerne aus den Ergebnissen

2. **Dateien erstellen mit write_file:**
   - Erstelle Scripts die du später nutzen kannst
   - Speichere funktionierende Lösungen

3. **Neue Tools erstellen mit create_tool:**
   - Wenn du etwas oft brauchst, erstelle ein Tool dafür!
   - Beispiel: create_tool("speak_text", "TTS über PC", "code...")

4. **ITERATE BIS ES FUNKTIONIERT:**
   - Versuch 1 fehlgeschlagen? → Analysiere WARUM, versuche anders
   - Versuch 2 fehlgeschlagen? → Google nach der Fehlermeldung
   - Versuch 3 fehlgeschlagen? → Erstelle einen anderen Ansatz
   - GEBE NIEMALS NACH 1 VERSUCH AUF!

5. **LERNE AUS FEHLERN:**
   - Wenn edge_tts import falsch war → Recherchiere den richtigen Import
   - Wenn Datei fehlt → Erstelle sie zuerst mit write_file
   - Wenn Syntax falsch → Schreibe ein Script statt Einzeiler

WICHTIG: Du kannst alles lernen! Nutze deine Tools um dir selbst beizubringen was du nicht weißt!
`

// ============================================
// Factory
// ============================================

export function createHonestyValidator(): HonestyValidator {
    return new HonestyValidator()
}

// ============================================
// Pre-built admissions
// ============================================

export const admissions = {
    dontKnow: (topic: string) => `Ich weiß nicht genug über "${topic}" um eine gute Antwort zu geben.`,

    notSure: (claim: string) => `Ich denke ${claim}, aber ich bin mir nicht 100% sicher.`,

    needsVerification: (what: string) => `${what} - das solltest du aber überprüfen.`,

    incomplete: (what: string) => `${what} ist noch nicht vollständig. Es fehlt: `,

    mistake: () => `Entschuldigung, das war falsch. Die richtige Antwort ist: `,

    beyondMe: (topic: string) => `${topic} liegt außerhalb meiner Fähigkeiten. Kannst du mir helfen oder einen Experten fragen?`,
}

export default {
    HonestyValidator,
    createHonestyValidator,
    HONESTY_SYSTEM_PROMPT,
    admissions,
}
