import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { authIndexPath, sameRuntimeEndpoint } from './codex-runtime.js'
import { getNovaDataDir } from '../core/data-root.js'

describe('Codex fallback endpoint identity', () => {
    it('treats OpenAI-compatible /v1 spellings as the same runtime', () => {
        expect(sameRuntimeEndpoint('http://100.64.0.10:8000', 'http://100.64.0.10:8000/v1')).toBe(true)
        expect(sameRuntimeEndpoint('HTTP://GPU-MAIN:8000/v1/', 'http://gpu-main:8000')).toBe(true)
        expect(sameRuntimeEndpoint('http://gpu-main:8000', 'http://gpu-main:8001')).toBe(false)
    })

    it('stores only aggregate auth state below the canonical writable runtime root', () => {
        const previous = process.env.NOVA_RUNTIME_ROOT
        process.env.NOVA_RUNTIME_ROOT = join(process.cwd(), '.nova-test-runtime')
        try {
            expect(authIndexPath('nova/ns1')).toBe(getNovaDataDir('codex-auth-index', 'nova_ns1.json'))
        } finally {
            if (previous === undefined) delete process.env.NOVA_RUNTIME_ROOT
            else process.env.NOVA_RUNTIME_ROOT = previous
        }
    })
})
