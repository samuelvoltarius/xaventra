import { describe, expect, it } from 'vitest'
import { summarizeReachability } from './health-contract.js'

describe('unified reachability contract', () => {
    it('does not call a node offline when SSH fails but a service is up', () => {
        expect(summarizeReachability({
            host: 'unknown', ssh: 'down',
            services: [{ name: 'comfyui', endpoint: 'http://node:8188', state: 'up', checkedAt: 1 }],
        })).toBe('degraded')
    })

    it('requires negative host and service evidence for offline', () => {
        expect(summarizeReachability({ host: 'unknown', ssh: 'down', services: [] })).toBe('unknown')
        expect(summarizeReachability({
            host: 'down', ssh: 'down',
            services: [{ name: 'vllm', endpoint: 'http://node:8000', state: 'down', checkedAt: 1 }],
        })).toBe('offline')
    })
})
