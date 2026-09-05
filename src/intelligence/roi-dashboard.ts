/**
 * ROI Dashboard — ClawWork-inspired Cost/Value Tracking
 *
 * Tracks for each task:
 * - Token cost (input + output)
 * - Time spent
 * - Value created (estimated)
 * - ROI calculation
 *
 * Nova should create more value than it costs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { estimateUsageCost } from '../core/model-pricing.js'

const DATA_DIR = join(process.cwd(), '.nova-data', 'cost-roi')

// ============================================
// Types
// ============================================

interface TaskCost {
    id: string
    task: string
    startedAt: number
    completedAt?: number
    inputTokens: number
    outputTokens: number
    toolCalls: number
    model: string
    estimatedCostUSD: number
    estimatedValueUSD: number       // What this task saved the user
    category: 'code' | 'research' | 'admin' | 'creative' | 'debug' | 'ops' | 'other'
}

interface CostDashboard {
    tasks: TaskCost[]
    totals: {
        totalCostUSD: number
        totalValueUSD: number
        totalInputTokens: number
        totalOutputTokens: number
        totalToolCalls: number
        totalTasks: number
        totalTimeMs: number
    }
    dailyStats: Record<string, { cost: number; value: number; tasks: number }>
}

// ============================================
// State
// ============================================

let dashboard: CostDashboard = {
    tasks: [],
    totals: {
        totalCostUSD: 0,
        totalValueUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalToolCalls: 0,
        totalTasks: 0,
        totalTimeMs: 0,
    },
    dailyStats: {},
}

let currentTask: TaskCost | null = null

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function load(): void {
    ensureDir()
    const path = join(DATA_DIR, 'dashboard.json')
    if (existsSync(path)) {
        try { dashboard = JSON.parse(readFileSync(path, 'utf-8')) } catch { }
    }
}

function save(): void {
    writeFileSync(join(DATA_DIR, 'dashboard.json'), JSON.stringify(dashboard, null, 2))
}

// ============================================
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    return estimateUsageCost({ model, inputTokens, outputTokens }).totalUsd
}

// ============================================
// Value Estimation
// ============================================

const VALUE_ESTIMATES: Record<string, number> = {
    // Estimated USD value per task category (developer hourly rate * estimated time saved)
    code: 15,         // ~10 min of coding = $15 at $90/hr
    debug: 20,        // Debugging is harder to do manually
    research: 10,     // Research/search tasks
    admin: 5,         // Simple admin tasks
    creative: 8,      // Writing, design
    ops: 25,          // DevOps, deployment (error-prone manually)
    other: 5,
}

function estimateValue(category: TaskCost['category'], toolCalls: number): number {
    const base = VALUE_ESTIMATES[category] || 5
    // More tool calls = more complex = more value
    const complexityMultiplier = Math.min(toolCalls * 0.5, 3)
    return base + complexityMultiplier
}

// ============================================
// Task Tracking
// ============================================

/**
 * Start tracking a new task
 */
export function startTask(task: string, category: TaskCost['category'] = 'other'): void {
    load()

    currentTask = {
        id: `t-${Date.now().toString(36)}`,
        task: task.slice(0, 200),
        startedAt: Date.now(),
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        model: 'default',
        estimatedCostUSD: 0,
        estimatedValueUSD: 0,
        category,
    }
}

/**
 * Record token usage for current task
 */
export function recordTokens(inputTokens: number, outputTokens: number, model: string): void {
    if (!currentTask) return

    currentTask.inputTokens += inputTokens
    currentTask.outputTokens += outputTokens
    currentTask.model = model
    currentTask.estimatedCostUSD = estimateCost(model, currentTask.inputTokens, currentTask.outputTokens)
}

/**
 * Record a tool call
 */
export function recordToolCall(): void {
    if (!currentTask) return
    currentTask.toolCalls++
}

/**
 * Complete current task
 */
