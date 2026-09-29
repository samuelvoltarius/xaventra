import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getTraceRecorder } from './trace.js'

// Runs inside the vitest runtime root (test/vitest.setup.ts chdir), never the real .nova-data.
const TRACE_DIR = join(process.cwd(), '.nova-data', 'traces')

describe('R2 L12: traces keep no message text and expire', () => {
    it('does not persist the user message and prunes old day files', () => {
        mkdirSync(TRACE_DIR, { recursive: true })
        const oldFile = join(TRACE_DIR, '2020-01-01.jsonl')
        writeFileSync(oldFile, '{"userMessage":"alter Inhalt"}\n')

        const recorder = getTraceRecorder()
        const id = recorder.start({
            sessionId: 's', userId: 'guest-1', channel: 'telegram',
            userMessage: 'Meine Kontonummer ist geheim', hasImage: false, modelUsed: 'qwen', provider: 'local',
        })
        recorder.finish(id, { success: true, responseContent: 'ok' })

        const today = join(TRACE_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`)
        const written = readFileSync(today, 'utf-8')
        expect(written).not.toContain('Kontonummer')
        const last = JSON.parse(written.trim().split('\n').pop()!)
        expect(last.messageLength).toBe('Meine Kontonummer ist geheim'.length)
        expect(existsSync(oldFile)).toBe(false)
    })
})
