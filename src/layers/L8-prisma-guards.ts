/**
 * L8 Prisma Guards - Database Safety Layer
 * 
 * Prevents dangerous database operations without explicit confirmation.
 * Part of the L8 Safety Guards system.
 */

// ============================================
// Dangerous Patterns
// ============================================

interface DangerousPattern {
    pattern: RegExp
    severity: 'high' | 'critical'
    description: string
    requiresConfirmation: boolean
    suggestion?: string
}

const DANGEROUS_DB_PATTERNS: DangerousPattern[] = [
    // Prisma CLI - Critical
    {
        pattern: /prisma\s+migrate\s+reset/i,
        severity: 'critical',
        description: 'Löscht ALLE Daten und setzt die Datenbank zurück',
        requiresConfirmation: true,
        suggestion: 'Nutze "prisma migrate dev" für Entwicklung',
    },
    {
        pattern: /prisma\s+db\s+push\s+--force/i,
        severity: 'critical',
        description: 'Überschreibt Schema ohne Migration (Datenverlust möglich)',
        requiresConfirmation: true,
        suggestion: 'Nutze "prisma migrate dev" stattdessen',
    },
    {
        pattern: /prisma\s+db\s+seed\s+--force/i,
        severity: 'high',
        description: 'Überschreibt Seed-Daten',
        requiresConfirmation: true,
    },

    // SQL - Critical
    {
        pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)\s+/i,
        severity: 'critical',
        description: 'Löscht Tabelle/Datenbank permanent',
        requiresConfirmation: true,
    },
    {
        pattern: /TRUNCATE\s+(TABLE\s+)?/i,
        severity: 'critical',
        description: 'Löscht ALLE Daten aus Tabelle',
        requiresConfirmation: true,
    },
    {
        pattern: /DELETE\s+FROM\s+\w+\s*;/i,
        severity: 'critical',
        description: 'DELETE ohne WHERE - löscht ALLE Zeilen',
        requiresConfirmation: true,
        suggestion: 'Füge eine WHERE-Klausel hinzu',
    },
    {
        pattern: /DELETE\s+FROM\s+\w+\s+WHERE\s+1\s*=\s*1/i,
        severity: 'critical',
        description: 'DELETE mit WHERE 1=1 - löscht ALLE Zeilen',
        requiresConfirmation: true,
    },
    {
        pattern: /UPDATE\s+\w+\s+SET\s+[^W]+;$/i,
        severity: 'critical',
        description: 'UPDATE ohne WHERE - ändert ALLE Zeilen',
        requiresConfirmation: true,
        suggestion: 'Füge eine WHERE-Klausel hinzu',
    },

    // Dangerous Prisma Operations
    {
        pattern: /\.deleteMany\(\s*\{\s*\}\s*\)/i,
        severity: 'critical',
        description: 'deleteMany({}) löscht ALLE Einträge',
        requiresConfirmation: true,
        suggestion: 'Füge einen Filter hinzu: deleteMany({ where: {...} })',
    },
    {
        pattern: /\.updateMany\(\s*\{\s*\}\s*,/i,
        severity: 'high',
        description: 'updateMany({}) ändert ALLE Einträge',
        requiresConfirmation: true,
    },

    // Prisma Studio (data exposure)
    {
        pattern: /prisma\s+studio/i,
        severity: 'high',
        description: 'Öffnet Datenbank-Browser (Daten sichtbar)',
        requiresConfirmation: true,
        suggestion: 'Nur in Entwicklung verwenden, nicht in Produktion',
    },

    // MongoDB specific
    {
        pattern: /db\.\w+\.drop\(\)/i,
        severity: 'critical',
        description: 'MongoDB: Collection löschen',
        requiresConfirmation: true,
    },
    {
        pattern: /db\.dropDatabase\(\)/i,
        severity: 'critical',
        description: 'MongoDB: Gesamte Datenbank löschen',
        requiresConfirmation: true,
    },
]

// ============================================
// Safety Check Result
// ============================================

export interface DatabaseSafetyResult {
    safe: boolean
    blocked: boolean
    severity?: 'high' | 'critical'
    reason?: string
    suggestion?: string
    requiresConfirmation: boolean
    confirmationPrompt?: string
}

