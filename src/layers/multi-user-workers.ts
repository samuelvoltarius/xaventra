/**
 * Nova Multi-User Worker System
 * 
 * Spawns separate worker processes for heavy users.
 * Each worker is an isolated Nova instance with its own memory.
 * 
 * Features:
 * - Auto-spawn new worker when user load is high
 * - Load balancing across workers
 * - Worker health monitoring
 * - Graceful shutdown
 */

import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface UserWorker {
    id: string
    userId: string
    process: ChildProcess | null
    status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
    startedAt: number
    lastActivity: number
    messageCount: number
    pid?: number
    port?: number  // If worker runs its own mini-gateway
    error?: string
}

export interface WorkerMessage {
    type: 'request' | 'response' | 'status' | 'error' | 'shutdown'
    userId?: string
    data?: unknown
    requestId?: string
}

export interface UserWorkerConfig {
    maxWorkersPerUser: number
    maxTotalWorkers: number
    idleTimeoutMs: number  // Kill worker after inactivity
    workerScript: string   // Path to worker entry script
    dataDir: string
}

// ============================================
// Worker Pool Manager
// ============================================

export class WorkerPoolManager {
    private workers: Map<string, UserWorker> = new Map()
    private userToWorker: Map<string, string> = new Map()  // userId -> workerId
    private pendingRequests: Map<string, (result: unknown) => void> = new Map()
    private config: UserWorkerConfig
    private idleCheckInterval?: NodeJS.Timeout

    constructor(config: Partial<UserWorkerConfig> = {}) {
        this.config = {
            maxWorkersPerUser: config.maxWorkersPerUser || 1,
            maxTotalWorkers: config.maxTotalWorkers || 10,
            idleTimeoutMs: config.idleTimeoutMs || 5 * 60 * 1000, // 5 minutes
            workerScript: config.workerScript || join(process.cwd(), 'src', 'worker-entry.ts'),
            dataDir: config.dataDir || join(process.cwd(), '.nova-workers'),
        }

        // Create data directory
        if (!existsSync(this.config.dataDir)) {
            mkdirSync(this.config.dataDir, { recursive: true })
        }
    }

    // ============================================
    // Worker Lifecycle
    // ============================================

    async spawnWorkerForUser(userId: string): Promise<UserWorker> {
        // Check if user already has a worker
        const existingWorkerId = this.userToWorker.get(userId)
        if (existingWorkerId) {
            const existing = this.workers.get(existingWorkerId)
            if (existing && existing.status === 'running') {
                return existing
            }
        }

        // Check total workers limit
        const runningWorkers = this.getRunningWorkers()
        if (runningWorkers.length >= this.config.maxTotalWorkers) {
            // Find least active worker to reuse or throw error
            const leastActive = runningWorkers.sort((a, b) => a.lastActivity - b.lastActivity)[0]
            if (leastActive && Date.now() - leastActive.lastActivity > 60000) {
                // Reuse idle worker for new user
                await this.stopWorker(leastActive.id)
            } else {
                throw new Error(`Max workers limit reached (${this.config.maxTotalWorkers})`)
            }
        }

        // Create worker
        const worker: UserWorker = {
            id: crypto.randomUUID(),
            userId,
            process: null,
            status: 'starting',
            startedAt: Date.now(),
            lastActivity: Date.now(),
            messageCount: 0,
        }

        this.workers.set(worker.id, worker)
        this.userToWorker.set(userId, worker.id)

        try {
            // Create worker-specific config
            const workerConfigPath = join(this.config.dataDir, `worker-${worker.id}.json`)
            writeFileSync(workerConfigPath, JSON.stringify({
                workerId: worker.id,
                userId,
                dataDir: join(this.config.dataDir, worker.id),
            }))

            // Fork worker process
            const proc = fork(this.config.workerScript, [workerConfigPath], {
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                env: {
                    ...process.env,
                    NOVA_WORKER_ID: worker.id,
                    NOVA_USER_ID: userId,
                },
            })

            worker.process = proc
            worker.pid = proc.pid

            // Handle worker messages
            proc.on('message', (msg: WorkerMessage) => {
                this.handleWorkerMessage(worker.id, msg)
            })

            proc.on('exit', (code) => {
                console.log(`[Worker ${worker.id}] Beendet mit Code ${code}`)
                worker.status = 'stopped'
                worker.process = null
            })

            proc.on('error', (err) => {
                console.error(`[Worker ${worker.id}] Fehler:`, err)
                worker.status = 'error'
                worker.error = err.message
            })

            // Wait for worker ready
            await this.waitForWorkerReady(worker.id, 10000)
            worker.status = 'running'
            console.log(`[WorkerPool] Worker für User ${userId} gestartet (PID: ${proc.pid})`)

            return worker

        } catch (err) {
            worker.status = 'error'
            worker.error = err instanceof Error ? err.message : String(err)
            throw err
        }
    }

