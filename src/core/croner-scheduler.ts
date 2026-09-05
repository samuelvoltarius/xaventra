/**
 * Nova - Croner Scheduler
 * 
 * Cron-based task scheduling using croner.
 * Features: Timezone support, next run calculation, pause/resume.
 */

// ============================================
// Types
// ============================================

export interface CronJob {
    id: string
    pattern: string
    name: string
    handler: () => Promise<void> | void
    timezone?: string
    enabled: boolean
    lastRun?: Date
    nextRun?: Date
    runCount: number
}

export interface CronerSchedulerConfig {
    timezone?: string
    maxConcurrent?: number
}

// ============================================
// Croner Scheduler
// ============================================

export class CronerScheduler {
    private config: Required<CronerSchedulerConfig>
    private jobs = new Map<string, { job: CronJob; instance: unknown }>()
    private running = 0

    constructor(config: CronerSchedulerConfig = {}) {
        this.config = {
            timezone: config.timezone ?? 'Europe/Vienna',
            maxConcurrent: config.maxConcurrent ?? 5,
        }
    }

    /**
     * Schedule a new cron job
     */
    async schedule(
        id: string,
        pattern: string,
        name: string,
        handler: () => Promise<void> | void
    ): Promise<CronJob> {
        // Remove existing job with same ID
        if (this.jobs.has(id)) {
            await this.cancel(id)
        }

        try {
            const { Cron } = await import('croner')

            const job: CronJob = {
                id,
                pattern,
                name,
                handler,
                timezone: this.config.timezone,
                enabled: true,
                runCount: 0,
            }

            const cronInstance = new Cron(pattern, {
                timezone: this.config.timezone,
                paused: false,
            }, async () => {
                // Check concurrent limit
                if (this.running >= this.config.maxConcurrent) {
                    console.log(`[Scheduler] Skipping ${name}: max concurrent reached`)
                    return
                }

                this.running++
                job.lastRun = new Date()
                job.runCount++

                try {
                    console.log(`[Scheduler] Running: ${name}`)
                    await handler()
                    console.log(`[Scheduler] Completed: ${name}`)
                } catch (err) {
                    console.error(`[Scheduler] Error in ${name}:`, err)
                } finally {
                    this.running--
                    job.nextRun = cronInstance.nextRun() ?? undefined
                }
            })

            job.nextRun = cronInstance.nextRun() ?? undefined
            this.jobs.set(id, { job, instance: cronInstance })

            console.log(`[Scheduler] Scheduled: ${name} (${pattern}) - Next: ${job.nextRun?.toISOString()}`)
            return job
        } catch (err) {
            console.error(`[Scheduler] Failed to schedule ${name}:`, err)
            throw err
        }
    }

    /**
     * Schedule with interval (simpler API)
     */
    async scheduleInterval(
        id: string,
        name: string,
        intervalMs: number,
        handler: () => Promise<void> | void
    ): Promise<CronJob> {
        // Convert ms to cron pattern (approximate)
        let pattern: string

        if (intervalMs < 60000) {
            // Less than a minute - every N seconds
            const seconds = Math.max(1, Math.floor(intervalMs / 1000))
            pattern = `*/${seconds} * * * * *`
        } else if (intervalMs < 3600000) {
            // Less than an hour - every N minutes
            const minutes = Math.floor(intervalMs / 60000)
            pattern = `*/${minutes} * * * *`
        } else if (intervalMs < 86400000) {
            // Less than a day - every N hours
            const hours = Math.floor(intervalMs / 3600000)
            pattern = `0 */${hours} * * *`
        } else {
            // Days
            const days = Math.floor(intervalMs / 86400000)
            pattern = `0 0 */${days} * *`
        }

        return this.schedule(id, pattern, name, handler)
    }

    /**
     * Cancel a job
     */
    async cancel(id: string): Promise<boolean> {
        const entry = this.jobs.get(id)
        if (!entry) return false

        try {
            const cronInstance = entry.instance as { stop: () => void }
            cronInstance.stop()
            this.jobs.delete(id)
            console.log(`[Scheduler] Cancelled: ${entry.job.name}`)
            return true
        } catch {
            return false
        }
    }

    /**
     * Pause a job
     */
    pause(id: string): boolean {
        const entry = this.jobs.get(id)
        if (!entry) return false

        const cronInstance = entry.instance as { pause: () => void }
        cronInstance.pause()
        entry.job.enabled = false
        console.log(`[Scheduler] Paused: ${entry.job.name}`)
        return true
    }

    /**
     * Resume a job
     */
    resume(id: string): boolean {
        const entry = this.jobs.get(id)
        if (!entry) return false

        const cronInstance = entry.instance as { resume: () => void }
        cronInstance.resume()
        entry.job.enabled = true
        console.log(`[Scheduler] Resumed: ${entry.job.name}`)
        return true
    }

    /**
     * Get next run time for a job
     */
    getNextRun(id: string): Date | null {
        const entry = this.jobs.get(id)
        if (!entry) return null

        const cronInstance = entry.instance as { nextRun: () => Date | null }
        return cronInstance.nextRun()
    }

    /**
     * List all jobs
     */
    listJobs(): CronJob[] {
        return Array.from(this.jobs.values()).map(e => ({
            ...e.job,
            nextRun: this.getNextRun(e.job.id) ?? undefined,
        }))
    }

    /**
     * Get a specific job
     */
    getJob(id: string): CronJob | null {
        const entry = this.jobs.get(id)
        return entry ? {
            ...entry.job,
            nextRun: this.getNextRun(id) ?? undefined,
        } : null
    }

    /**
     * Stop all jobs
     */
    async stopAll(): Promise<void> {
        for (const [id] of this.jobs) {
            await this.cancel(id)
        }
        console.log('[Scheduler] All jobs stopped')
    }

    /**
     * Get scheduler stats
     */
    getStats(): { total: number; running: number; enabled: number } {
        const jobs = this.listJobs()
        return {
            total: jobs.length,
            running: this.running,
            enabled: jobs.filter(j => j.enabled).length,
        }
    }
}

// ============================================
// Singleton
// ============================================

let schedulerInstance: CronerScheduler | null = null

export function getCronerScheduler(): CronerScheduler {
    if (!schedulerInstance) {
        schedulerInstance = new CronerScheduler()
    }
    return schedulerInstance
}

export default { CronerScheduler, getCronerScheduler }
