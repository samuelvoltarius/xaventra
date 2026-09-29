import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskQueue } from './tasks.js'

// R2 core-n-z #39 (dead code, kept): a parse error must not lead to the whole
// queue file being overwritten by the next save.

const dirs: string[] = []
afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('TaskQueue persistence (R2 NZ-39)', () => {
    it('keeps an unreadable queue file instead of overwriting it', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        const dir = mkdtempSync(join(tmpdir(), 'nova-tasks-'))
        dirs.push(dir)
        const broken = '{"a": {"id": "a", "description": "wichtig"'
        writeFileSync(join(dir, 'tasks.json'), broken)

        const queue = new TaskQueue(dir)
        queue.createTask({ description: 'neu' })

        const corrupt = readdirSync(dir).find(name => name.startsWith('tasks.json.corrupt-'))
        expect(corrupt).toBeTruthy()
        expect(readFileSync(join(dir, corrupt!), 'utf-8')).toBe(broken)
    })
})