    private async waitForWorkerReady(workerId: string, timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const worker = this.workers.get(workerId)
            if (!worker?.process) {
                reject(new Error('Worker process not found'))
                return
            }

            const timeout = setTimeout(() => {
                reject(new Error('Worker startup timeout'))
            }, timeoutMs)

            const onMessage = (msg: WorkerMessage) => {
                if (msg.type === 'status' && msg.data === 'ready') {
                    clearTimeout(timeout)
                    worker.process?.off('message', onMessage)
                    resolve()
                }
            }

            worker.process.on('message', onMessage)
        })
    }

    async stopWorker(workerId: string): Promise<void> {
        const worker = this.workers.get(workerId)
        if (!worker) return

        worker.status = 'stopping'

        if (worker.process) {
            // Send shutdown message
            worker.process.send({ type: 'shutdown' })

            // Wait for graceful shutdown
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    worker.process?.kill('SIGKILL')
                    resolve()
                }, 5000)

                worker.process?.on('exit', () => {
                    clearTimeout(timeout)
                    resolve()
                })
            })
        }

        this.userToWorker.delete(worker.userId)
        this.workers.delete(workerId)
        console.log(`[WorkerPool] Worker ${workerId} gestoppt`)
    }

    async stopAllWorkers(): Promise<void> {
        const workers = Array.from(this.workers.keys())
        await Promise.all(workers.map(id => this.stopWorker(id)))
    }

    // ============================================
    // Message Handling
    // ============================================

    async sendToWorker(userId: string, data: unknown): Promise<unknown> {
        let worker = this.getWorkerForUser(userId)

        if (!worker || worker.status !== 'running') {
            // Auto-spawn worker for user
            worker = await this.spawnWorkerForUser(userId)
        }

        if (!worker.process) {
            throw new Error('Worker process not available')
        }

        const requestId = crypto.randomUUID()

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId)
                reject(new Error('Worker request timeout'))
            }, 60000)

            this.pendingRequests.set(requestId, (result) => {
                clearTimeout(timeout)
                this.pendingRequests.delete(requestId)
                resolve(result)
            })

            worker!.process!.send({
                type: 'request',
                requestId,
                userId,
                data,
            })

            worker!.lastActivity = Date.now()
            worker!.messageCount++
        })
    }

    private handleWorkerMessage(workerId: string, msg: WorkerMessage): void {
        if (msg.type === 'response' && msg.requestId) {
            const resolver = this.pendingRequests.get(msg.requestId)
            if (resolver) {
                resolver(msg.data)
            }
        } else if (msg.type === 'error' && msg.requestId) {
            const resolver = this.pendingRequests.get(msg.requestId)
            if (resolver) {
                resolver({ error: msg.data })
            }
        }
    }

    // ============================================
    // Queries
    // ============================================

    getWorkerForUser(userId: string): UserWorker | undefined {
        const workerId = this.userToWorker.get(userId)
        return workerId ? this.workers.get(workerId) : undefined
    }

    getRunningWorkers(): UserWorker[] {
        return Array.from(this.workers.values())
            .filter(w => w.status === 'running')
    }

    getAllWorkers(): UserWorker[] {
        return Array.from(this.workers.values())
    }

    // ============================================
    // Idle Worker Cleanup
    // ============================================

    startIdleCheck(): void {
        if (this.idleCheckInterval) return

        this.idleCheckInterval = setInterval(() => {
            const now = Date.now()
            for (const worker of this.workers.values()) {
                if (worker.status === 'running' &&
                    now - worker.lastActivity > this.config.idleTimeoutMs) {
                    console.log(`[WorkerPool] Worker ${worker.id} idle timeout, stopping...`)
                    this.stopWorker(worker.id).catch(console.error)
                }
            }
        }, 60000) // Check every minute
    }

    stopIdleCheck(): void {
        if (this.idleCheckInterval) {
            clearInterval(this.idleCheckInterval)
            this.idleCheckInterval = undefined
        }
    }

    // ============================================
    // Stats
    // ============================================

    getStats() {
        const all = this.getAllWorkers()
        const running = this.getRunningWorkers()

        return {
            totalWorkers: all.length,
            runningWorkers: running.length,
            activeUsers: new Set(all.map(w => w.userId)).size,
            totalMessages: all.reduce((sum, w) => sum + w.messageCount, 0),
            config: {
                maxTotalWorkers: this.config.maxTotalWorkers,
                idleTimeoutMs: this.config.idleTimeoutMs,
            },
        }
    }
}

