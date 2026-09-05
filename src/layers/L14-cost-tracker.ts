/**
 * L14 Cost Tracker - CFO Layer
 * 
 * Tracks API costs and optimizes model selection:
 * - Token counting per request
 * - Cost tracking per provider
 * - Auto-routing to cheaper models for simple tasks
 * - Budget alerts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { getDefaultModel } from '../core/model-defaults.js'
import { estimateUsageCost } from '../core/model-pricing.js'

// ============================================
// Types
// ============================================

export interface TokenUsage {
    inputTokens: number
    outputTokens: number
    totalTokens: number
}

export interface RequestCost {
    id: string
    timestamp: number
    provider: string
    model: string
    usage: TokenUsage
    cost: number  // In USD cents
    task: string
    complexity: 'simple' | 'medium' | 'complex'
}

export interface DailyStats {
    date: string
    totalRequests: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    totalCost: number
    byProvider: Record<string, { requests: number; tokens: number; cost: number }>
    byComplexity: Record<string, number>
}

export interface CostConfig {
    // Budget limits (in tokens)
    dailyTokenBudget: number
    monthlyTokenBudget: number
    alertThreshold: number  // 0-1, alert when this % of budget is used

    // Model routing
    simpleTaskModel: string
    complexTaskModel: string
}

// ============================================
// Cost Tracker
// ============================================

const STORAGE_DIR = '.nova-costs'

function localDateKey(date = new Date()): string {
    return date.toLocaleDateString('sv-SE')
}

export class CostTracker extends EventEmitter {
    private config: CostConfig
    private history: RequestCost[] = []
    private dailyStats: Map<string, DailyStats> = new Map()
    private storageDir: string

    constructor(config: Partial<CostConfig> = {}) {
        super()

        this.config = {
            dailyTokenBudget: config.dailyTokenBudget ?? 1_000_000,  // 1M tokens/day default
            monthlyTokenBudget: config.monthlyTokenBudget ?? 20_000_000, // 20M tokens/month
            alertThreshold: config.alertThreshold ?? 0.8,
            simpleTaskModel: config.simpleTaskModel || getDefaultModel(),
            complexTaskModel: config.complexTaskModel || getDefaultModel(),
        }

        this.storageDir = join(process.cwd(), STORAGE_DIR)
        if (!existsSync(this.storageDir)) {
            mkdirSync(this.storageDir, { recursive: true })
        }

        this.loadHistory()
        console.log(`[L14 CostTracker] Initialized (daily budget: ${(this.config.dailyTokenBudget / 1000).toFixed(0)}K tokens)`)
    }

    // ============================================
    // Cost Calculation
    // ============================================

    calculateCost(provider: string, model: string, usage: TokenUsage): number {
        // This legacy layer stores cents; the shared estimator returns USD.
        return estimateUsageCost({ provider, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }).totalUsd * 100
    }

    // ============================================
    // Tracking
    // ============================================

    track(params: {
        provider: string
        model: string
        usage: TokenUsage
        task: string
        complexity?: 'simple' | 'medium' | 'complex'
    }): RequestCost {
        const cost = this.calculateCost(params.provider, params.model, params.usage)

        const record: RequestCost = {
            id: `cost_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: Date.now(),
            provider: params.provider,
            model: params.model,
            usage: params.usage,
            cost,
            task: params.task,
            complexity: params.complexity || this.estimateComplexity(params.usage),
        }

        this.history.push(record)
        this.updateDailyStats(record)
        this.checkBudget()
        this.saveHistory()

        console.log(`[L14 CostTracker] ${params.model}: ${params.usage.totalTokens} tokens = $${(cost / 100).toFixed(4)}`)

        return record
    }

    private estimateComplexity(usage: TokenUsage): 'simple' | 'medium' | 'complex' {
        if (usage.totalTokens < 500) return 'simple'
        if (usage.totalTokens < 2000) return 'medium'
        return 'complex'
    }

    private updateDailyStats(record: RequestCost): void {
        const dateKey = localDateKey()

        let stats = this.dailyStats.get(dateKey)
        if (!stats) {
            stats = {
                date: dateKey,
                totalRequests: 0,
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                totalCost: 0,
                byProvider: {},
                byComplexity: { simple: 0, medium: 0, complex: 0 },
            }
            this.dailyStats.set(dateKey, stats)
        }

        stats.totalRequests++
        stats.totalTokens += record.usage.totalTokens
        stats.inputTokens += record.usage.inputTokens || 0
        stats.outputTokens += record.usage.outputTokens || 0
        stats.totalCost += record.cost

        if (!stats.byProvider[record.provider]) {
            stats.byProvider[record.provider] = { requests: 0, tokens: 0, cost: 0 }
        }
        stats.byProvider[record.provider].requests++
        stats.byProvider[record.provider].tokens += record.usage.totalTokens
        stats.byProvider[record.provider].cost += record.cost

        stats.byComplexity[record.complexity]++
    }

    // ============================================
    // Budget Management
    // ============================================

    private checkBudget(): void {
        const today = this.getTodayStats()
        const usedPercent = today.totalTokens / this.config.dailyTokenBudget

        if (usedPercent >= 1) {
            console.log(`[L14 CostTracker] 🚨 DAILY TOKEN BUDGET EXCEEDED!`)
            this.emit('budget_exceeded', { type: 'daily', used: today.totalTokens, limit: this.config.dailyTokenBudget })
        } else if (usedPercent >= this.config.alertThreshold) {
            console.log(`[L14 CostTracker] ⚠️ ${Math.round(usedPercent * 100)}% of daily token budget used`)
            this.emit('budget_warning', { type: 'daily', percent: usedPercent })
        }
    }

    isBudgetAvailable(): boolean {
        const today = this.getTodayStats()
        return today.totalTokens < this.config.dailyTokenBudget
    }

    getRemainingBudget(): { daily: number; monthly: number } {
        const today = this.getTodayStats()
        const month = this.getMonthStats()

        return {
            daily: Math.max(0, this.config.dailyTokenBudget - today.totalTokens),
            monthly: Math.max(0, this.config.monthlyTokenBudget - month.totalTokens),
        }
    }

    // ============================================
    // Model Routing
    // ============================================

    selectModel(taskComplexity: 'simple' | 'medium' | 'complex'): string {
        // If budget is tight, always use cheapest
        const remaining = this.getRemainingBudget()
        if (remaining.daily < 50) {  // Less than 50 cents
            console.log(`[L14 CostTracker] 💰 Low budget - using cheapest model`)
            return this.config.simpleTaskModel
        }

        // Route based on complexity
        switch (taskComplexity) {
            case 'simple':
                return this.config.simpleTaskModel
            case 'complex':
                return this.config.complexTaskModel
            default:
                return this.config.simpleTaskModel
        }
    }

    shouldUseLocalModel(): boolean {
        const remaining = this.getRemainingBudget()
        // If less than 20% token budget remaining, suggest local
        return remaining.daily < this.config.dailyTokenBudget * 0.2
    }

    // ============================================
    // Statistics
    // ============================================

    getTodayStats(): DailyStats {
        const dateKey = localDateKey()
        return this.dailyStats.get(dateKey) || {
            date: dateKey,
            totalRequests: 0,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            byProvider: {},
            byComplexity: { simple: 0, medium: 0, complex: 0 },
        }
    }

    getMonthStats(): { totalCost: number; totalTokens: number; totalRequests: number } {
        const now = new Date()
        const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

        let totalCost = 0
        let totalTokens = 0
        let totalRequests = 0

        for (const [date, stats] of this.dailyStats) {
            if (date.startsWith(monthPrefix)) {
                totalCost += stats.totalCost
                totalTokens += stats.totalTokens
                totalRequests += stats.totalRequests
            }
        }

        return { totalCost, totalTokens, totalRequests }
    }

    // ============================================
    // Storage
    // ============================================

    private loadHistory(): void {
        const historyPath = join(this.storageDir, 'history.json')
        const statsPath = join(this.storageDir, 'daily-stats.json')

        try {
            if (existsSync(historyPath)) {
                this.history = JSON.parse(readFileSync(historyPath, 'utf-8'))
            }
            if (existsSync(statsPath)) {
                const stats = JSON.parse(readFileSync(statsPath, 'utf-8'))
                this.dailyStats = new Map(Object.entries(stats))
            }
        } catch (err) {
            console.error(`[L14 CostTracker] Failed to load history: ${err}`)
        }
    }

    private saveHistory(): void {
        try {
            // Keep only last 1000 records
            if (this.history.length > 1000) {
                this.history = this.history.slice(-1000)
            }

            writeFileSync(
                join(this.storageDir, 'history.json'),
                JSON.stringify(this.history, null, 2)
            )
            writeFileSync(
                join(this.storageDir, 'daily-stats.json'),
                JSON.stringify(Object.fromEntries(this.dailyStats), null, 2)
            )
        } catch (err) {
            console.error(`[L14 CostTracker] Failed to save history: ${err}`)
        }
    }

    // ============================================
    // Formatting
    // ============================================

    formatStatus(): string {
        const today = this.getTodayStats()
        const month = this.getMonthStats()
        const remaining = this.getRemainingBudget()

        const dailyPercent = Math.round((today.totalTokens / this.config.dailyTokenBudget) * 100)
        const monthlyPercent = Math.round((month.totalTokens / this.config.monthlyTokenBudget) * 100)

        let msg = `📊 **Token Tracker Status**\n\n`

        msg += `**Heute:**\n`
        msg += `• Requests: ${today.totalRequests}\n`
        msg += `• Tokens: ${today.totalTokens.toLocaleString()} / ${(this.config.dailyTokenBudget / 1000).toFixed(0)}K (${dailyPercent}%)\n`
        msg += `• Verbleibend: ${(remaining.daily / 1000).toFixed(0)}K Tokens\n\n`

        msg += `**Monat:**\n`
        msg += `• Requests: ${month.totalRequests}\n`
        msg += `• Tokens: ${month.totalTokens.toLocaleString()} / ${(this.config.monthlyTokenBudget / 1_000_000).toFixed(0)}M (${monthlyPercent}%)\n`

        if (Object.keys(today.byProvider).length > 0) {
            msg += `\n**Nach Provider:**\n`
            for (const [provider, stats] of Object.entries(today.byProvider)) {
                msg += `• ${provider}: ${stats.requests} req, ${stats.tokens.toLocaleString()} tokens\n`
            }
        }

        if (this.shouldUseLocalModel()) {
            msg += `\n⚠️ Token-Budget niedrig — lokales Modell empfohlen!`
        }

        return msg
    }
}

// ============================================
// Singleton
// ============================================

let costTracker: CostTracker | null = null

export function getCostTracker(config?: Partial<CostConfig>): CostTracker {
    if (!costTracker) {
        costTracker = new CostTracker(config)
    }
    return costTracker
}

export default { CostTracker, getCostTracker }
