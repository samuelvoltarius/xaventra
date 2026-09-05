import { describe, expect, it, vi } from 'vitest'
import { NovaNativeBackend } from './nova-native-backend.js'
const run = vi.hoisted(() => vi.fn())
vi.mock('./nova-runner.js', () => ({ runNovaAgent: run }))
const input = { contract: { id: 'case' }, userId: 'user', channel: 'test', content: 'do it' } as any

describe('native backend completion authority', () => {
    it.each([
        [{ content: 'Done' }, 'failed'],
        [{ content: 'Done', validation: { success: false } }, 'failed'],
        [{ content: 'Waiting', validation: { success: false, awaitingApproval: true } }, 'interrupted'],
        [{ content: 'Verified', validation: { success: true } }, 'completed'],
    ])('reports the kernel result, never just the presence of prose', async (response, status) => {
        run.mockResolvedValue(response)
        expect((await new NovaNativeBackend().run(input)).status).toBe(status)
    })
})
