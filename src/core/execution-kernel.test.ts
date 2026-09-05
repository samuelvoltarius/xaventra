import { describe, expect, it } from 'vitest'
import { ExecutionKernel } from './execution-kernel.js'

describe('execution kernel', () => {
    it('enforces the outer allow-list and call budget before an effect can start', () => {
        const kernel = new ExecutionKernel('Lies beide Dateien a.txt und b.txt', { allowedChanges: { allowedTools: ['read_file'] }, budget: { maxToolCalls: 1 } })
        expect(kernel.selectWorkerTools().map(tool => tool.name)).toEqual(['read_file'])
        expect(() => kernel.assertCanExecute('write_file')).toThrow('outside task contract')
        expect(() => kernel.assertCanExecute('read_file')).not.toThrow()
        expect(() => kernel.assertCanExecute('read_file')).toThrow('budget exhausted')
    })
    it('fails closed after the deadline rather than validating a late effect afterwards', () => {
        const kernel = new ExecutionKernel('Lies die Datei a.txt', { allowedChanges: { allowedTools: ['read_file'] }, budget: { timeoutMs: 0 } })
        expect(() => kernel.assertCanExecute('read_file')).toThrow('deadline exceeded')
    })
    it('owns routing, verification and lifecycle as one contract', () => {
        const kernel = new ExecutionKernel('erstelle mir ein bild von salzburg')
        expect(kernel.selectWorkerTools().some(tool => tool.name === 'generate_image')).toBe(true)
        expect(kernel.verify('generate_image', { success: true, message: 'working' }).success).toBe(false)
        expect(kernel.lifecycle.isFulfilled()).toBe(false)
        expect(kernel.verify('generate_image', { success: true, path: 'C:\\tmp\\salzburg.png' }).success).toBe(true)
        expect(kernel.lifecycle.isFulfilled()).toBe(true)
    })

    it('keeps the current action authoritative over older routing context', () => {
        const current = 'Installiere Codex auf dem aktuellen Main'
        const context = `Wenn der Node ausfällt, wechselt das Mesh automatisch.
Prüfe den Hook und den Event-Trigger.
${current}`
        const kernel = new ExecutionKernel(current, undefined, context)
        expect(kernel.intent.kind).toBe('device-action')
        expect(kernel.selectWorkerTools().some(tool => tool.name === 'codex_install')).toBe(true)
    })

    it('binds adaptive cognitive budgets into the authoritative task contract', () => {
        const fast = new ExecutionKernel('Wie spät ist es?')
        const deep = new ExecutionKernel('Analysiere und vergleiche die komplette Architektur mit mehreren Alternativen.')
        expect(fast.cognition.cognitiveMode).toBe('fast')
        expect(fast.contract.budget.maxToolCalls).toBe(4)
        expect(deep.cognition.cognitiveMode).toBe('deep')
        expect(deep.contract.budget.maxTokens).toBeGreaterThan(fast.contract.budget.maxTokens || 0)
    })
})
