/**
 * Nova Scheduler
 * 
 * Handles scheduled/automated tasks using node-cron.
 * Spawns sub-agents for each scheduled job to avoid blocking.
 */

import { schedule, ScheduledTask } from 'node-cron'
import { fork, ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { getPatternStore, Pattern } from '../learning/pattern-store.js'

// ============================================
// Types
// ============================================

export interface ScheduledJob {
    id: string
    pattern: Pattern
    cronExpression: string
    task: ScheduledTask
    lastRun?: number
    nextRun?: number
}

export interface SubAgentTask {
    id: string
    type: 'scheduled' | 'background'
    action: string
    userId: string
    channel: string
    startedAt: number
    process?: ChildProcess
}

// ============================================
// Nova Scheduler
// ============================================

export class NovaScheduler {
    private jobs: Map<string, ScheduledJob> = new Map()
    private runningTasks: Map<string, SubAgentTask> = new Map()
    private sendMessage: ((userId: string, channel: string, content: string) => Promise<void>) | null = null

    constructor() {
        console.log('[NovaScheduler] Initialized')
    }

    /**
     * Set the message sender function (for sending results to users)
     */
    setMessageSender(fn: (userId: string, channel: string, content: string) => Promise<void>): void {
        this.sendMessage = fn
    }

    /**
     * Load and start all automated patterns from store
     */
    async loadFromPatternStore(): Promise<number> {
        const store = getPatternStore()
        const patterns = store.getAutomatedPatterns()

        for (const pattern of patterns) {
            if (pattern.cronExpression) {
                this.schedulePattern(pattern)
            }
        }

        console.log(`[NovaScheduler] Loaded ${this.jobs.size} scheduled jobs`)
        return this.jobs.size
    }

    /**
     * Schedule a pattern for automatic execution
     */
    schedulePattern(pattern: Pattern): boolean {
        if (!pattern.cronExpression) {
            console.log(`[NovaScheduler] Pattern ${pattern.id} has no cron expression`)
            return false
        }

        // Avoid duplicates
        if (this.jobs.has(pattern.id)) {
            console.log(`[NovaScheduler] Job ${pattern.id} already scheduled`)
            return false
        }

        try {
            const task = schedule(pattern.cronExpression, () => {
                this.executePattern(pattern)
            })

            this.jobs.set(pattern.id, {
                id: pattern.id,
                pattern,
                cronExpression: pattern.cronExpression,
                task,
            })

            console.log(`[NovaScheduler] ✅ Scheduled: ${pattern.action} with "${pattern.cronExpression}"`)
            return true
        } catch (err) {
            console.error(`[NovaScheduler] Failed to schedule ${pattern.id}: ${err}`)
            return false
        }
    }

    /**
     * Execute a scheduled pattern (spawns sub-agent)
     */
    private async executePattern(pattern: Pattern): Promise<void> {
        console.log(`[NovaScheduler] 🚀 Executing: ${pattern.action} for ${pattern.userId}`)

        const taskId = `${pattern.id}-${Date.now()}`
        const subTask: SubAgentTask = {
            id: taskId,
            type: 'scheduled',
            action: pattern.action,
            userId: pattern.userId,
            channel: pattern.channel,
            startedAt: Date.now(),
        }

        this.runningTasks.set(taskId, subTask)

        // Execute action based on type
        let result: string
        try {
            result = await this.executeAction(pattern.action)
        } catch (err) {
            result = `❌ Fehler bei ${pattern.action}: ${err}`
        }

        // Send result to user
        if (this.sendMessage) {
            try {
                await this.sendMessage(pattern.userId, pattern.channel, `🤖 **Automatische Nachricht**\n\n${result}`)
            } catch (err) {
                console.error(`[NovaScheduler] Failed to send message: ${err}`)
            }
        }

        // Update job stats
        const job = this.jobs.get(pattern.id)
        if (job) {
            job.lastRun = Date.now()
        }

        this.runningTasks.delete(taskId)
    }

    /**
     * Execute a specific action type
     */
    private async executeAction(action: string): Promise<string> {
        switch (action) {
            case 'news':
                return this.fetchNews()
            case 'weather':
                return this.fetchWeather()
            case 'summary':
                return '📋 Hier ist deine tägliche Zusammenfassung...'
            case 'reminder':
                return '⏰ Erinnerung!'
            default:
                return `Aktion "${action}" ausgeführt.`
        }
    }

    /**
     * Fetch news using NewsAPI.org
     */
    private async fetchNews(): Promise<string> {
        const apiKey = process.env.NEWSAPI_KEY
        const country = process.env.NEWS_COUNTRY || 'de'

        if (!apiKey) {
            return `📰 **Nachrichten:**\n\n_Kein API-Key konfiguriert (NEWSAPI_KEY)_`
        }

        try {
            const url = `https://newsapi.org/v2/top-headlines?country=${country}&pageSize=5&apiKey=${apiKey}`
            const response = await fetch(url)

            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`)
            }

            const data = await response.json() as any

            if (!data.articles || data.articles.length === 0) {
                return `📰 **Nachrichten:**\n\n_Keine aktuellen Nachrichten gefunden._`
            }

            const headlines = data.articles
                .slice(0, 5)
                .map((a: any, i: number) => `${i + 1}. **${a.title}**\n   _${a.source?.name || 'Unbekannt'}_`)
                .join('\n\n')

            return `📰 **Top Nachrichten:**

${headlines}

_Abgerufen um ${new Date().toLocaleTimeString('de-DE')}_`
        } catch (err) {
            console.error('[NovaScheduler] News API error:', err)
            return `📰 **Nachrichten:**\n\n_Fehler beim Abrufen: ${err}_`
        }
    }

    /**
     * Fetch weather using OpenWeatherMap API
     */
    private async fetchWeather(): Promise<string> {
        const apiKey = process.env.OPENWEATHER_API_KEY
        const city = process.env.WEATHER_CITY || 'Berlin'

        if (!apiKey) {
            return `🌤️ **Wetter für ${city}:**\n\n_Kein API-Key konfiguriert (OPENWEATHER_API_KEY)_`
        }

        try {
            const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric&lang=de`
            const response = await fetch(url)

            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`)
            }

            const data = await response.json() as any
            const temp = Math.round(data.main.temp)
            const feelsLike = Math.round(data.main.feels_like)
            const description = data.weather[0]?.description || 'unbekannt'
            const humidity = data.main.humidity
            const wind = Math.round(data.wind.speed * 3.6) // m/s to km/h

            return `🌤️ **Wetter in ${city}:**

• Temperatur: ${temp}°C (gefühlt ${feelsLike}°C)
• Zustand: ${description}
• Luftfeuchtigkeit: ${humidity}%
• Wind: ${wind} km/h

_Abgerufen um ${new Date().toLocaleTimeString('de-DE')}_`
        } catch (err) {
            console.error('[NovaScheduler] Weather API error:', err)
            return `🌤️ **Wetter:**\n\n_Fehler beim Abrufen: ${err}_`
        }
    }

    /**
     * Convert time hint to cron expression
     */
    static timeToCron(timeHint: string): string {
        const [hour, minute] = timeHint.split(':').map(n => parseInt(n, 10))
        // Cron format: minute hour * * * (every day at that time)
        return `${minute} ${hour} * * *`
    }

    /**
     * List all scheduled jobs
     */
    listJobs(): Array<{ id: string; action: string; cron: string; lastRun?: number }> {
        return Array.from(this.jobs.values()).map(job => ({
            id: job.id,
            action: job.pattern.action,
            cron: job.cronExpression,
            lastRun: job.lastRun,
        }))
    }

    /**
     * Cancel a scheduled job
     */
    cancelJob(patternId: string): boolean {
        const job = this.jobs.get(patternId)
        if (!job) return false

        job.task.stop()
        this.jobs.delete(patternId)
        console.log(`[NovaScheduler] Cancelled job: ${patternId}`)
        return true
    }

    /**
     * Stop all jobs
     */
    shutdown(): void {
        for (const job of this.jobs.values()) {
            job.task.stop()
        }
        this.jobs.clear()
        console.log('[NovaScheduler] Shutdown complete')
    }
}

// ============================================
// Singleton
// ============================================

let instance: NovaScheduler | null = null

export function getScheduler(): NovaScheduler {
    if (!instance) {
        instance = new NovaScheduler()
    }
    return instance
}

export default { NovaScheduler, getScheduler }
