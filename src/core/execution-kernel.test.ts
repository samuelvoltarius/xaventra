import { describe, expect, it } from 'vitest'
import { ExecutionKernel } from './execution-kernel.js'

describe('execution kernel', () => {
    it('answers an announcement without inheriting installation tools or requiring a tool receipt', () => {
        const text = 'Du wirst nun ent docker und native installiert dann hast du die Full power'
        const kernel = new ExecutionKernel(text, undefined, `Installiere Codex auf Spark.\n${text}`)
        expect(kernel.intent.requiresTool).toBe(false)
        expect(kernel.selectWorkerTools()).toEqual([])
        expect(() => kernel.assertCanExecute('run_command')).toThrow('outside task contract')
        expect(kernel.validateCompletion('Oh cool! Du stellst mich auf nativen Betrieb um?').success).toBe(true)
    })
    it('retains a complete diagnostic contract during a JSON-only candidate follow-up', () => {
        const contract = new ExecutionKernel('System health prüfen').contract
        contract.allowedChanges = { readOnly: true, externalSideEffects: false, allowedPaths: [], allowedTools: ['health_status'] }
        const kernel = new ExecutionKernel('Return ONLY JSON with description, search, replace, reason.', contract)
        expect(kernel.selectWorkerTools().map(t => t.name)).toEqual(['health_status'])
        expect(() => kernel.assertCanExecute('run_command')).toThrow('outside task contract')
    })
    it('keeps an explicitly empty complete contract planning-only', () => {
        const contract = new ExecutionKernel('System health prüfen').contract
        contract.allowedChanges.allowedTools = []
        expect(new ExecutionKernel('System health prüfen', contract).selectWorkerTools()).toEqual([])
    })
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
        expect(kernel.verify('generate_image', { success: true, message: 'working' }, { callId: 'image-1', arguments: { prompt: 'salzburg' } }).success).toBe(false)
        expect(kernel.lifecycle.isFulfilled()).toBe(false)
        expect(kernel.verify('generate_image', { success: true, path: 'C:\\tmp\\salzburg.png' }, { callId: 'image-2', arguments: { prompt: 'salzburg' } }).success).toBe(true)
        expect(kernel.lifecycle.isFulfilled()).toBe(true)
    })

    it('requires uniquely correlated evidence for every explicit file target', () => {
        const kernel = new ExecutionKernel('Lies beide Dateien a.txt und b.txt', {
            allowedChanges: { allowedTools: ['read_file', 'health_status'] },
        })
        expect(kernel.contract.requiredToolTargets).toEqual(['a.txt', 'b.txt'])
        expect(kernel.verify('health_status', { success: true, output: 'healthy' }, { callId: 'health-1', arguments: {} }).success).toBe(true)
        expect(kernel.validateCompletion('healthy').success).toBe(false)
        expect(kernel.verify('read_file', { success: true, content: 'A' }, { callId: 'read-a', arguments: { path: '/tmp/a.txt' } }).success).toBe(true)
        expect(kernel.validateCompletion('A').success).toBe(false)
        expect(kernel.verify('read_file', { success: true, content: 'B' }, { callId: 'read-a', arguments: { path: '/tmp/b.txt' } })).toMatchObject({ success: false, reason: 'duplicate tool call evidence id' })
        expect(kernel.verify('read_file', { success: true, content: 'B' }, { callId: 'read-b', arguments: { path: '/tmp/b.txt' } }).success).toBe(true)
        expect(kernel.validateCompletion('A B').success).toBe(true)
    })

    it('does not promote an uncorrelated successful result into completion evidence', () => {
        const kernel = new ExecutionKernel('Lies die Datei probe.txt', { allowedChanges: { allowedTools: ['read_file'] } })
        expect(kernel.verify('read_file', { success: true, content: 'value' })).toMatchObject({ success: false, reason: 'tool result lacks execution correlation' })
        expect(kernel.validateCompletion('value').success).toBe(false)
    })

    it('accepts a recovered target only when verified discovery proves the resolved path', () => {
        const kernel = new ExecutionKernel('Lies die Datei docs/RELESE_PLAN.md', {
            allowedChanges: { allowedTools: ['read_file', 'find_files'] },
        })
        expect(kernel.contract.requiredToolTargets).toEqual(['docs/relese_plan.md'])
        const discovery = { results: [{ path: '/workspace/docs/RELEASE_PLAN.md', type: 'file' }] }
        expect(kernel.registerResolvedTarget({
            requested: 'docs/RELESE_PLAN.md', resolved: '/workspace/docs/RELEASE_PLAN.md',
            discoveryCallId: 'find-1', discoveryResult: discovery,
        })).toBe(false)
        expect(kernel.verify('find_files', discovery, { callId: 'find-1', arguments: { path: '/workspace', pattern: '*.md' } }).success).toBe(true)
        expect(kernel.registerResolvedTarget({
            requested: 'docs/RELESE_PLAN.md', resolved: '/workspace/docs/RELEASE_PLAN.md',
            discoveryCallId: 'find-1', discoveryResult: { results: [{ path: '/workspace/docs/OTHER.md' }] },
        })).toBe(false)
        expect(kernel.registerResolvedTarget({
            requested: 'docs/RELESE_PLAN.md', resolved: '/workspace/docs/RELEASE_PLAN.md',
            discoveryCallId: 'find-1', discoveryResult: discovery,
        })).toBe(true)
        expect(kernel.verify('read_file', { content: 'unrelated' }, {
            callId: 'read-unrelated', arguments: { path: '/workspace/docs/OTHER.md', note: '/workspace/docs/RELEASE_PLAN.md' },
        }).success).toBe(true)
        expect(kernel.validateCompletion('unrelated').success).toBe(false)
        expect(kernel.verify('read_file', { content: 'release plan' }, {
            callId: 'read-recovered', arguments: { path: '/workspace/docs/RELEASE_PLAN.md' },
        }).success).toBe(true)
        expect(kernel.validateCompletion('release plan').success).toBe(true)
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
        expect(deep.contract.budget.maxOutputTokens).toBeGreaterThan(fast.contract.budget.maxOutputTokens || 0)
    })
})
