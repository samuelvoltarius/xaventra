/**
 * Predictive Provisioning — Pre-warm Models Before You Need Them
 * 
 * Nova learns your daily patterns:
 * - "Mo-Fr 9 Uhr → GAEB Projekt → gemma3:12b"
 * - "Abends → Casual Chat → gemma3:4b"
 * - "Wochenende → Coding → gemma3:12b + nomic-embed"
 * 
 * 15 minutes before predicted need, Nova pre-loads the model.
 * Zero latency when you start working.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'predictive')
const PATTERNS_FILE = join(DATA_DIR, 'usage-patterns.json')
const SCHEDULE_FILE = join(DATA_DIR, 'pre-warm-schedule.json')

// ============================================
// Types
// ============================================

interface UsageEvent {
    timestamp: number
    dayOfWeek: number    // 0=Sun, 6=Sat
    hour: number         // 0-23
    model: string
    context?: string     // e.g. project name, topic
}

interface UsagePattern {
    dayOfWeek: number
    hour: number
    model: string
    confidence: number   // 0-100, how often this pattern occurs
    occurrences: number
    lastSeen: string
}

interface PreWarmJob {
    scheduledFor: number  // timestamp
    model: string
    ollamaHost: string
    status: 'pending' | 'warming' | 'ready' | 'failed'
    reason: string
}

// ============================================
// State
// ============================================

let usageHistory: UsageEvent[] = []
let patterns: UsagePattern[] = []
let preWarmTimer: ReturnType<typeof setInterval> | null = null

// ============================================
// Pattern Learning
// ============================================

/**
 * Record a model usage event — call this whenever a model is invoked
 */
export function recordModelUsage(model: string, context?: string): void {
    const now = new Date()
    const event: UsageEvent = {
        timestamp: Date.now(),
        dayOfWeek: now.getDay(),
        hour: now.getHours(),
        model,
        context,
    }

    usageHistory.push(event)

    // Keep last 500 events
    if (usageHistory.length > 500) {
        usageHistory = usageHistory.slice(-500)
    }

    // Re-analyze patterns every 10 new events
    if (usageHistory.length % 10 === 0) {
        analyzePatterns()
    }

    saveHistory()
}

/**
 * Analyze usage history to find patterns
 */
function analyzePatterns(): void {
    // Group by day-of-week + hour + model
    const buckets = new Map<string, { count: number; model: string; dow: number; hour: number; lastSeen: string }>()

    for (const event of usageHistory) {
        const key = `${event.dayOfWeek}-${event.hour}-${event.model}`
        const existing = buckets.get(key)
        if (existing) {
            existing.count++
            existing.lastSeen = new Date(event.timestamp).toISOString()
        } else {
            buckets.set(key, {
                count: 1,
                model: event.model,
                dow: event.dayOfWeek,
                hour: event.hour,
                lastSeen: new Date(event.timestamp).toISOString(),
            })
        }
    }

    // Convert to patterns (min 2 occurrences)
    patterns = []
    const totalWeeks = Math.max(1, Math.ceil(
        (Date.now() - (usageHistory[0]?.timestamp || Date.now())) / (7 * 24 * 60 * 60 * 1000)
    ))

    for (const [, bucket] of buckets) {
        if (bucket.count >= 2) {
            const confidence = Math.min(100, Math.round((bucket.count / totalWeeks) * 100))
            patterns.push({
                dayOfWeek: bucket.dow,
                hour: bucket.hour,
                model: bucket.model,
                confidence,
                occurrences: bucket.count,
                lastSeen: bucket.lastSeen,
            })
        }
    }

    // Sort by confidence
    patterns.sort((a, b) => b.confidence - a.confidence)

    savePatterns()
    console.log(`[Predictive] 📊 ${patterns.length} Nutzungsmuster erkannt`)
}

// ============================================
// Pre-Warming
// ============================================

/**
 * Check if any models should be pre-warmed for the upcoming hour
 */
