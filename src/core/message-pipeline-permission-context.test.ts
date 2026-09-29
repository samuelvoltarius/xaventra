import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Owner-only context producers (other branches) return nothing unless the
// caller passes the resolved role. These assertions pin that the pipeline
// passes it, so the owner keeps the context and nobody else gets it.
const pipelineSource = readFileSync(fileURLToPath(new URL('./message-pipeline.ts', import.meta.url)), 'utf8')

describe('pipeline passes the principal role to role-gated context', () => {
    it('observe() receives the permission (R2 UEB-18)', () => {
        expect(pipelineSource).toMatch(/\.observe\(principalId, content, 'user', `\$\{channel\}-\$\{Date\.now\(\)\}`, \{ permission: principalContext\.permission \}\)/)
    })

    it('getCapabilitiesPrompt() receives the permission (R2 UEB-19)', () => {
        expect(pipelineSource).toMatch(/\(getCapabilitiesPrompt as [^\n]*\)\(\{ permission: principalContext\.permission \}\)/)
    })

    it('getJournalContextForPrompt() receives the permission (R2 UEB-20)', () => {
        expect(pipelineSource).toContain('journal.getJournalContextForPrompt(content, { permission: principalContext.permission })')
    })

    it('insights and weekly summary receive the viewer role (R2 UEB-21)', () => {
        expect(pipelineSource).toContain('const viewer = { permission: principalContext.permission }')
        expect(pipelineSource).toMatch(/\.buildInsightPromptBlock\(viewer\)/)
        expect(pipelineSource).toMatch(/\.getConsolidationContext\(viewer\)/)
    })

    it('response cache lookup and store use the conversation history (R2 UEB-21)', () => {
        expect(pipelineSource).toContain('getCachedResponse(systemPrompt, cacheKeyMessages)')
        expect(pipelineSource).toContain('cacheResponse(systemPrompt, cacheKeyMessages, finalContent')
        expect(pipelineSource).not.toContain("const messages = [{ role: 'user', content }]")
    })
})
