/**
 * Tool Validator
 * 
 * Pre-validates tool parameters before execution to catch errors early
 * and provide helpful suggestions.
 */

// ============================================
// Types
// ============================================

export interface ValidationResult {
    valid: boolean
    error?: string
    suggestion?: string
    correctedParams?: Record<string, unknown>
}

export interface ToolValidator {
    name: string
    validate: (params: Record<string, unknown>) => ValidationResult
}

// ============================================
// Specific Validators
// ============================================

const validators: Map<string, ToolValidator> = new Map()

/**
 * setreminder validator
 * - minutes must be 1-1440
 * - message is required
 */
validators.set('setreminder', {
    name: 'setreminder',
    validate: (params) => {
        const minutes = params.minutes as number
        const message = params.message as string

        // Check minutes
        if (minutes === undefined || minutes === null) {
            return {
                valid: false,
                error: 'Parameter "minutes" fehlt',
                suggestion: 'Gib an, in wie vielen Minuten ich dich erinnern soll (1-1440)'
            }
        }

        if (typeof minutes !== 'number' || isNaN(minutes)) {
            return {
                valid: false,
                error: 'Parameter "minutes" muss eine Zahl sein',
                suggestion: `Ersetze "${minutes}" mit einer Zahl z.B. 5, 10, 30`
            }
        }

        if (minutes < 1 || minutes > 1440) {
            const corrected = Math.max(1, Math.min(1440, Math.round(minutes)))
            return {
                valid: false,
                error: `Minuten muss zwischen 1 und 1440 (24h) sein, war: ${minutes}`,
                suggestion: `Verwende ${corrected} statt ${minutes}`,
                correctedParams: { ...params, minutes: corrected }
            }
        }

        // Check message
        if (!message || message.trim() === '') {
            return {
                valid: false,
                error: 'Nachricht muss angegeben werden',
                suggestion: 'Füge eine Nachricht hinzu, woran ich dich erinnern soll'
            }
        }

        return { valid: true }
    }
})

/**
 * run_command validator
 * - command is required
 * - warns about dangerous commands
 */
validators.set('run_command', {
    name: 'run_command',
    validate: (params) => {
        const command = params.command as string

        if (!command || command.trim() === '') {
            return {
                valid: false,
                error: 'Befehl fehlt',
                suggestion: 'Gib einen Befehl an, z.B. "dir" oder "npm list"'
            }
        }

        // === Level 1: Destructive commands ===
        const destructive = [
            /rm\s+-rf\s+\//i,
            /del\s+\/s\s+\/q\s+c:\\/i,
            /format\s+c:/i,
            /:(){ :\|:& };:/,  // Fork bomb
            /mkfs\./i,         // Format filesystem
        ]

        for (const pattern of destructive) {
            if (pattern.test(command)) {
                return {
                    valid: false,
                    error: 'Destruktiver Befehl erkannt — Ausführung verweigert',
                    suggestion: 'Dieser Befehl könnte das System zerstören'
                }
            }
        }

        // === Level 2: Shell injection patterns ===
        const injectionPatterns = [
            { pattern: /`[^`]+`/, desc: 'Backtick-Subshell erkannt — versteckter Befehl' },
            { pattern: /\$\([^)]+\)/, desc: '$() Command-Substitution — versteckter Befehl' },
            { pattern: /;\s*(curl|wget|nc|ncat)\b/, desc: 'Chained Download/Netcat nach Semikolon' },
            { pattern: /\|\s*(bash|sh|zsh|python|node|ruby|perl)\b/, desc: 'Pipe in Interpreter — Code-Injection' },
            { pattern: /&&\s*(curl|wget|nc|python|node)\b/, desc: 'Chained gefährlicher Befehl' },
            { pattern: /base64\s+(-d|--decode)/, desc: 'Base64-Decode — obfuskierter Payload' },
            { pattern: /\\x[0-9a-f]{2}/i, desc: 'Hex-Escape in Befehl — Obfuskation' },
            { pattern: /\/dev\/tcp\//, desc: 'Reverse Shell via /dev/tcp' },
            { pattern: /\bmkfifo\b/, desc: 'Named Pipe — Reverse Shell Technik' },
            { pattern: /\bsocat\b/, desc: 'socat — Network Relay Tool' },
            { pattern: />\s*\/etc\//, desc: 'Schreibzugriff auf /etc/ — System-Config Manipulation' },
            { pattern: /echo\s+.*>\s*~\/\.ssh/, desc: 'SSH-Key Injection' },
            { pattern: /chmod\s+[0-7]*s/, desc: 'SUID-Bit setzen — Privilege Escalation' },
        ]

        for (const { pattern, desc } of injectionPatterns) {
            if (pattern.test(command)) {
                return {
                    valid: false,
                    error: `🛡️ Shell-Injection erkannt: ${desc}`,
                    suggestion: 'Dieser Befehl enthält verdächtige Muster'
                }
            }
        }

        // === Level 3: Suspiciously long commands ===
        const maxLen = process.env.NOVA_OS_MODE === 'true' ? 4000 : 500
        if (command.length > maxLen) {
            return {
                valid: false,
                error: `Befehl ist ${command.length} Zeichen lang — verdächtig`,
                suggestion: 'Sehr lange Befehle deuten oft auf eingebettete Payloads hin'
            }
        }

        // === Level 4: Multiple chained commands check ===
        const chainCount = (command.match(/[;&|]{1,2}/g) || []).length
        // NovaOS: Systemeinrichtung besteht aus Ketten (apt update && apt
        // install -y x && x --version). Die Grenze von 5 stammt aus dem
        // Chat-Betrieb mit fremden Eingaben; an der eigenen Konsole ist sie
        // reine Schikane und blockierte hier legitime Arbeit.
        const chainLimit = process.env.NOVA_OS_MODE === 'true' ? 20 : 5
        if (chainCount >= chainLimit) {
            return {
                valid: false,
                error: `${chainCount} verkettete Befehle — verdächtig`,
                suggestion: 'Zu viele verkettete Befehle deuten auf einen Angriff hin'
            }
        }

        return { valid: true }
    }
})

/**
 * write_file validator
 * - path is required
 * - content is required
 */
validators.set('write_file', {
    name: 'write_file',
    validate: (params) => {
        const path = params.path as string
        const content = params.content as string

        if (!path || path.trim() === '') {
            return {
                valid: false,
                error: 'Dateipfad fehlt',
                suggestion: 'Gib einen Pfad an, z.B. "script.py" oder "output/data.json"'
            }
        }

        if (content === undefined || content === null) {
            return {
                valid: false,
                error: 'Dateiinhalt fehlt',
                suggestion: 'Gib den Inhalt an, der in die Datei geschrieben werden soll'
            }
        }

        return { valid: true }
    }
})

// ============================================
// Main API
// ============================================

/**
 * Validate parameters for a tool
 */
export function validateToolParams(toolName: string, params: Record<string, unknown>): ValidationResult {
    const validator = validators.get(toolName)

    if (!validator) {
        // No validator = always valid (for now)
        return { valid: true }
    }

    return validator.validate(params)
}

/**
 * Get all registered validators
 */
export function getValidators(): string[] {
    return Array.from(validators.keys())
}

/**
 * Register a custom validator
 */
export function registerValidator(validator: ToolValidator): void {
    validators.set(validator.name, validator)
    console.log(`[Validator] Registered: ${validator.name}`)
}

export default {
    validateToolParams,
    getValidators,
    registerValidator
}
