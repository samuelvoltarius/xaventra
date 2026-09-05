import { describe, expect, it } from 'vitest'
import { ServiceRuntimeManager } from './service-runtime.js'

describe('isolated service model runtime', () => {
    it('tracks health and calls independently per service', async () => {
        let received: any
        const runtime = new ServiceRuntimeManager()
        runtime.register({ role: 'doctor', model: 'doctor.gguf', provider: 'local', timeoutMs: 100, dailyTokenBudget: 1000, localOnly: true }, {
            complete: async (input) => { received = input; return { content: 'ok' } },
        })
        await runtime.getClient('doctor')!.complete('check')
        expect(received).toEqual([{ role: 'user', content: 'check' }])
        expect(runtime.getStatus().doctor.health).toBe('healthy')
        expect(runtime.getStatus().doctor.calls).toBe(1)
        expect(runtime.getStatus().learning).toBeUndefined()
    })
})
