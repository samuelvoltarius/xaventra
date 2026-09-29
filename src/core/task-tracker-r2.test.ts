import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// R2 core-n-z #37: with one global currentTask, request A finishing must not
// complete request B's task when A passes its own task id.

const dir = mkdtempSync(join(tmpdir(), 'nova-task-tracker-'))
vi.spyOn(process, 'cwd').mockReturnValue(dir)
vi.spyOn(console, 'log').mockImplementation(() => undefined)

afterAll(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
})

describe('task tracker ownership (R2 NZ-37)', () => {
    it('ignores completion and progress for a task id that is not current', async () => {
        const { startTask, completeTask, advanceStep, getTaskData } = await import('./task-tracker.js')
        const a = await startTask('Aufgabe A', 'telegram', 'owner')
        const b = await startTask('Aufgabe B', 'telegram', 'owner')
        expect(getTaskData().current?.id).toBe(b.id)

        advanceStep('read_file', true, a.id)
        completeTask(false, a.id)
        expect(getTaskData().current?.id).toBe(b.id)
        expect(getTaskData().current?.status).toBe('active')

        completeTask(false, b.id)
        expect(getTaskData().current).toBeNull()
    })
})
