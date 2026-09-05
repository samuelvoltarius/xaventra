export interface RequestGateStats {
    active: number
    queued: number
    rejected: number
    maxConcurrent: number
    maxQueue: number
}

type Pending<T> = { priority: number; run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

export class RequestGate {
    private active = 0
    private rejected = 0
    private queue: Pending<unknown>[] = []

    constructor(private readonly maxConcurrent = 4, private readonly maxQueue = 100) {}

    run<T>(task: () => Promise<T>, priority = 0): Promise<T> {
        if (this.active < this.maxConcurrent) return this.execute(task)
        if (this.queue.length >= this.maxQueue) {
            this.rejected++
            return Promise.reject(new Error('Nova is busy: request queue capacity reached'))
        }
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ priority, run: task, resolve, reject } as Pending<unknown>)
            this.queue.sort((a, b) => b.priority - a.priority)
        })
    }

    private async execute<T>(task: () => Promise<T>): Promise<T> {
        this.active++
        try { return await task() } finally {
            this.active--
            const next = this.queue.shift()
            if (next) this.execute(next.run).then(next.resolve, next.reject)
        }
    }

    getStats(): RequestGateStats {
        return { active: this.active, queued: this.queue.length, rejected: this.rejected, maxConcurrent: this.maxConcurrent, maxQueue: this.maxQueue }
    }
}

export const interactiveRequestGate = new RequestGate(
    Number(process.env.NOVA_MAX_CONCURRENT_REQUESTS || 4),
    Number(process.env.NOVA_MAX_REQUEST_QUEUE || 100),
)

