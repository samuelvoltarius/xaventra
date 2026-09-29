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
})
