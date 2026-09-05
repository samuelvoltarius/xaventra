import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LspRuntime, TypeScriptLspProvider } from './lsp-runtime.js'

describe('LspRuntime', () => {
    it('returns normalized TypeScript symbols and blocks workspace escape', async () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-lsp-'))
        writeFileSync(join(root, 'demo.ts'), 'export function answer(): number { return 42 }\nanswer()\n')
        const runtime = new LspRuntime()
        runtime.register(new TypeScriptLspProvider())
        const symbols = await runtime.query(root, { operation: 'symbols', file: 'demo.ts', query: 'answer' })
        expect(symbols.locations?.some(item => item.text?.includes('answer'))).toBe(true)
        await expect(runtime.query(root, { operation: 'symbols', file: '../outside.ts' })).rejects.toThrow(/outside/)
        rmSync(root, { recursive: true, force: true })
    }, 15_000)
})