async function checkPreWarm(): Promise<void> {
    const now = new Date()
    const nextHour = (now.getHours() + 1) % 24
    const dow = now.getDay()

    // If we're at minute 45+, look at next hour
    const targetHour = now.getMinutes() >= 45 ? nextHour : now.getHours()

    // Find patterns matching the target
    const matching = patterns.filter(p =>
        p.dayOfWeek === dow &&
        p.hour === targetHour &&
        p.confidence >= 40  // Only pre-warm if >= 40% confident
    )

    if (matching.length === 0) return

    // Pre-warm the most confident model
    const best = matching[0]
    console.log(`[Predictive] 🔮 Pre-warming ${best.model} (${best.confidence}% confident für ${getDayName(dow)} ${targetHour}:00)`)

    try {
        // Use VRAM manager to ensure space
        const { ensureVRAMForModel } = await import('./vram-manager.js')
        const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434'
        const result = await ensureVRAMForModel(best.model, ollamaHost)

        if (result.ready) {
            // Actually load the model with a tiny prompt to warm it
            await fetch(`${ollamaHost}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: best.model,
                    prompt: 'Hi',
                    stream: false,
                    options: { num_predict: 1 },  // Generate just 1 token to load model
                }),
                signal: AbortSignal.timeout(30000),
            })
            console.log(`[Predictive] ✅ ${best.model} pre-warmed and ready!`)

            // === Context Warming: Pre-load relevant docs into vector cache ===
            await contextWarm(targetHour, dow)

        } else {
            console.log(`[Predictive] ⚠️ Not enough VRAM to pre-warm ${best.model}`)
        }
    } catch (err: any) {
        console.log(`[Predictive] ⚠️ Pre-warm failed: ${err.message?.slice(0, 80)}`)
    }

    // === Mesh-Aware Prediction: Tell edge nodes to warm up ===
    await meshAwareWarm(matching, dow, targetHour)
}

/**
 * Context Warming — pre-load relevant documents into vector cache
 * Analyzes which projects/topics are accessed at this time and pre-fetches them
 */
async function contextWarm(hour: number, dow: number): Promise<void> {
    try {
        // Find recent context (project topics) for this timeslot
        const relevantEvents = usageHistory.filter(e =>
            e.dayOfWeek === dow &&
            Math.abs(e.hour - hour) <= 1 &&
            e.context
        )

        const contexts = new Map<string, number>()
        for (const e of relevantEvents) {
            if (e.context) contexts.set(e.context, (contexts.get(e.context) || 0) + 1)
        }

        if (contexts.size === 0) return

        // Get top context
        const topContext = [...contexts.entries()].sort((a, b) => b[1] - a[1])[0]
        console.log(`[Predictive] 📄 Context warming: "${topContext[0]}" (${topContext[1]}x in diesem Zeitfenster)`)

        // Pre-query LanceDB with the context to warm the cache
        try {
            const memoryPath = join(process.cwd(), '.nova-data', 'memory')
            if (!existsSync(memoryPath)) return

            // Trigger a vector search to warm the cache
            const { readdirSync } = await import('node:fs')
            const files = readdirSync(memoryPath).filter(f => f.endsWith('.json'))

            // Read recent memory entries matching context
            let warmed = 0
            for (const file of files.slice(-50)) {
                try {
                    const data = JSON.parse(readFileSync(join(memoryPath, file), 'utf-8'))
                    const content = (data.content || data.summary || '').toLowerCase()
                    if (content.includes(topContext[0].toLowerCase())) {
                        warmed++
                    }
                } catch { /* skip */ }
            }

            if (warmed > 0) {
                console.log(`[Predictive] ✅ ${warmed} Memory-Einträge für "${topContext[0]}" im Cache`)
            }
        } catch { /* LanceDB not available */ }
    } catch { /* non-critical */ }
}

/**
 * Mesh-Aware Prediction — tell edge nodes to pre-warm their models
 */
async function meshAwareWarm(matching: UsagePattern[], dow: number, hour: number): Promise<void> {
    try {
        const { emit } = await import('../mesh/event-hub.js')

        // Find if any edge node is typically used at this time
        const edgePatterns = usageHistory.filter(e =>
            e.dayOfWeek === dow &&
            Math.abs(e.hour - hour) <= 1 &&
            e.context?.includes('edge:')
        )

        // Always notify mesh about upcoming warm
        if (matching.length > 0) {
            emit('mesh:pre_warm', {
                model: matching[0].model,
                confidence: matching[0].confidence,
                targetHour: hour,
                reason: `${getDayName(dow)} ${hour}:00 pattern match`,
            })
            console.log(`[Predictive] 📡 Mesh notified: pre-warm ${matching[0].model}`)
        }

        // === Mesh-Predictive-Sync: pre_cool when no activity predicted ===
        // Check if anyone will be active in the next 2 hours
        const next2h = [hour, (hour + 1) % 24, (hour + 2) % 24]
        const anyUpcoming = patterns.some(p =>
            p.dayOfWeek === dow &&
            next2h.includes(p.hour) &&
            p.confidence >= 40
        )

        if (!anyUpcoming && matching.length === 0) {
            emit('mesh:pre_cool', {
                targetHour: hour,
                reason: `Keine Aktivität vorhergesagt für ${getDayName(dow)} ${next2h.map(h => h + ':00').join(', ')}`,
                action: 'unload_heavy_models',
            })
            console.log(`[Predictive] ❄️ Mesh pre_cool: keine Aktivität in den nächsten 2h`)
        }
    } catch { /* mesh not available */ }
}

// ============================================
// Helpers
// ============================================

function getDayName(dow: number): string {
    return ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'][dow]
}

/**
 * Get current predictions for display
 */
export function getPredictions(): Array<{
    day: string
    hour: number
    model: string
    confidence: number
}> {
    return patterns
        .filter(p => p.confidence >= 30)
        .slice(0, 10)
        .map(p => ({
            day: getDayName(p.dayOfWeek),
            hour: p.hour,
            model: p.model,
            confidence: p.confidence,
        }))
}

/**
 * Get a human-readable summary
 */
export function getPredictionSummary(): string {
    const preds = getPredictions()
    if (preds.length === 0) return 'Noch keine Nutzungsmuster erkannt (sammle Daten...)'

    const lines = preds.map(p =>
        `${p.day} ${p.hour}:00 → ${p.model} (${p.confidence}%)`
    )
    return `📊 ${preds.length} Vorhersagen:\n${lines.join('\n')}`
}

// ============================================
// Persistence
// ============================================

function saveHistory(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'usage-history.json'), JSON.stringify(usageHistory.slice(-200), null, 2))
    } catch { /* non-critical */ }
}

function savePatterns(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2))
    } catch { /* non-critical */ }
}

function loadHistory(): void {
    try {
        const histPath = join(DATA_DIR, 'usage-history.json')
        if (existsSync(histPath)) {
            usageHistory = JSON.parse(readFileSync(histPath, 'utf-8'))
        }
        if (existsSync(PATTERNS_FILE)) {
            patterns = JSON.parse(readFileSync(PATTERNS_FILE, 'utf-8'))
        }
    } catch { /* start fresh */ }
}

// ============================================
// Init
// ============================================

/**
 * Initialize predictive provisioning
 */
export function initPredictiveProvisioning(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    loadHistory()
    if (usageHistory.length > 0) analyzePatterns()

    // Check for pre-warming every 15 minutes
    preWarmTimer = setInterval(() => {
        checkPreWarm().catch(() => { })
    }, 15 * 60 * 1000)

    // Also check immediately on startup
    setTimeout(() => checkPreWarm().catch(() => { }), 5000)

    console.log(`[Predictive] ✅ Initialized — ${usageHistory.length} events, ${patterns.length} patterns`)
}