// ============================================
// Main Check Function
// ============================================

/**
 * Check if a command/code contains dangerous database operations
 */
export function checkDatabaseSafety(input: string): DatabaseSafetyResult {
    for (const pattern of DANGEROUS_DB_PATTERNS) {
        if (pattern.pattern.test(input)) {
            return {
                safe: false,
                blocked: pattern.severity === 'critical',
                severity: pattern.severity,
                reason: pattern.description,
                suggestion: pattern.suggestion,
                requiresConfirmation: pattern.requiresConfirmation,
                confirmationPrompt: `⚠️ GEFÄHRLICHE DATENBANK-OPERATION:\n\n${pattern.description}\n\n${pattern.suggestion ? `💡 Empfehlung: ${pattern.suggestion}\n\n` : ''}Bist du SICHER, dass du das tun willst?\nAntworte mit "JA, DATENBANK ÄNDERN" um fortzufahren.`,
            }
        }
    }

    return {
        safe: true,
        blocked: false,
        requiresConfirmation: false,
    }
}

/**
 * Check if user confirmed a dangerous operation
 */
export function isConfirmed(userResponse: string): boolean {
    const confirmPatterns = [
        /^ja,?\s*datenbank\s+ändern$/i,
        /^yes,?\s*modify\s+database$/i,
        /^bestätigt?$/i,
        /^confirmed?$/i,
    ]
    return confirmPatterns.some(p => p.test(userResponse.trim()))
}

// ============================================
// Pending Confirmations Store
// ============================================

interface PendingConfirmation {
    userId: string
    command: string
    pattern: DangerousPattern
    timestamp: number
    expiresAt: number
}

const pendingConfirmations = new Map<string, PendingConfirmation>()

/**
 * Request confirmation for a dangerous operation
 */
export function requestConfirmation(userId: string, command: string, pattern: DangerousPattern): void {
    const TTL = 60000 // 1 minute to confirm
    pendingConfirmations.set(userId, {
        userId,
        command,
        pattern,
        timestamp: Date.now(),
        expiresAt: Date.now() + TTL,
    })
}

/**
 * Check if user has a pending confirmation
 */
export function getPendingConfirmation(userId: string): PendingConfirmation | null {
    const pending = pendingConfirmations.get(userId)
    if (!pending) return null

    if (Date.now() > pending.expiresAt) {
        pendingConfirmations.delete(userId)
        return null
    }

    return pending
}

/**
 * Clear pending confirmation after use
 */
export function clearConfirmation(userId: string): void {
    pendingConfirmations.delete(userId)
}

// ============================================
// Integration Helper
// ============================================

/**
 * Wrap a command execution with database safety checks
 */
export async function withDatabaseGuard<T>(
    userId: string,
    command: string,
    execute: () => Promise<T>,
    onBlock: (result: DatabaseSafetyResult) => void
): Promise<T | null> {
    const check = checkDatabaseSafety(command)

    if (!check.safe) {
        if (check.blocked || check.requiresConfirmation) {
            onBlock(check)
            return null
        }
    }

    return execute()
}

// ============================================
// Format for User Message
// ============================================

export function formatBlockMessage(result: DatabaseSafetyResult): string {
    const icon = result.severity === 'critical' ? '🚨' : '⚠️'

    let msg = `${icon} **DATENBANK-SCHUTZ AKTIV**\n\n`
    msg += `**Problem:** ${result.reason}\n`

    if (result.suggestion) {
        msg += `**Empfehlung:** ${result.suggestion}\n`
    }

    if (result.requiresConfirmation) {
        msg += `\n---\n`
        msg += `Um fortzufahren, antworte mit:\n`
        msg += `\`JA, DATENBANK ÄNDERN\``
    } else {
        msg += `\n❌ Diese Operation wurde blockiert.`
    }

    return msg
}

console.log('[L8 PrismaGuards] ✅ Database safety guards initialized')

export default {
    checkDatabaseSafety,
    isConfirmed,
    requestConfirmation,
    getPendingConfirmation,
    clearConfirmation,
    withDatabaseGuard,
    formatBlockMessage,
}
