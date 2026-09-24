import { expect, it } from 'vitest'
import { ExecutionKernel } from './execution-kernel.js'
import { incompleteToolResponse } from './tool-evidence-response.js'

it('keeps correlated empty search separate from completed research', () => {
    const kernel = new ExecutionKernel('Recherchiere Informationen über einen Fotografen')
    expect(kernel.intent.kind).toBe('web')
    // Empty search is a legitimate tool observation, not fulfilled research.
    expect(kernel.verify('web_search', { success: true, results: [] }, {
        callId: 'empty-search', arguments: { query: 'photographer' },
    }).success).toBe(true)
    const report = kernel.validateCompletion(incompleteToolResponse(['{"success":true,"results":[]}']), {
        completionStatus: 'incomplete',
    })
    expect(report.success).toBe(false)
    expect(report.violations).toContain('task synthesis incomplete')
})

it('does not infer incomplete status from quoted source wording', () => {
    const kernel = new ExecutionKernel('Erkläre den Ausdruck nicht abgeschlossen')
    expect(kernel.validateCompletion('Der Ausdruck bedeutet, dass etwas noch offen ist.').success).toBe(true)
})
