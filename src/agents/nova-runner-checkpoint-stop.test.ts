import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// runNovaAgent cannot be driven without a full model stack, so this pins the
// source contract: an unreplicated fenced checkpoint must stop further tools.
const source = readFileSync(new URL('./nova-runner.ts', import.meta.url), 'utf8')

describe('nova-runner fenced checkpoint replication', () => {
    it('stops the mission step instead of only warning', () => {
        const branch = source.slice(source.indexOf('await publishNativeToolCheckpoint({'), source.indexOf('// Native provider reasoning'))
        expect(branch).toMatch(/if \(!replicated\) \{[\s\S]*checkpointUnreplicated = true[\s\S]*policyBlocked = true[\s\S]*\}/)
        expect(branch).not.toMatch(/if \(!replicated\) console\.warn/)
    })

    it('tells the user why the step stopped', () => {
        expect(source).toMatch(/if \(policyBlocked\) finalContent = checkpointUnreplicated\s*\? 'Missionsschritt gestoppt/)
    })
})
