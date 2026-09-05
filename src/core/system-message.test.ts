import { describe, expect, it } from 'vitest'
import { ExecutionKernel } from './execution-kernel.js'
import { internalTaskContractOverrides, isNovaSystemAuthored } from './system-message.js'

describe('Nova system-authored messages', () => {
    it('recognizes every internal autonomy and mission prefix', () => {
        for (const prefix of ['[SELF-THINK]', '[SELF-GOAL]', '[SELF-DOCTOR]', '[REMINDER]', '[HEARTBEAT]', '[MISSION']) {
            expect(isNovaSystemAuthored({ content: `${prefix} diagnostic` })).toBe(true)
        }
        expect(isNovaSystemAuthored({ from: 'Nova-Autonomy', content: 'plain internal prompt' })).toBe(true)
        expect(isNovaSystemAuthored({ from: '1000000001', content: 'prüfe bitte den Server' })).toBe(false)
    })

    it('requires a response but no executing tool for internal diagnostics', () => {
        const overrides = internalTaskContractOverrides()
        expect(overrides.successCriteria?.[0]).toMatchObject({ kind: 'response_present', required: true })
        expect(overrides.allowedChanges).toMatchObject({ readOnly: true, externalSideEffects: false })

        const kernel = new ExecutionKernel(
            '[SELF-THINK] Prüfe den Status und empfehle gegebenenfalls einen Neustart.',
            overrides,
        )
        expect(kernel.intent.requiresTool).toBe(true)
        expect(kernel.validateCompletion('Diagnose abgeschlossen; keine Änderung ausgeführt.').success).toBe(true)
    })
})