export function completeTask(): TaskCost | null {
    if (!currentTask) return null

    currentTask.completedAt = Date.now()
    currentTask.estimatedValueUSD = estimateValue(currentTask.category, currentTask.toolCalls)

    // Update dashboard
    dashboard.tasks.push(currentTask)
    if (dashboard.tasks.length > 500) {
        dashboard.tasks = dashboard.tasks.slice(-500) // Keep last 500
    }

    const duration = currentTask.completedAt - currentTask.startedAt
    dashboard.totals.totalCostUSD += currentTask.estimatedCostUSD
    dashboard.totals.totalValueUSD += currentTask.estimatedValueUSD
    dashboard.totals.totalInputTokens += currentTask.inputTokens
    dashboard.totals.totalOutputTokens += currentTask.outputTokens
    dashboard.totals.totalToolCalls += currentTask.toolCalls
    dashboard.totals.totalTasks++
    dashboard.totals.totalTimeMs += duration

    // Daily stats
    const day = new Date().toISOString().split('T')[0]
    if (!dashboard.dailyStats[day]) {
        dashboard.dailyStats[day] = { cost: 0, value: 0, tasks: 0 }
    }
    dashboard.dailyStats[day].cost += currentTask.estimatedCostUSD
    dashboard.dailyStats[day].value += currentTask.estimatedValueUSD
    dashboard.dailyStats[day].tasks++

    save()

    const result = currentTask
    currentTask = null
    return result
}

// ============================================
// Dashboard
// ============================================

export function getROIDashboard(): string {
    load()

    const t = dashboard.totals
    if (t.totalTasks === 0) return '📊 Keine Tasks getrackt bisher.'

    const roi = t.totalCostUSD > 0
        ? ((t.totalValueUSD - t.totalCostUSD) / t.totalCostUSD * 100).toFixed(0)
        : '∞'

    const avgCost = (t.totalCostUSD / t.totalTasks).toFixed(4)
    const avgValue = (t.totalValueUSD / t.totalTasks).toFixed(2)

    // Recent daily stats
    const days = Object.entries(dashboard.dailyStats)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 7)

    const dailyLines = days.map(([day, stats]) => {
        const dayROI = stats.cost > 0 ? ((stats.value / stats.cost) * 100).toFixed(0) : '∞'
        return `${day}: $${stats.cost.toFixed(3)} cost → $${stats.value.toFixed(2)} value (${dayROI}% ROI, ${stats.tasks} tasks)`
    }).join('\n')

    return `📊 **Nova ROI Dashboard**

💰 **Gesamt:**
- Kosten: $${t.totalCostUSD.toFixed(4)} (${(t.totalInputTokens / 1000).toFixed(0)}K in / ${(t.totalOutputTokens / 1000).toFixed(0)}K out tokens)
- Geschätzter Wert: $${t.totalValueUSD.toFixed(2)}
- **ROI: ${roi}%** ${Number(roi) > 100 ? '🚀' : Number(roi) > 0 ? '✅' : '⚠️'}

📈 **Durchschnitt pro Task:**
- Kosten: $${avgCost} | Wert: $${avgValue}
- Tool-Calls: ${(t.totalToolCalls / t.totalTasks).toFixed(1)} avg

📅 **Letzte 7 Tage:**
${dailyLines || 'Keine Daten'}

Tasks total: ${t.totalTasks}`
}

/**
 * Detect task category from message content
 */
export function detectCategory(content: string): TaskCost['category'] {
    const lower = content.toLowerCase()
    if (lower.match(/\b(fix|bug|error|fehler|debug|crash)\b/)) return 'debug'
    if (lower.match(/\b(deploy|push|restart|server|ssh|docker)\b/)) return 'ops'
    if (lower.match(/\b(code|implement|function|class|component|api)\b/)) return 'code'
    if (lower.match(/\b(search|find|what|how|explain|research)\b/)) return 'research'
    if (lower.match(/\b(write|text|mail|brief|content|design)\b/)) return 'creative'
    if (lower.match(/\b(liste|status|check|update|clean)\b/)) return 'admin'
    return 'other'
}
