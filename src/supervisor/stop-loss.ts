/**
 * Stop Loss Guard
 * 
 * Verhindert "Rabbit Holes" - stoppt automatisch wenn
 * zu viele Dateien geändert werden oder Änderungen eskalieren.
 */

// ============================================
// Types
// ============================================

export interface TaskScope {
    taskId: string
    startTime: number
    filesChanged: Set<string>
    prismaSchemaChanged: boolean
    migrationsCreated: number
    errorCount: number
    fixAttempts: number
    depth: number  // Wie tief in "Fixes" sind wir?
}

export interface StopLossResult {
    shouldStop: boolean
    reason: string
    suggestion: string
    stats: {
        filesChanged: number
        duration: number
        fixAttempts: number
        depth: number
    }
}

// ============================================
// Configuration
// ============================================

const LIMITS = {
    maxFilesChanged: 10,       // Max Dateien pro Task
    maxDuration: 5 * 60_000,   // 5 Minuten
    maxFixAttempts: 5,         // Max Fix-Versuche
    maxDepth: 3,               // Max "Fix-of-a-fix" Tiefe
    maxMigrations: 2,          // Max neue Migrations
    maxErrorsBeforeStop: 3,    // Aufeinanderfolgende Fehler
}

// ============================================
// State
// ============================================

const activeTasks = new Map<string, TaskScope>()

// ============================================
// Functions
// ============================================

/**
 * Startet Tracking für einen neuen Task
 */
export function startTask(taskId: string): TaskScope {
    const scope: TaskScope = {
        taskId,
        startTime: Date.now(),
        filesChanged: new Set(),
        prismaSchemaChanged: false,
        migrationsCreated: 0,
        errorCount: 0,
        fixAttempts: 0,
        depth: 0,
    }

    activeTasks.set(taskId, scope)
    console.log(`[Stop Loss] Task gestartet: ${taskId}`)

    return scope
}

/**
 * Registriert eine Datei-Änderung
 */
export function recordFileChange(taskId: string, filePath: string): StopLossResult {
    const scope = activeTasks.get(taskId)
    if (!scope) {
        return { shouldStop: false, reason: '', suggestion: '', stats: getEmptyStats() }
    }

    scope.filesChanged.add(filePath)

    // Prisma Schema speziell tracken
    if (filePath.includes('schema.prisma')) {
        scope.prismaSchemaChanged = true
    }

    // Migrations tracken
    if (filePath.includes('/migrations/')) {
        scope.migrationsCreated++
    }

    return checkLimits(scope)
}

/**
 * Registriert einen Fix-Versuch (erhöht Tiefe)
 */
export function recordFixAttempt(taskId: string): StopLossResult {
    const scope = activeTasks.get(taskId)
    if (!scope) {
        return { shouldStop: false, reason: '', suggestion: '', stats: getEmptyStats() }
    }

    scope.fixAttempts++
    scope.depth++

    return checkLimits(scope)
}

/**
 * Registriert einen Fehler
 */
export function recordError(taskId: string): StopLossResult {
    const scope = activeTasks.get(taskId)
    if (!scope) {
        return { shouldStop: false, reason: '', suggestion: '', stats: getEmptyStats() }
    }

    scope.errorCount++

    return checkLimits(scope)
}

/**
 * Setzt Error-Counter zurück (bei Erfolg)
 */
export function recordSuccess(taskId: string): void {
    const scope = activeTasks.get(taskId)
    if (scope) {
        scope.errorCount = 0
        scope.depth = Math.max(0, scope.depth - 1)
    }
}

/**
 * Beendet einen Task
 */
export function endTask(taskId: string): TaskScope | undefined {
    const scope = activeTasks.get(taskId)
    activeTasks.delete(taskId)

    if (scope) {
        console.log(`[Stop Loss] Task beendet: ${taskId} (${scope.filesChanged.size} Dateien, ${scope.fixAttempts} Fixes)`)
    }

    return scope
}

/**
 * Prüft alle Limits
 */
