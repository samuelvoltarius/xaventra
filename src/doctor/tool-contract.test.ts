import { describe, expect, it } from 'vitest'
import { diagnoseToolContract } from './tool-contract.js'

describe('Doctor tool-contract invariant', () => {
    const registry = ['codex_install', 'find_capability']

    it('normalizes a provider-mangled name only within the worker contract', () => {
        expect(diagnoseToolContract('codexinstall', ['codex_install'], registry)).toMatchObject({
            state: 'healthy',
            canonicalTool: 'codex_install',
            recoverable: true,
        })
    })

    it('classifies a registered but evicted tool as a contract bug', () => {
        expect(diagnoseToolContract('codex_install', ['find_capability'], registry)).toMatchObject({
            state: 'missing-from-worker-contract',
            recoverable: false,
        })
    })

    it('rejects invented tools instead of treating them as missing software', () => {
        expect(diagnoseToolContract('prompt', ['codex_install'], registry)).toMatchObject({
            state: 'missing-from-registry',
            recoverable: false,
        })
    })
})