// ============================================
// Worker Entry Point (separate file needed)
// ============================================

export const WORKER_ENTRY_CODE = `
/**
 * Nova Worker Entry Point
 * This runs as a separate process for each user.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'

// Read worker config
const configPath = process.argv[2]
const config = JSON.parse(readFileSync(configPath, 'utf-8'))

console.log(\`[Worker \${config.workerId}] Starting for user \${config.userId}\`)

// Initialize Nova for this user
async function initWorker() {
    // Import Nova components
    const { getVectorMemory } = await import('./memory/vector-memory.js')
    const { getToolRegistry } = await import('./tools/complete-registry.js')
    
    // User-specific memory
    const memory = getVectorMemory({
        dataDir: join(config.dataDir, 'memory'),
    })
    await memory.initialize()
    
    // Tools
    const tools = getToolRegistry()
    
    // Signal ready
    process.send?.({ type: 'status', data: 'ready' })
    
    // Handle messages
    process.on('message', async (msg) => {
        if (msg.type === 'shutdown') {
            console.log(\`[Worker \${config.workerId}] Shutting down...\`)
            process.exit(0)
        }
        
        if (msg.type === 'request') {
            try {
                // Process request
                const result = await processMessage(msg.data)
                process.send?.({ type: 'response', requestId: msg.requestId, data: result })
            } catch (err) {
                process.send?.({ type: 'error', requestId: msg.requestId, data: err.message })
            }
        }
    })
}

async function processMessage(data) {
    // This is where you'd integrate with Nova's agent runner
    return { processed: true, data }
}

initWorker().catch(err => {
    console.error('[Worker] Init failed:', err)
    process.exit(1)
})
`

// ============================================
// Global Instance
// ============================================

let workerPool: WorkerPoolManager | null = null

export function getWorkerPool(config?: Partial<UserWorkerConfig>): WorkerPoolManager {
    if (!workerPool) {
        workerPool = new WorkerPoolManager(config)
        workerPool.startIdleCheck()
    }
    return workerPool
}

// ============================================
// Shutdown Handler
// ============================================

export async function shutdownWorkerPool(): Promise<void> {
    if (workerPool) {
        workerPool.stopIdleCheck()
        await workerPool.stopAllWorkers()
        workerPool = null
    }
}

export default {
    WorkerPoolManager,
    getWorkerPool,
    shutdownWorkerPool,
    WORKER_ENTRY_CODE,
}