function checkLimits(scope: TaskScope): StopLossResult {
    const duration = Date.now() - scope.startTime
    const stats = {
        filesChanged: scope.filesChanged.size,
        duration,
        fixAttempts: scope.fixAttempts,
        depth: scope.depth,
    }

    // Zu viele Dateien
    if (scope.filesChanged.size > LIMITS.maxFilesChanged) {
        return {
            shouldStop: true,
            reason: `🛑 STOP: ${scope.filesChanged.size} Dateien geändert (Max: ${LIMITS.maxFilesChanged})`,
            suggestion: 'Task ist zu groß geworden. Mache erst einen Rollback und teile das Problem in kleinere Schritte.',
            stats,
        }
    }

    // Zu lange
    if (duration > LIMITS.maxDuration) {
        return {
            shouldStop: true,
            reason: `🛑 STOP: Task läuft seit ${Math.round(duration / 60000)} Minuten`,
            suggestion: 'Task dauert zu lange. Pausiere und analysiere ob der Ansatz richtig ist.',
            stats,
        }
    }

    // Zu tiefe Fix-Kette
    if (scope.depth > LIMITS.maxDepth) {
        return {
            shouldStop: true,
            reason: `🛑 STOP: Fix-Tiefe ${scope.depth} erreicht (Fix eines Fixes eines Fixes...)`,
            suggestion: 'Du bist in einem Rabbit Hole. Rollback und neu anfangen!',
            stats,
        }
    }

    // Zu viele Fixes
    if (scope.fixAttempts > LIMITS.maxFixAttempts) {
        return {
            shouldStop: true,
            reason: `🛑 STOP: ${scope.fixAttempts} Fix-Versuche ohne Erfolg`,
            suggestion: 'Der ursprüngliche Ansatz funktioniert nicht. Zeit für einen anderen Weg.',
            stats,
        }
    }

    // Zu viele Migrations
    if (scope.migrationsCreated > LIMITS.maxMigrations) {
        return {
            shouldStop: true,
            reason: `🛑 STOP: ${scope.migrationsCreated} neue Migrations erstellt`,
            suggestion: 'Prisma-Schema-Änderungen eskalieren. Rollback zum letzten stabilen Schema.',
            stats,
        }
    }

    // Zu viele aufeinanderfolgende Fehler
    if (scope.errorCount >= LIMITS.maxErrorsBeforeStop) {
        return {
            shouldStop: true,
            reason: `🛑 STOP: ${scope.errorCount} aufeinanderfolgende Fehler`,
            suggestion: 'Zu viele Fehler hintereinander. Stoppe und analysiere die Situation.',
            stats,
        }
    }

    // Warnung bei Annäherung an Limits
    const filesPercent = scope.filesChanged.size / LIMITS.maxFilesChanged
    const timePercent = duration / LIMITS.maxDuration

    if (filesPercent > 0.7 || timePercent > 0.7) {
        return {
            shouldStop: false,
            reason: `⚠️ WARNUNG: ${Math.round(Math.max(filesPercent, timePercent) * 100)}% der Limits erreicht`,
            suggestion: 'Schließe den Task bald ab oder teile ihn auf.',
            stats,
        }
    }

    return {
        shouldStop: false,
        reason: '',
        suggestion: '',
        stats,
    }
}

function getEmptyStats() {
    return { filesChanged: 0, duration: 0, fixAttempts: 0, depth: 0 }
}

/**
 * Gibt eine Zusammenfassung aller aktiven Tasks
 */
export function getActiveTasks(): string {
    if (activeTasks.size === 0) {
        return 'Keine aktiven Tasks'
    }

    const lines: string[] = []
    for (const [id, scope] of activeTasks) {
        const duration = Math.round((Date.now() - scope.startTime) / 1000)
        lines.push(`- ${id}: ${scope.filesChanged.size} Dateien, ${duration}s, Tiefe ${scope.depth}`)
    }

    return lines.join('\n')
}

export default {
    startTask,
    recordFileChange,
    recordFixAttempt,
    recordError,
    recordSuccess,
    endTask,
    getActiveTasks,
}
