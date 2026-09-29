import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mayUseCodex, runWithLlmPrincipal, setLlmPrincipalPermission } from './llm-principal.js'
import { CodexCLIAdapter } from './codex-cli-adapter.js'

// Decided 30.09. (L7): Codex is the owner's subscription and runs only for the owner.
describe('Codex only for the owner', () => {
    it('allows internal work outside a message scope', () => {
        expect(mayUseCodex()).toBe(true)
    })

    it('denies while the role is undecided and for non-owners, allows the owner', async () => {
        await runWithLlmPrincipal(async () => {
            expect(mayUseCodex()).toBe(false)
            setLlmPrincipalPermission('guest')
            expect(mayUseCodex()).toBe(false)
            setLlmPrincipalPermission('admin')
            expect(mayUseCodex()).toBe(false)
            setLlmPrincipalPermission('owner')
            expect(mayUseCodex()).toBe(true)
        })
    })

    it('the adapter refuses before spawning anything for a guest', async () => {
        await runWithLlmPrincipal(async () => {
            setLlmPrincipalPermission('guest')
            const adapter = new CodexCLIAdapter('gpt-test')
            await expect(adapter.complete('hi')).rejects.toThrow(/nur dem Owner/)
            await expect(adapter.stream('hi').next()).rejects.toThrow(/nur dem Owner/)
        })
    })

    it('scopes are per message and do not leak', async () => {
        await Promise.all([
            runWithLlmPrincipal(async () => { setLlmPrincipalPermission('owner'); await new Promise(r => setTimeout(r, 5)); expect(mayUseCodex()).toBe(true) }),
            runWithLlmPrincipal(async () => { setLlmPrincipalPermission('guest'); await new Promise(r => setTimeout(r, 5)); expect(mayUseCodex()).toBe(false) }),
        ])
    })

    it('the pipeline opens a scope per message and records the decided role', () => {
        const pipeline = readFileSync(new URL('../core/message-pipeline.ts', import.meta.url), 'utf8')
        expect(pipeline).toMatch(/return runWithLlmPrincipal\(\(\) => handleMessageInScope\(\.\.\.args\)\)/)
        expect(pipeline).toMatch(/principalContext\.permission = authResult\.permission\s*\n\s*;\(await import\('\.\.\/llm\/llm-principal\.js'\)\)\.setLlmPrincipalPermission\(authResult\.permission\)/)
    })
})
