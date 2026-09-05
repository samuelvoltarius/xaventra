/**
 * Nova - Cron/Scheduler System
 * 
 * Schedule tasks to run at specific times or intervals.
 */

// ============================================
// Types
// ============================================

export interface CronJob {
    id: string
    name: string
    schedule: string          // Cron expression or interval
    handler: () => Promise<void>
    enabled: boolean
    lastRun?: number
    nextRun?: number
    runCount: number
    errors: number
}

export interface SchedulerConfig {
    tickIntervalMs: number    // How often to check for due jobs
    maxConcurrent: number     // Max concurrent jobs
    timezone?: string
}

// ============================================
// Cron Parser (Simple)
// ============================================

function parseInterval(schedule: string): number | null {
    // Support simple intervals: "5m", "1h", "30s", "1d"
    const match = schedule.match(/^(\d+)(s|m|h|d)$/)
    if (!match) return null

    const value = parseInt(match[1], 10)
    const unit = match[2]

    switch (unit) {
        case 's': return value * 1000
        case 'm': return value * 60 * 1000
        case 'h': return value * 60 * 60 * 1000
        case 'd': return value * 24 * 60 * 60 * 1000
        default: return null
    }
}

function getNextRun(schedule: string, lastRun?: number): number {
    const interval = parseInterval(schedule)
    if (interval) {
        return (lastRun || Date.now()) + interval
    }

    // For cron expressions, just use 1 minute as default
    // A full cron parser would be complex
    return Date.now() + 60000
}

// ============================================
// Scheduler
// ============================================

export class Scheduler {
    private jobs: Map<string, CronJob> = new Map()
    private config: SchedulerConfig
    private timer: NodeJS.Timeout | null = null
    private running: Set<string> = new Set()

    constructor(config: Partial<SchedulerConfig> = {}) {
        this.config = {
            tickIntervalMs: 1000,
            maxConcurrent: 5,
            ...config,
        }
    }

    // ============================================
    // Job Management
    // ============================================

    schedule(
        id: string,
        name: string,
        schedule: string,
        handler: () => Promise<void>
    ): CronJob {
        const job: CronJob = {
            id,
            name,
            schedule,
            handler,
            enabled: true,
            nextRun: getNextRun(schedule),
            runCount: 0,
            errors: 0,
        }

        this.jobs.set(id, job)
        console.log(`[Scheduler] Added job: ${name} (${schedule})`)

        return job
    }

    unschedule(id: string): boolean {
        return this.jobs.delete(id)
    }

    enable(id: string): void {
        const job = this.jobs.get(id)
        if (job) {
            job.enabled = true
            job.nextRun = getNextRun(job.schedule)
        }
    }

    disable(id: string): void {
        const job = this.jobs.get(id)
        if (job) job.enabled = false
    }

    getJob(id: string): CronJob | undefined {
        return this.jobs.get(id)
    }

    getAllJobs(): CronJob[] {
        return Array.from(this.jobs.values())
    }

    // ============================================
    // Execution
    // ============================================

    start(): void {
        if (this.timer) return

        console.log('[Scheduler] Started')
        this.timer = setInterval(() => this.tick(), this.config.tickIntervalMs)
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
            console.log('[Scheduler] Stopped')
        }
    }

    private async tick(): Promise<void> {
        const now = Date.now()

        for (const job of this.jobs.values()) {
            // Skip if disabled or already running
            if (!job.enabled) continue
            if (this.running.has(job.id)) continue
            if (this.running.size >= this.config.maxConcurrent) break

            // Check if due
            if (job.nextRun && now >= job.nextRun) {
                this.runJob(job)
            }
        }
    }

    private async runJob(job: CronJob): Promise<void> {
        this.running.add(job.id)

        try {
            console.log(`[Scheduler] Running: ${job.name}`)
            await job.handler()

            job.runCount++
            job.lastRun = Date.now()
            job.nextRun = getNextRun(job.schedule, job.lastRun)

        } catch (err) {
            job.errors++
            console.error(`[Scheduler] Job ${job.name} failed:`, err)

            // Still schedule next run
            job.lastRun = Date.now()
            job.nextRun = getNextRun(job.schedule, job.lastRun)

        } finally {
            this.running.delete(job.id)
        }
    }

    // ============================================
    // Manual Trigger
    // ============================================

    async trigger(id: string): Promise<void> {
        const job = this.jobs.get(id)
        if (!job) throw new Error(`Job not found: ${id}`)

        await this.runJob(job)
    }

    // ============================================
    // Status
    // ============================================

    getStatus(): {
        running: boolean
        jobCount: number
        activeJobs: number
        upcomingJobs: Array<{ id: string; name: string; nextRun: number }>
    } {
        return {
            running: this.timer !== null,
            jobCount: this.jobs.size,
            activeJobs: this.running.size,
            upcomingJobs: Array.from(this.jobs.values())
                .filter(j => j.enabled && j.nextRun)
                .sort((a, b) => (a.nextRun || 0) - (b.nextRun || 0))
                .slice(0, 10)
                .map(j => ({ id: j.id, name: j.name, nextRun: j.nextRun! })),
        }
    }
}

// ============================================
// Global Instance
// ============================================

let schedulerInstance: Scheduler | null = null

export function getScheduler(): Scheduler {
    if (!schedulerInstance) {
        schedulerInstance = new Scheduler()
    }
    return schedulerInstance
}

export function createScheduler(config?: Partial<SchedulerConfig>): Scheduler {
    return new Scheduler(config)
}

export default { Scheduler, getScheduler, createScheduler }
