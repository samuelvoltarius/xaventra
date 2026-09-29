import { describe, expect, it, vi } from 'vitest'

const complete = vi.hoisted(() => vi.fn(async (): Promise<{ content: string }> => { throw new Error('model unreachable') }))
vi.mock('../llm/nova-llm-sdk.js', () => ({ createNovaLLMClient: async () => ({ complete }) }))
import { createFactory } from './factory.js'

describe('factory results (R2 A18)', () => {
    it('does not report a task as completed when the model is unreachable', async () => {
        const factory = createFactory({ enableAutoDecompose: false, taskTimeoutMs: 60_000 })
        const task = await factory.submitTask('Fixture-Aufgabe')
        await vi.waitFor(() => expect(['completed', 'failed']).toContain(task.status))
        expect(task.status).toBe('failed')
        expect(task.subtasks.some(st => st.status === 'completed')).toBe(false)
    })

    it('still completes with a real model answer', async () => {
        complete.mockResolvedValue({ content: 'echtes Ergebnis' })
        const factory = createFactory({ enableAutoDecompose: false, taskTimeoutMs: 60_000 })
        const task = await factory.submitTask('Fixture-Aufgabe')
        await vi.waitFor(() => expect(['completed', 'failed']).toContain(task.status))
        expect(task.status).toBe('completed')
        expect(task.result).toContain('echtes Ergebnis')
    })
})
