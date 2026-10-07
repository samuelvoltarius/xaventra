import { describe, expect, it, vi } from 'vitest'
import { createDaemonMessageEntry } from './daemon-message-entry.js'
import { isCancellationOnlyExecution } from './message-pipeline.js'

// 2.88.2: the real daemon entry wraps a normal user message in a cancellation-only
// execution. The pipeline must recognise it as a user message (learning question,
// connect question, projects, read-only fast path) — otherwise those stages never run.

describe('daemon entry → pipeline: a normal message stays a user message', () => {
    it('the execution handed to the pipeline is cancellation-only', async () => {
        let seen: any = 'unset'
        const pipeline = vi.fn(async (...args: any[]) => { seen = args[7]; return 'ok' })
        const handle = createDaemonMessageEntry({ pipeline, getState: () => ({}), handleCommand: vi.fn(async () => null) })
        await handle('Telegram', '1001', 'Kannst du ein Fax senden?', async () => undefined)
        expect(seen).toBeDefined()
        expect(isCancellationOnlyExecution(seen)).toBe(true)
    })
    it('a mesh agent contract passed in stays a contract (Gegenprobe)', async () => {
        let seen: any
        const pipeline = vi.fn(async (...args: any[]) => { seen = args[7]; return 'ok' })
        const handle = createDaemonMessageEntry({ pipeline, getState: () => ({}), handleCommand: vi.fn(async () => null) })
        await handle('mesh', 'node-a', 'lies die Datei', async () => undefined, undefined, { allowedTools: ['read_file'], requestId: 'r1' })
        expect(isCancellationOnlyExecution(seen)).toBe(false)
    })
})
