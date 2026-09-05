import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type RuntimeEvent = {
    event: string
    channel?: string
    userId?: string
    canonicalUserId?: string
    messageId?: string
    tool?: string
    success?: boolean
    durationMs?: number
    detail?: string
    [key: string]: unknown
}

const LOG_DIR = join(process.cwd(), '.nova-logs')

/** Append a machine-readable operational event without ever blocking the daemon. */
export function logRuntimeEvent(event: RuntimeEvent): void {
    try {
        if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
        const day = new Date().toISOString().slice(0, 10)
        appendFileSync(join(LOG_DIR, `runtime-${day}.jsonl`), JSON.stringify({
            timestamp: new Date().toISOString(),
            pid: process.pid,
            ...event,
        }) + '\n')
    } catch {
        // Diagnostics must never break message or tool execution.
    }
}
